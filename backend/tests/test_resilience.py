"""Retry, circuit breaker and snapshot cache, with a fake clock and sleep."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.sources.resilience import CircuitBreaker, RetryableError, SnapshotCache, retry

WHEN = datetime(2026, 9, 1, tzinfo=timezone.utc)


# --- retry ---------------------------------------------------------------------


def test_retry_waits_longer_each_time_and_gives_up_after_the_last_attempt():
    waits = []

    def always_fails():
        raise RetryableError("down")

    with pytest.raises(RetryableError):
        retry(always_fails, attempts=4, base_delay=1, max_delay=3, sleep=waits.append, jitter=lambda: 1.0)
    # Ceilings 1, 2, 3 (capped); jitter=1.0 lands at the ceiling. No wait after the last try.
    assert waits == [1.0, 2.0, 3.0]


def test_retry_jitter_lands_in_the_upper_half_of_the_window():
    waits = []
    calls = []

    def fails_once():
        calls.append(1)
        if len(calls) == 1:
            raise RetryableError("once")
        return "ok"

    assert retry(fails_once, base_delay=2, sleep=waits.append, jitter=lambda: 0.0) == "ok"
    assert waits == [1.0]


def test_retry_does_not_retry_other_errors():
    calls = []

    def broken():
        calls.append(1)
        raise ValueError("bad data")

    with pytest.raises(ValueError):
        retry(broken, sleep=lambda s: None)
    assert calls == [1]


# --- CircuitBreaker ---------------------------------------------------------------


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


def test_breaker_opens_after_the_threshold_and_half_opens_after_cooling_off():
    clock = Clock()
    breaker = CircuitBreaker(failure_threshold=3, reset_after=100, clock=clock)
    breaker.record_failure()
    breaker.record_failure()
    assert (breaker.state, breaker.allow()) == ("closed", True)
    breaker.record_failure()
    assert (breaker.state, breaker.allow()) == ("open", False)
    clock.now = 99
    assert breaker.state == "open"
    clock.now = 100
    assert (breaker.state, breaker.allow()) == ("half_open", True)


def test_a_failed_trial_call_reopens_the_breaker():
    clock = Clock()
    breaker = CircuitBreaker(failure_threshold=1, reset_after=10, clock=clock)
    breaker.record_failure()
    clock.now = 10
    assert breaker.state == "half_open"
    breaker.record_failure()
    assert breaker.state == "open"


def test_a_success_resets_the_failure_count():
    breaker = CircuitBreaker(failure_threshold=2, clock=Clock())
    breaker.record_failure()
    breaker.record_success()
    breaker.record_failure()
    assert breaker.state == "closed"


# --- SnapshotCache ------------------------------------------------------------------


def test_snapshot_round_trips_and_creates_its_folder(tmp_path):
    cache = SnapshotCache(tmp_path / "nested" / "cache.json")
    cache.save([{"a": 1}], WHEN)
    assert cache.load() == ([{"a": 1}], WHEN)
    assert [p.name for p in (tmp_path / "nested").iterdir()] == ["cache.json"]  # no temp file left behind


def test_missing_snapshot_is_none(tmp_path):
    assert SnapshotCache(tmp_path / "none.json").load() is None


@pytest.mark.parametrize(
    "content",
    [
        "{broken",
        "[]",
        '{"records": [], "fetchedAt": "not a date"}',
        '{"records": {}, "fetchedAt": "2026-09-01T00:00:00+00:00"}',
    ],
)
def test_unusable_snapshot_is_none(tmp_path, content):
    path = tmp_path / "cache.json"
    path.write_text(content)
    assert SnapshotCache(path).load() is None


def test_a_failed_write_keeps_the_old_snapshot_and_cleans_up(tmp_path):
    cache = SnapshotCache(tmp_path / "cache.json")
    cache.save([{"a": 1}], WHEN)
    with pytest.raises(TypeError):
        cache.save([{"bad": object()}], WHEN)  # not JSON-serialisable
    assert cache.load() == ([{"a": 1}], WHEN)
    assert [p.name for p in tmp_path.iterdir()] == ["cache.json"]
