"""Domain models.

Two levels of listing exist on purpose:

* ``Listing``       - one raw record exactly as a single MLS feed sent it.
* ``MergedListing`` - one real-world property, built from one or more raw
                      records that describe the same home (see ``dedupe.py``).

Search, filtering and scoring operate on ``MergedListing`` so the same house
never shows up twice in results just because two feeds carry it.

All models are frozen dataclasses: once built they can't be mutated, which
means a search can never accidentally change the shared in-memory data that
every request reads from.

Naming convention: Python code uses snake_case (``listed_date``); the JSON
API uses camelCase (``listedDate``) because that's what the React frontend
expects. The ``to_dict`` methods are the single place that translation
happens.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any

# The only statuses the spec defines. Used both when parsing feed records
# and when validating the ``status`` query parameter, so the two can't drift.
VALID_STATUSES = frozenset({"active", "pending", "sold"})

# Result orderings the API supports, in the order the UI lists them.
#   relevance  - the blended budget + recency score (the default)
#   newest     - most recently listed first
#   price_asc  - cheapest first
#   price_desc - most expensive first
#   sqft_desc  - largest first
SORT_OPTIONS = ("relevance", "newest", "price_asc", "price_desc", "sqft_desc")


@dataclass(frozen=True)
class Listing:
    """One raw record from one feed, after type-checking and light cleanup."""

    id: str
    source: str
    address: str
    city: str
    state: str
    zip: str
    price: float
    bedrooms: int
    bathrooms: float
    sqft: int
    latitude: float
    longitude: float
    listed_date: date
    status: str
    description: str

    @staticmethod
    def from_dict(raw: dict[str, Any]) -> Listing:
        """Parse one feed record, raising ``ValueError`` on bad data.

        Feeds are external input, so we validate rather than trust them.
        Every failure is converted to ``ValueError`` so the caller (the
        repository loader) only has one exception type to catch.
        """
        try:
            # Step 1: status must be one of the known values. Normalise case
            # and whitespace first so "Active " from a sloppy feed still works.
            status = str(raw["status"]).strip().lower()
            if status not in VALID_STATUSES:
                raise ValueError(f"unknown status {raw['status']!r}")

            # Step 2: a negative price is never valid and would corrupt
            # budget scoring, so reject the record outright.
            price = float(raw["price"])
            if price < 0:
                raise ValueError("negative price")

            # Step 3: coerce every field to its declared type. int()/float()
            # raise on garbage like "three", and date.fromisoformat raises on
            # anything that isn't YYYY-MM-DD. Text fields are trimmed; state
            # is upper-cased so "va" and "VA" compare equal later.
            return Listing(
                id=str(raw["id"]),
                source=str(raw["source"]),
                address=str(raw["address"]).strip(),
                city=str(raw["city"]).strip(),
                state=str(raw["state"]).strip().upper(),
                zip=str(raw["zip"]).strip(),
                price=price,
                bedrooms=int(raw["bedrooms"]),
                bathrooms=float(raw["bathrooms"]),
                sqft=int(raw["sqft"]),
                latitude=float(raw["latitude"]),
                longitude=float(raw["longitude"]),
                listed_date=date.fromisoformat(str(raw["listedDate"])),
                status=status,
                # Description is the one optional field: missing/null -> "".
                description=str(raw.get("description") or ""),
            )
        except KeyError as exc:
            # A required field is missing entirely - name it in the message.
            raise ValueError(f"missing field {exc.args[0]!r}") from exc
        except (TypeError, ValueError) as exc:
            # Wrong type or unparseable value - re-raise as plain ValueError.
            raise ValueError(str(exc)) from exc


@dataclass(frozen=True)
class SourceRef:
    """Where a merged listing came from - one entry per contributing feed record.

    Kept on every merged listing so nothing is lost by deduplication: you can
    always see each feed's own id, address spelling, price and date.
    """

    source: str
    id: str
    address: str
    price: float
    listed_date: date
    status: str

    def to_dict(self) -> dict[str, Any]:
        # Convert to the camelCase JSON shape the frontend reads.
        return {
            "source": self.source,
            "id": self.id,
            "address": self.address,
            "price": self.price,
            "listedDate": self.listed_date.isoformat(),
            "status": self.status,
        }


@dataclass(frozen=True)
class MergedListing:
    """One real property, possibly built from several feed records."""

    listing_key: str  # stable unique id derived from the normalized address
    address: str
    city: str
    state: str
    zip: str
    price: float
    bedrooms: int
    bathrooms: float
    sqft: int
    latitude: float
    longitude: float
    listed_date: date  # earliest date any feed listed it = true time on market
    status: str
    description: str  # description from the primary record (for display)
    search_text: str  # all source descriptions joined (for keyword matching)
    sources: tuple[SourceRef, ...]  # tuple (not list) so the dataclass stays immutable


@dataclass(frozen=True)
class SearchParams:
    """A fully validated search request. Built only by ``validation.py``,
    so code that receives one can trust every value in it."""

    min_price: float | None = None
    max_price: float | None = None
    min_bedrooms: int | None = None
    city: str | None = None
    keywords: tuple[str, ...] = ()  # already split, lowercased, de-duplicated
    target_budget: float | None = None  # None = rank by recency only
    statuses: frozenset[str] = frozenset({"active"})  # default: active only
    page: int = 1
    page_size: int = 10
    as_of: date | None = None  # reference date for recency; None = today
    sort: str = "relevance"  # one of SORT_OPTIONS


@dataclass(frozen=True)
class ScoreBreakdown:
    """The parts that make up a relevance score, returned so the UI (and the
    interviewer) can see *why* a listing ranked where it did."""

    budget: float | None  # None when no targetBudget was given
    recency: float
    days_on_market: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "budget": self.budget,
            "recency": self.recency,
            "daysOnMarket": self.days_on_market,
        }


@dataclass(frozen=True)
class ScoredListing:
    """A merged listing paired with its score for one particular search."""

    listing: MergedListing
    score: float
    breakdown: ScoreBreakdown

    def to_dict(self) -> dict[str, Any]:
        # Flatten listing + score into the single JSON object the UI renders.
        # Internal-only fields (search_text) are deliberately left out.
        m = self.listing
        return {
            "listingKey": m.listing_key,
            "address": m.address,
            "city": m.city,
            "state": m.state,
            "zip": m.zip,
            "price": m.price,
            "bedrooms": m.bedrooms,
            "bathrooms": m.bathrooms,
            "sqft": m.sqft,
            "latitude": m.latitude,
            "longitude": m.longitude,
            "listedDate": m.listed_date.isoformat(),
            "status": m.status,
            "description": m.description,
            "relevanceScore": self.score,
            "scoreBreakdown": self.breakdown.to_dict(),
            "sources": [s.to_dict() for s in m.sources],
        }


@dataclass(frozen=True)
class Pagination:
    """Page metadata the UI needs to draw its controls."""

    page: int
    page_size: int
    total_results: int  # matches across *all* pages, not just this one
    total_pages: int  # 0 when there are no matches at all

    def to_dict(self) -> dict[str, Any]:
        return {
            "page": self.page,
            "pageSize": self.page_size,
            "totalResults": self.total_results,
            "totalPages": self.total_pages,
            # Derived flags so the UI doesn't have to re-implement the maths
            # for enabling/disabling the Previous/Next buttons.
            "hasPrevious": self.page > 1,
            "hasNext": self.page < self.total_pages,
        }


@dataclass(frozen=True)
class SearchResult:
    """Everything one search returns: this page's results, page metadata,
    and non-fatal warnings (e.g. "no listings in that city")."""

    results: list[ScoredListing]
    pagination: Pagination
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "results": [r.to_dict() for r in self.results],
            "pagination": self.pagination.to_dict(),
            "warnings": list(self.warnings),
        }
