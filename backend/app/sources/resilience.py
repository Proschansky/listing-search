"""Tools for depending on a service we don't control.

Three small pieces, used by the SimplyRETS source:

* ``retry``: try again after short, growing waits, but only for failures
  that are likely to pass (network errors, 429, 5xx).
* ``CircuitBreaker``: after several failures in a row, stop calling the
  service for a while, so a dead API isn't hammered on every refresh.
* ``SnapshotCache``: keep the last good download on disk and fall back to
  it when the service can't be reached.

Each takes its clock or sleep function as an argument, so tests can run
them instantly and deterministically.
"""

from __future__ import annotations

import json
import os
import random
import tempfile
import time
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any, Literal, TypeVar

T = TypeVar("T")


class RetryableError(Exception):
    """A failure worth trying again: a dropped connection, a timeout, 429 or 5xx."""


def retry(
    fn: Callable[[], T],
    *,
    attempts: int = 3,
    base_delay: float = 0.5,
    max_delay: float = 4.0,
    sleep: Callable[[float], None] = time.sleep,
    jitter: Callable[[], float] = random.random,
) -> T:
    """Call ``fn``, retrying on ``RetryableError`` with exponential backoff.

    The wait doubles each time (0.5 s, 1 s, 2 s, capped at ``max_delay``) and
    lands somewhere in the upper half of that window, so many clients that
    failed together don't all retry together. Any other exception, and the
    last ``RetryableError``, is raised to the caller.

    >>> calls = []
    >>> def flaky():
    ...     calls.append(1)
    ...     if len(calls) < 3:
    ...         raise RetryableError("try again")
    ...     return "ok"
    >>> retry(flaky, sleep=lambda s: None)
    'ok'
    >>> len(calls)
    3
    """
    for attempt in range(attempts):
        try:
            return fn()
        except RetryableError:
            if attempt == attempts - 1:
                raise
            ceiling = min(max_delay, base_delay * 2**attempt)
            sleep(ceiling / 2 + jitter() * ceiling / 2)
    raise AssertionError("unreachable")  # pragma: no cover - the loop always returns or raises


BreakerState = Literal["closed", "open", "half_open"]


class CircuitBreaker:
    """Stops calling a failing service for a cooling-off period.

    * closed: calls go through. Each failure is counted; a success resets it.
    * open: after ``failure_threshold`` failures in a row, calls are refused
      for ``reset_after`` seconds.
    * half_open: once that time has passed, one trial call is allowed. If it
      succeeds the breaker closes; if it fails, it opens again.

    >>> now = [0.0]
    >>> breaker = CircuitBreaker(failure_threshold=2, reset_after=60, clock=lambda: now[0])
    >>> breaker.record_failure(); breaker.record_failure()
    >>> breaker.allow(), breaker.state
    (False, 'open')
    >>> now[0] = 61
    >>> breaker.allow(), breaker.state
    (True, 'half_open')
    """

    def __init__(
        self,
        failure_threshold: int = 3,
        reset_after: float = 300.0,
        *,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.failure_threshold = failure_threshold
        self.reset_after = reset_after
        self._clock = clock
        self._failures = 0
        self._opened_at: float | None = None

    @property
    def state(self) -> BreakerState:
        if self._opened_at is None:
            return "closed"
        if self._clock() - self._opened_at >= self.reset_after:
            return "half_open"
        return "open"

    def allow(self) -> bool:
        """Whether a call may be made now."""
        return self.state != "open"

    def record_success(self) -> None:
        self._failures = 0
        self._opened_at = None

    def record_failure(self) -> None:
        self._failures += 1
        # A failed trial call in half_open re-opens straight away.
        if self._failures >= self.failure_threshold or self._opened_at is not None:
            self._opened_at = self._clock()


class SnapshotCache:
    """The last good download of a feed, kept in a JSON file.

    Writes go to a temporary file that then replaces the old one in a single
    step, so a crash mid-write can't leave a half-written snapshot behind.
    """

    def __init__(self, path: Path):
        self.path = path

    def save(self, records: list[dict[str, Any]], fetched_at: datetime) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"fetchedAt": fetched_at.isoformat(), "records": records}
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=self.path.name, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(payload, fh)
            os.replace(tmp, self.path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    def load(self) -> tuple[list[dict[str, Any]], datetime] | None:
        """The saved records and when they were downloaded, or None if there's no usable snapshot."""
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            records = payload["records"]
            fetched_at = datetime.fromisoformat(payload["fetchedAt"])
        except (OSError, ValueError, KeyError, TypeError):
            return None
        if not isinstance(records, list):
            return None
        return records, fetched_at
