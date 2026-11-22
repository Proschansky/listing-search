"""Which listings the service is serving right now, and how they're refreshed.

The repository is immutable: a refresh builds a whole new one and swaps it in
with a single assignment, so a request always sees one complete, consistent
set of listings, never a half-updated mix.

A refresh that fails keeps the old data. Losing SimplyRETS for a few minutes
should mean "slightly stale listings", not "no listings".
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence

from .config import Settings
from .repository import ListingRepository
from .sources.base import Source
from .sources.resilience import SnapshotCache
from .sources.sample import SampleSource
from .sources.simplyrets import SimplyRetsSource

log = logging.getLogger(__name__)


class RepositoryStore:
    """Holds the current repository; routes read ``store.current``."""

    def __init__(self, repository: ListingRepository):
        self._current = repository

    @property
    def current(self) -> ListingRepository:
        return self._current

    def replace(self, repository: ListingRepository) -> bool:
        """Swap in ``repository`` if it's ready; otherwise keep the current one.

        Returns whether the swap happened.
        """
        if not repository.ready:
            log.warning("Refreshed listings aren't usable (%s); keeping the current ones.", repository.load_error)
            return False
        self._current = repository
        return True


def build_sources(settings: Settings) -> list[Source]:
    """The sources named in ``settings.sources``, in that order."""
    sources: list[Source] = []
    for name in settings.sources:
        if name == "sample":
            sources.append(SampleSource(settings.listings_path))
        elif name == "simplyrets":
            sources.append(
                SimplyRetsSource(
                    url=settings.simplyrets_url,
                    username=settings.simplyrets_username.get_secret_value(),
                    password=settings.simplyrets_password.get_secret_value(),
                    timeout=settings.simplyrets_timeout_seconds,
                    cache=SnapshotCache(settings.simplyrets_cache_path),
                )
            )
    return sources


def needs_refresh(sources: Sequence[Source]) -> bool:
    """Whether any source downloads data that can change (only SimplyRETS today)."""
    return any(isinstance(source, SimplyRetsSource) for source in sources)


def refresh(store: RepositoryStore, sources: Sequence[Source]) -> bool:
    """Reload every source and swap in the result if it's usable."""
    return store.replace(ListingRepository.from_sources(sources))


async def refresh_forever(store: RepositoryStore, sources: Sequence[Source], interval_seconds: float) -> None:
    """Refresh now, then every ``interval_seconds``, until cancelled.

    The download runs in a worker thread, so the event loop keeps answering
    requests while it waits on SimplyRETS.
    """
    while True:
        try:
            await asyncio.to_thread(refresh, store, sources)
        except Exception:
            # Never let one bad refresh stop all future ones.
            log.exception("Listing refresh failed; keeping the current listings.")
        await asyncio.sleep(interval_seconds)
