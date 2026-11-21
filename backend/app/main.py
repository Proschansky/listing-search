"""HTTP layer. Deliberately thin: parse the query, call ``search``, serialise.

All real logic lives in plain Python modules (validation, dedupe, scoring,
search), which keeps it easy to unit-test without starting a server. This
file only wires those modules to HTTP and adds the operational features a
production service needs:

* **Versioned routes** - everything lives under ``/api/v1``. The original
  unversioned ``/api/...`` paths still work (the frontend and existing
  clients use them) but answer with ``Deprecation`` and ``Link`` headers
  pointing at the v1 path. A breaking change would ship as ``/api/v2``
  alongside v1, never by changing v1 in place.
* **Health probes** - ``/health/live`` (is the process up?) and
  ``/health/ready`` (can it serve searches?), the split Kubernetes and most
  load balancers expect.
* **One error shape** for every failure - validation (400), unknown listing
  or route (404), rate limit (429) and unexpected crashes (500) all return
  ``{"error": {"code", "message", "details"}}`` (see ``errors.py``).
* **Request IDs, structured logs, rate limiting, security headers** - see
  ``middleware.py`` and ``observability.py``.
* **Settings from the environment** - see ``config.py``.

Run:  uvicorn app.main:app --reload --port 8000
"""

from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import APIRouter, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .config import Settings, get_settings
from .errors import error_body
from .middleware import RateLimitMiddleware, RequestContextMiddleware, TokenBucketLimiter
from .models import SORT_OPTIONS, VALID_STATUSES, ScoredListing
from .observability import configure_logging
from .repository import ListingRepository
from .scoring import score_listing
from .search import search
from .validation import (
    KNOWN_PARAMS,
    MAX_PAGE_SIZE,
    FieldError,
    InvalidSearchParams,
    parse_search_params,
)

API_VERSION = "1.1.0"

# ---------------------------------------------------------------------------
# OpenAPI documentation for the search parameters.
#
# /listings reads the raw query string itself (see the handler for why), so
# FastAPI can't infer its parameters. They're described here instead, which
# puts them in /openapi.json and the interactive docs at /docs. The contract
# test (tests/test_contract.py) keeps this list in sync with KNOWN_PARAMS.
# ---------------------------------------------------------------------------


def _param(name: str, schema: dict[str, Any], description: str) -> dict[str, Any]:
    """One optional query parameter in OpenAPI form."""
    return {"name": name, "in": "query", "required": False, "schema": schema, "description": description}


SEARCH_PARAMETERS = [
    _param("minPrice", {"type": "number", "minimum": 0}, "Minimum price, inclusive."),
    _param("maxPrice", {"type": "number", "minimum": 0}, "Maximum price, inclusive. Must be ≥ minPrice."),
    _param("minBedrooms", {"type": "integer", "minimum": 0}, "At least this many bedrooms."),
    _param("city", {"type": "string", "maxLength": 200}, "Exact city, ignoring case and extra spaces."),
    _param("keyword", {"type": "string", "maxLength": 200}, "Comma-separated whole-word terms; all must match."),
    _param("targetBudget", {"type": "number", "exclusiveMinimum": 0}, "Ranks listings by how close their price is."),
    _param("status", {"type": "string", "example": "active,pending"}, "Comma-separated statuses. Default: active."),
    _param("sort", {"type": "string", "enum": list(SORT_OPTIONS)}, "Result order. Default: relevance."),
    _param("page", {"type": "integer", "minimum": 1}, "Page number, from 1."),
    _param("pageSize", {"type": "integer", "minimum": 1, "maximum": MAX_PAGE_SIZE}, "Results per page. Default 10."),
    _param("asOf", {"type": "string", "format": "date"}, "Reference date for recency. Default: today."),
]

# Parameters the detail endpoint accepts (they only affect the score).
DETAIL_PARAMS = frozenset({"targetBudget", "asOf"})

# Shared response documentation for the error envelope.
_ERROR_RESPONSES: dict[int | str, dict[str, Any]] = {
    400: {"description": "Invalid parameters. `details` lists every bad field."},
    429: {"description": "Rate limited. See the `Retry-After` header."},
    500: {"description": "Unexpected error. Quote `requestId` when reporting it."},
}


def create_app(repository: ListingRepository | None = None, settings: Settings | None = None) -> FastAPI:
    """Build the FastAPI app.

    An app *factory* (rather than one global app) lets tests pass in their
    own repository and settings, so they never depend on files or
    environment variables.
    """
    settings = settings or get_settings()
    configure_logging(settings.log_level, settings.log_format)

    # Step 1: get the data. Tests inject a repository; otherwise load the
    # configured file. load_safely never raises: a broken file gives an
    # empty repository that /health/ready reports as not ready.
    repo = repository or ListingRepository.load_safely(settings.listings_path)

    app = FastAPI(
        title="Listing Search Service",
        version=API_VERSION,
        description="Search, deduplicate and rank MLS listings. All endpoints are read-only.",
        # Interactive docs are a development convenience; hidden in production.
        docs_url="/docs" if settings.docs_enabled else None,
        redoc_url="/redoc" if settings.docs_enabled else None,
        openapi_url="/openapi.json" if settings.docs_enabled else None,
    )
    app.state.repository = repo
    app.state.settings = settings

    # Step 2: middleware. Starlette runs the *last added* outermost, so this
    # reads bottom-up: RequestContext wraps RateLimit wraps CORS wraps routes.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET"],  # read-only API
        allow_headers=["*"],
        expose_headers=["X-Request-ID", "Retry-After", "RateLimit-Limit", "RateLimit-Remaining"],
    )
    if settings.rate_limit_enabled:
        limiter = TokenBucketLimiter(rate=settings.rate_limit_per_minute / 60, capacity=settings.rate_limit_burst)
        app.add_middleware(RateLimitMiddleware, limiter=limiter)
    app.add_middleware(RequestContextMiddleware)

    # Step 3: exception handlers - every failure becomes the same envelope.

    @app.exception_handler(InvalidSearchParams)
    async def _invalid_params(_: Request, exc: InvalidSearchParams) -> JSONResponse:
        # The frontend relies on `details` to highlight each bad input.
        return JSONResponse(
            status_code=400,
            content=error_body(
                "INVALID_PARAMETERS",
                "One or more search parameters are invalid.",
                [e.to_dict() for e in exc.errors],
            ),
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        # Unknown routes (404), wrong methods (405) and explicit
        # HTTPExceptions, in our shape instead of FastAPI's {"detail": ...}.
        code = {404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED"}.get(exc.status_code, "HTTP_ERROR")
        return JSONResponse(
            status_code=exc.status_code,
            content=error_body(code, str(exc.detail)),
            headers=getattr(exc, "headers", None),
        )

    # Step 4: routes. Defined once on a router, mounted under /api/v1 and
    # (deprecated) under /api.
    router = APIRouter()

    @router.get("/health/live", tags=["health"], summary="Liveness probe")
    def live() -> dict:
        """The process is up and answering HTTP. Says nothing about data."""
        return {"status": "ok"}

    @router.get(
        "/health/ready",
        tags=["health"],
        summary="Readiness probe",
        responses={503: {"description": "Data failed to load; see `checks`."}},
    )
    def ready() -> JSONResponse:
        """Can this instance serve searches? 200 if yes, 503 if not.

        A load balancer stops routing traffic to an instance that answers 503
        here, without restarting it (that's what liveness is for).
        """
        body = {
            "status": "ok" if repo.ready else "unavailable",
            "version": API_VERSION,
            "environment": settings.environment,
            "checks": {
                "data": {
                    "ok": repo.ready,
                    "listings": len(repo.merged),
                    "rawRecords": len(repo.raw),
                    "skippedRecords": repo.skipped,
                    "error": repo.load_error,
                }
            },
        }
        return JSONResponse(status_code=200 if repo.ready else 503, content=body)

    @router.get("/health", tags=["health"], summary="Summary health check")
    def health() -> dict:
        """Backwards-compatible summary. Also shows the dedupe effect (12 raw -> 8 merged)."""
        return {"status": "ok" if repo.ready else "degraded", "listings": len(repo.merged), "rawRecords": len(repo.raw)}

    @router.get("/meta", tags=["search"], summary="Reference data for building a search UI")
    def meta() -> dict:
        """Lets the UI build its city picker, status and sort options from real data."""
        return {
            "cities": repo.cities(),
            "statuses": sorted(VALID_STATUSES),
            "sortOptions": list(SORT_OPTIONS),
            "maxPageSize": MAX_PAGE_SIZE,
            "parameters": list(KNOWN_PARAMS),
        }

    @router.get(
        "/listings",
        tags=["search"],
        summary="Search listings",
        openapi_extra={"parameters": SEARCH_PARAMETERS},
        responses=_ERROR_RESPONSES,
    )
    def listings(request: Request) -> dict:
        """Filter, rank and paginate the deduplicated listings."""
        # Read the raw multi-dict ourselves (rather than typed FastAPI params)
        # so validation lives in one testable place and every error comes back
        # in one consistent 400 shape instead of FastAPI's default 422.
        # getlist() keeps *every* value for a name, so validation can reject
        # repeated parameters like ?page=1&page=2.
        raw = {key: request.query_params.getlist(key) for key in request.query_params}

        # Validate (raises InvalidSearchParams -> handled above as a 400),
        # run the search over the pre-merged listings, and return JSON.
        params = parse_search_params(raw)
        return search(repo.merged, params).to_dict()

    @router.get(
        "/listings/{listing_key}",
        tags=["search"],
        summary="One listing by key",
        openapi_extra={"parameters": [p for p in SEARCH_PARAMETERS if p["name"] in DETAIL_PARAMS]},
        responses={**_ERROR_RESPONSES, 404: {"description": "No listing has this key."}},
    )
    def listing_detail(listing_key: str, request: Request) -> dict:
        """A single listing in the same shape as a search result.

        Accepts ``targetBudget`` and ``asOf`` so the score matches what the
        search that linked here showed. Any other parameter is a 400.
        """
        raw = {key: request.query_params.getlist(key) for key in request.query_params}
        unexpected = sorted(set(raw) - DETAIL_PARAMS)
        if unexpected:
            raise InvalidSearchParams(
                [FieldError(name, "not supported here. Supported: asOf, targetBudget") for name in unexpected]
            )
        params = parse_search_params(raw)

        found = repo.get(listing_key)
        if found is None:
            raise StarletteHTTPException(status_code=404, detail=f"No listing with key '{listing_key}'.")

        score, breakdown = score_listing(found, params.target_budget, params.as_of or date.today())
        return ScoredListing(listing=found, score=score, breakdown=breakdown).to_dict()

    app.include_router(router, prefix="/api/v1")

    # The unversioned paths: the same handlers, hidden from the docs.
    # RequestContextMiddleware adds the Deprecation/Link headers to them.
    legacy = APIRouter(include_in_schema=False)
    for route in router.routes:
        legacy.add_api_route(route.path, route.endpoint, methods=list(route.methods))  # type: ignore[attr-defined]
    app.include_router(legacy, prefix="/api")

    return app


# Module-level app instance that uvicorn imports ("app.main:app").
app = create_app()
