"""Middleware: request IDs, security headers, the 500 safety net and rate limiting."""

from __future__ import annotations

import logging

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.middleware import TokenBucketLimiter


def _app(sample_repo, **settings):
    """An app over the sample data with the given settings overrides."""
    return create_app(sample_repo, Settings(**{"rate_limit_enabled": False, **settings}))


# --- Request IDs -------------------------------------------------------------


def test_every_response_gets_a_request_id(client):
    res = client.get("/api/v1/meta")
    assert len(res.headers["X-Request-ID"]) == 32  # uuid4().hex


def test_a_safe_incoming_request_id_is_reused(client):
    res = client.get("/api/v1/meta", headers={"X-Request-ID": "trace-123.abc"})
    assert res.headers["X-Request-ID"] == "trace-123.abc"


@pytest.mark.parametrize("bad", ["", "has space", "x" * 129, "line\nbreak"])
def test_an_unsafe_request_id_is_replaced(client, bad):
    # httpx refuses to send a raw newline, so that case is sent percent-encoded;
    # either way it isn't a safe ID and must be replaced.
    res = client.get("/api/v1/meta", headers={"X-Request-ID": bad.replace("\n", "%0A")})
    assert res.headers["X-Request-ID"] != bad
    assert len(res.headers["X-Request-ID"]) == 32


def test_access_log_line_carries_request_id_and_fields(client, caplog):
    with caplog.at_level(logging.INFO, logger="app.access"):
        client.get("/api/v1/listings", params={"city": "Springfield"}, headers={"X-Request-ID": "req-1"})
    record = next(r for r in caplog.records if r.name == "app.access")
    assert record.request_id == "req-1"
    assert record.status == 200
    assert record.path == "/api/v1/listings"
    assert record.query == "city=Springfield"
    assert record.duration_ms >= 0


# --- Headers -------------------------------------------------------------------


def test_security_and_timing_headers(client):
    res = client.get("/api/v1/listings")
    assert res.headers["X-Content-Type-Options"] == "nosniff"
    assert res.headers["X-Frame-Options"] == "DENY"
    assert res.headers["Referrer-Policy"] == "no-referrer"
    assert res.headers["Content-Security-Policy"].startswith("default-src 'none'")
    assert res.headers["Server-Timing"].startswith("app;dur=")


def test_docs_pages_skip_the_strict_csp_so_swagger_can_load(client):
    res = client.get("/docs")
    assert res.status_code == 200
    assert "Content-Security-Policy" not in res.headers
    assert res.headers["X-Content-Type-Options"] == "nosniff"


def test_legacy_paths_are_flagged_deprecated_with_their_successor(client):
    res = client.get("/api/listings")
    assert res.headers["Deprecation"] == "true"
    assert res.headers["Link"] == '</api/v1/listings>; rel="successor-version"'
    assert "Deprecation" not in client.get("/api/v1/listings").headers


# --- 500 safety net -------------------------------------------------------------


def test_unexpected_errors_become_a_safe_500(sample_repo, monkeypatch, caplog):
    import app.main as main_module

    def boom(*_args, **_kwargs):
        raise RuntimeError("secret internal detail")

    monkeypatch.setattr(main_module, "search", boom)
    client = TestClient(_app(sample_repo))
    with caplog.at_level(logging.ERROR):
        res = client.get("/api/v1/listings", headers={"X-Request-ID": "req-500"})

    assert res.status_code == 500
    body = res.json()
    assert body["error"]["code"] == "INTERNAL_ERROR"
    assert body["error"]["requestId"] == "req-500"
    assert "secret" not in res.text  # internals never reach the client
    assert res.headers["X-Request-ID"] == "req-500"
    assert res.headers["X-Content-Type-Options"] == "nosniff"
    # ...but the traceback is logged, tagged with the same ID.
    logged = next(r for r in caplog.records if r.levelno == logging.ERROR)
    assert logged.request_id == "req-500" and logged.exc_info


# --- Rate limiting ---------------------------------------------------------------


class FakeClock:
    """A clock tests can move forward by hand."""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def test_bucket_allows_a_burst_then_refuses():
    limiter = TokenBucketLimiter(rate=1, capacity=3, clock=FakeClock())
    decisions = [limiter.acquire("a") for _ in range(4)]
    assert [d.allowed for d in decisions] == [True, True, True, False]
    assert [d.remaining for d in decisions[:3]] == [2, 1, 0]
    assert decisions[3].retry_after == 1


def test_bucket_refills_over_time_but_never_above_capacity():
    clock = FakeClock()
    limiter = TokenBucketLimiter(rate=2, capacity=2, clock=clock)
    limiter.acquire("a")
    limiter.acquire("a")
    assert not limiter.acquire("a").allowed
    clock.now = 0.5  # 0.5s * 2 tokens/s = one token back
    assert limiter.acquire("a").allowed
    clock.now = 100  # a long pause refills only up to capacity
    assert [limiter.acquire("a").allowed for _ in range(3)] == [True, True, False]


def test_clients_are_limited_independently():
    limiter = TokenBucketLimiter(rate=1, capacity=1, clock=FakeClock())
    assert limiter.acquire("a").allowed
    assert not limiter.acquire("a").allowed
    assert limiter.acquire("b").allowed


def test_memory_is_bounded_by_evicting_the_least_recent_client():
    limiter = TokenBucketLimiter(rate=1, capacity=1, clock=FakeClock(), max_clients=2)
    limiter.acquire("a")
    limiter.acquire("b")
    limiter.acquire("c")  # evicts "a"
    assert limiter.acquire("a").allowed  # "a" starts again with a full bucket


def test_http_429_with_retry_after_in_the_error_shape(sample_repo):
    client = TestClient(_app(sample_repo, rate_limit_enabled=True, rate_limit_burst=2, rate_limit_per_minute=1))
    first = client.get("/api/v1/meta")
    assert first.headers["RateLimit-Limit"] == "2"
    assert first.headers["RateLimit-Remaining"] == "1"
    client.get("/api/v1/meta")
    res = client.get("/api/v1/meta")
    assert res.status_code == 429
    assert res.json()["error"]["code"] == "RATE_LIMITED"
    assert int(res.headers["Retry-After"]) > 0
    assert res.headers["X-Request-ID"]  # outer middleware still ran


def test_health_probes_are_never_rate_limited(sample_repo):
    client = TestClient(_app(sample_repo, rate_limit_enabled=True, rate_limit_burst=1, rate_limit_per_minute=1))
    assert all(client.get("/api/v1/health/live").status_code == 200 for _ in range(5))
    assert all(client.get("/api/health").status_code == 200 for _ in range(5))
