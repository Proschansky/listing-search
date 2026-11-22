"""The interface every listing source implements.

A source's ``load`` returns a ``SourceResult``: the records it has, in the
app's feed format, and how it got them. The repository combines the results
of all configured sources, and ``/health/ready`` reports each one's status.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal, Protocol

# ok:          the source delivered fresh data.
# degraded:    the source failed, but an older copy of its data is in use.
# unavailable: the source failed and there's nothing to fall back on.
SourceState = Literal["ok", "degraded", "unavailable"]


@dataclass(frozen=True)
class SourceResult:
    """What one source delivered, and how."""

    name: str
    state: SourceState
    records: list[dict[str, Any]] = field(default_factory=list)
    # Records the source couldn't turn into the feed format (for example a
    # SimplyRETS listing with a status the app doesn't use).
    skipped: int = 0
    error: str | None = None
    # When the data in use was downloaded; None for local files.
    fetched_at: datetime | None = None
    # Extra detail for the health check, such as the circuit breaker's state.
    detail: dict[str, Any] = field(default_factory=dict)


class Source(Protocol):
    """A place listings come from."""

    #: Short name used in health checks and logs, for example "sample".
    name: str
    #: If a required source fails, the service reports itself as not ready.
    required: bool

    def load(self, *, allow_network: bool = True) -> SourceResult:
        """Return this source's records.

        ``allow_network=False`` asks for whatever is available without
        calling out, which is how the service starts instantly while a
        background task does the first download.
        """
        ...
