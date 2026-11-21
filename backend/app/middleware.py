"""Cross-cutting HTTP behaviour that wraps every request.

Middleware runs *around* the route handlers, like layers of an onion. The
order they're added in ``main.py`` matters; from the outside in:

1. ``RequestContextMiddleware`` - assigns the request ID, times the request,
   writes one access-log line, adds security headers. Outermost, so even a
   rate-limited (429) response gets an ID, headers and a log line.
2. ``RateLimitMiddleware``      - rejects clients sending too much, *before*
   any search work is done.
3. CORS (Starlette's own)       - browser cross-origin rules.
4. The route handler itself.

Everything here is plain Starlette, so it's independent of the search logic
and can be unit-tested on its own.
"""

from __future__ import annotations

import logging
import math
import re
import threading
import time
import uuid
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp

from .errors import error_body
from .observability import request_id_var

access_log = logging.getLogger("app.access")
log = logging.getLogger(__name__)

# A caller-supplied request ID is only trusted if it looks like an ID:
# 1-128 safe characters. Anything else (empty, huge, or containing newlines
# that could forge extra log lines) is replaced with a fresh UUID.
_SAFE_REQUEST_ID = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")

# Headers that harden responses at no cost for a JSON API:
#  * nosniff      - browsers must not guess a different content type.
#  * DENY         - the API may never be framed (clickjacking).
#  * no-referrer  - don't leak URLs (which carry search terms) to other sites.
#  * default-src 'none' - a JSON response should never load or run anything.
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
}

# Swagger UI loads its own scripts and styles, so the strict CSP above would
# blank it. These paths get every header except the CSP.
_DOCS_PATHS = ("/docs", "/redoc", "/openapi.json")


class RequestContextMiddleware(BaseHTTPMiddleware):
    """Request ID, timing, access log, security headers and the last-resort
    500 handler, for every request.

    Unexpected exceptions are caught *here* rather than by a FastAPI
    exception handler because a handler for ``Exception`` runs outside all
    middleware: by then the request ID is gone from the logging context and
    the response would miss its ``X-Request-ID`` and security headers.
    """

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        # Step 1: pick the request ID - reuse the caller's (so one ID can be
        # traced across services) when it's safe, otherwise mint a new one.
        incoming = request.headers.get("x-request-id", "")
        request_id = incoming if _SAFE_REQUEST_ID.match(incoming) else uuid.uuid4().hex
        token = request_id_var.set(request_id)  # visible to all logging below
        request.state.request_id = request_id  # visible to exception handlers

        # Step 2: run the rest of the stack and time it. perf_counter is a
        # monotonic clock, so it's immune to wall-clock adjustments.
        start = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            # Last line of defence. Log the full traceback (tagged with the
            # request ID) but never send internals to the client: just a
            # generic message and the ID to quote in a bug report.
            log.exception("Unhandled error on %s %s", request.method, request.url.path)
            response = JSONResponse(
                status_code=500,
                content=error_body("INTERNAL_ERROR", "Something went wrong on our side.", requestId=request_id),
            )
        duration_ms = round((time.perf_counter() - start) * 1000, 2)
        try:
            # Step 3: decorate the response.
            response.headers["X-Request-ID"] = request_id
            response.headers["Server-Timing"] = f"app;dur={duration_ms}"
            for name, value in SECURITY_HEADERS.items():
                if name == "Content-Security-Policy" and request.url.path.startswith(_DOCS_PATHS):
                    continue
                response.headers.setdefault(name, value)

            # Unversioned /api/... paths are a deprecated alias of /api/v1/...
            # Tell clients so, and where the successor lives (RFC 8594 / RFC 9745).
            path = request.url.path
            if path.startswith("/api/") and not path.startswith("/api/v1/"):
                response.headers["Deprecation"] = "true"
                response.headers["Link"] = f'</api/v1{path[len("/api") :]}>; rel="successor-version"'

            # Step 4: one structured access-log line per request. The query
            # string is logged because it *is* the search; it holds no secrets.
            access_log.info(
                "%s %s -> %s in %sms",
                request.method,
                request.url.path,
                response.status_code,
                duration_ms,
                extra={
                    "method": request.method,
                    "path": request.url.path,
                    "query": request.url.query,
                    "status": response.status_code,
                    "duration_ms": duration_ms,
                    "client": request.client.host if request.client else None,
                },
            )
            return response
        finally:
            # Step 5: restore the previous context value so the ID can't leak
            # into whatever this worker handles next.
            request_id_var.reset(token)


# ---------------------------------------------------------------------------
# Rate limiting
# ---------------------------------------------------------------------------


@dataclass
class _Bucket:
    """One client's token bucket: how many tokens it holds and when it was last topped up."""

    tokens: float
    updated: float


class TokenBucketLimiter:
    """The token-bucket algorithm, per client key.

    Picture a bucket holding up to ``capacity`` tokens that refills at
    ``rate`` tokens per second. Each request takes one token; with none left,
    the request is refused until the bucket refills. This allows short bursts
    (up to ``capacity``) while capping the long-run rate at ``rate``.

    The clock is injectable so tests can move time forward instantly.

    Example::

        >>> now = [0.0]
        >>> limiter = TokenBucketLimiter(rate=1, capacity=2, clock=lambda: now[0])
        >>> [limiter.acquire("ip").allowed for _ in range(3)]
        [True, True, False]
        >>> now[0] = 1.0  # one second later, one token has refilled
        >>> limiter.acquire("ip").allowed
        True

    Note: state lives in this process's memory. Behind several replicas each
    would count separately; a shared store (e.g. Redis) is the production
    upgrade, and only this class would change.
    """

    def __init__(
        self,
        rate: float,
        capacity: int,
        *,
        clock: Callable[[], float] = time.monotonic,
        max_clients: int = 10_000,
    ):
        self.rate = rate
        self.capacity = capacity
        self._clock = clock
        # OrderedDict as a small LRU: the least recently seen clients are
        # evicted once there are more than max_clients, so memory is bounded
        # even if many different IPs hit the service.
        self._buckets: OrderedDict[str, _Bucket] = OrderedDict()
        self._max_clients = max_clients
        self._lock = threading.Lock()  # sync routes run in a thread pool

    def acquire(self, key: str) -> RateDecision:
        """Try to take one token for ``key``; report whether it was allowed."""
        with self._lock:
            now = self._clock()
            bucket = self._buckets.pop(key, None) or _Bucket(tokens=self.capacity, updated=now)

            # Refill for the time elapsed since this client's last request,
            # never above capacity.
            elapsed = max(0.0, now - bucket.updated)
            bucket.tokens = min(self.capacity, bucket.tokens + elapsed * self.rate)
            bucket.updated = now

            allowed = bucket.tokens >= 1
            if allowed:
                bucket.tokens -= 1

            # Re-insert at the end (most recent), then evict the oldest if over the cap.
            self._buckets[key] = bucket
            while len(self._buckets) > self._max_clients:
                self._buckets.popitem(last=False)

            # When refused: seconds until one whole token is back.
            retry_after = 0 if allowed else math.ceil((1 - bucket.tokens) / self.rate)
            return RateDecision(allowed, remaining=int(bucket.tokens), retry_after=retry_after)


@dataclass(frozen=True)
class RateDecision:
    """The outcome of one ``acquire`` call."""

    allowed: bool
    remaining: int  # whole tokens left after this request
    retry_after: int  # seconds to wait before retrying (0 when allowed)


# Health probes come from orchestrators (Kubernetes, load balancers) every
# few seconds; throttling them would make a healthy service look dead.
_RATE_LIMIT_EXEMPT = ("/api/health", "/api/v1/health")


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Refuse clients that exceed the limit with a 429 in the API's error shape."""

    def __init__(self, app: ASGIApp, limiter: TokenBucketLimiter):
        super().__init__(app)
        self.limiter = limiter

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        if request.url.path.startswith(_RATE_LIMIT_EXEMPT):
            return await call_next(request)

        # Keyed by client IP. Behind a reverse proxy, run uvicorn with
        # --proxy-headers so this is the real client, not the proxy.
        key = request.client.host if request.client else "unknown"
        decision = self.limiter.acquire(key)
        limit_headers = {
            "RateLimit-Limit": str(self.limiter.capacity),
            "RateLimit-Remaining": str(decision.remaining),
        }

        if not decision.allowed:
            return JSONResponse(
                status_code=429,
                headers={**limit_headers, "Retry-After": str(decision.retry_after)},
                content=error_body("RATE_LIMITED", f"Too many requests. Try again in {decision.retry_after}s."),
            )

        response = await call_next(request)
        response.headers.update(limit_headers)
        return response
