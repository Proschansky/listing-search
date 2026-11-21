"""Load feed data once at startup and keep the merged view in memory.

Twelve listings don't need a database. The ``ListingRepository`` boundary
means swapping in one later only touches this file: the rest of the app
just asks the repository for ``merged`` listings.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from .dedupe import merge_listings
from .models import Listing, MergedListing

log = logging.getLogger(__name__)

# backend/data/sample_listings.json, resolved relative to this file so the
# server works no matter which directory it's started from.
DEFAULT_DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "sample_listings.json"


def parse_feed(raw_records: list[dict]) -> tuple[list[Listing], list[str]]:
    """Parse records, skipping (and reporting) bad ones instead of failing the
    whole load: one broken record in a feed shouldn't take search down.

    Returns (good listings, human-readable problems).
    """
    listings: list[Listing] = []
    problems: list[str] = []
    seen: set[tuple[str, str]] = set()

    for index, raw in enumerate(raw_records):
        # Step 1: type-check and clean the record. A bad record is noted
        # (with its position and id, to make it easy to find) and skipped.
        try:
            listing = Listing.from_dict(raw)
        except ValueError as exc:
            problems.append(f"record {index} ({raw.get('source')}/{raw.get('id')}): {exc}")
            continue

        # Step 2: reject exact repeats *within* one feed. ids are only unique
        # per source, so (source, id) is the real key - "A1" from MLS_A and
        # "A1" from MLS_B would be two different records.
        key = (listing.source, listing.id)
        if key in seen:
            problems.append(f"record {index}: duplicate {listing.source}/{listing.id}, kept first")
            continue
        seen.add(key)
        listings.append(listing)

    return listings, problems


class ListingRepository:
    """Holds the raw records and the deduplicated view built from them.

    Also records *how* loading went (``load_error``, ``skipped``), which the
    readiness probe reports. A repository that failed to load is still a
    valid, empty repository: the service stays up and says it isn't ready,
    instead of crash-looping.
    """

    def __init__(self, listings: list[Listing], *, load_error: str | None = None, skipped: int = 0):
        # Keep the raw records (handy for health checks and debugging) and
        # merge cross-feed duplicates once, up front. Every search then reads
        # the pre-merged list instead of re-merging per request.
        self.raw = listings
        self.merged: list[MergedListing] = merge_listings(listings)
        self.load_error = load_error  # None = loaded fine
        self.skipped = skipped  # records rejected by parse_feed
        # Index by listing key for O(1) detail lookups (GET /listings/{key}).
        self._by_key = {m.listing_key: m for m in self.merged}

    @property
    def ready(self) -> bool:
        """True when data loaded without a fatal error and holds at least one listing."""
        return self.load_error is None and bool(self.merged)

    @classmethod
    def from_file(cls, path: Path = DEFAULT_DATA_PATH) -> ListingRepository:
        """Build a repository from a JSON file containing a list of records.

        Raises on an unreadable file or invalid JSON; use ``load_safely``
        when the caller would rather degrade than crash.
        """
        # Read and parse the JSON, then validate each record.
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, list):
            raise ValueError(f"{path} must contain a JSON list of listing records")
        listings, problems = parse_feed(data)
        # Surface skipped records in the server log rather than failing.
        for problem in problems:
            log.warning("Skipped feed record: %s", problem)
        log.info(
            "Loaded %d records (%d skipped) from %s",
            len(listings),
            len(problems),
            path,
            extra={"records": len(listings), "skipped": len(problems)},
        )
        return cls(listings, skipped=len(problems))

    @classmethod
    def load_safely(cls, path: Path = DEFAULT_DATA_PATH) -> ListingRepository:
        """Like ``from_file``, but a missing or corrupt file yields an *empty*
        repository with ``load_error`` set, instead of an exception.

        Why: if the data file is bad, a crash-looping container is harder to
        diagnose than a running one whose /health/ready says exactly what's
        wrong. Searches simply return no results until the data is fixed.
        """
        try:
            return cls.from_file(path)
        except (OSError, ValueError) as exc:  # json.JSONDecodeError is a ValueError
            log.error("Could not load listings from %s: %s", path, exc)
            return cls([], load_error=f"{type(exc).__name__}: {exc}")

    def get(self, listing_key: str) -> MergedListing | None:
        """One merged listing by its key, or ``None`` if there's no such listing."""
        return self._by_key.get(listing_key)

    def cities(self) -> list[str]:
        """Distinct cities, sorted - used for the UI's city suggestions."""
        return sorted({m.city for m in self.merged})
