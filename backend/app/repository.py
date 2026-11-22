"""Load listings from every configured source and keep the merged view in memory.

A few hundred listings don't need a database. The ``ListingRepository``
boundary means swapping one in later only touches this file: the rest of
the app just asks the repository for ``merged`` listings.

Listings come from sources (see ``sources/``). ``from_sources`` loads each
one, validates and merges their records together, and keeps a status per
source for the readiness check.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterable
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .dedupe import merge_listings
from .models import Listing, MergedListing

if TYPE_CHECKING:  # imported for type hints only; sources import this module
    from .sources.base import Source

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

    def __init__(
        self,
        listings: list[Listing],
        *,
        load_error: str | None = None,
        skipped: int = 0,
        source_status: dict[str, dict[str, Any]] | None = None,
    ):
        # Keep the raw records (handy for health checks and debugging) and
        # merge cross-feed duplicates once, up front. Every search then reads
        # the pre-merged list instead of re-merging per request.
        self.raw = listings
        self.merged: list[MergedListing] = merge_listings(listings)
        self.load_error = load_error  # None = loaded fine
        self.skipped = skipped  # records rejected by parse_feed
        # One entry per source for the readiness check: state, counts, errors.
        self.source_status: dict[str, dict[str, Any]] = source_status or {}
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
    def from_sources(cls, sources: Iterable[Source], *, allow_network: bool = True) -> ListingRepository:
        """Load every source, then validate and merge all their records together.

        1. Each source returns its records (``SourceResult``). A source that
           fails reports why instead of raising, so one broken source can't
           stop the others from loading.
        2. Each source's records go through ``parse_feed`` separately, so the
           skipped count in the health check is per source.
        3. All valid records are merged together, so a home listed by two
           sources still shows up once.

        A required source (the sample file) that fails sets ``load_error``,
        and the service reports itself as not ready. An optional source
        (SimplyRETS) that fails only shows up in its own status.
        """
        listings: list[Listing] = []
        status: dict[str, dict[str, Any]] = {}
        load_errors: list[str] = []
        skipped_total = 0
        for source in sources:
            result = source.load(allow_network=allow_network)
            parsed, problems = parse_feed(result.records)
            for problem in problems:
                log.warning("Skipped %s record: %s", result.name, problem)
            listings.extend(parsed)
            skipped = result.skipped + len(problems)
            skipped_total += skipped
            status[result.name] = {
                "status": result.state,
                "listings": len(parsed),
                "skippedRecords": skipped,
                "fetchedAt": result.fetched_at.isoformat() if result.fetched_at else None,
                "error": result.error,
                **result.detail,
            }
            if result.state == "unavailable" and source.required:
                load_errors.append(result.error or f"{result.name} unavailable")
            log.info(
                "Loaded %d %s record(s) (%s, %d skipped)",
                len(parsed),
                result.name,
                result.state,
                skipped,
                extra={"source": result.name, "state": result.state, "records": len(parsed), "skipped": skipped},
            )
        return cls(
            listings,
            load_error="; ".join(load_errors) or None,
            skipped=skipped_total,
            source_status=status,
        )

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
