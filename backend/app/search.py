"""Filter -> score -> sort -> paginate.

Each stage is a small pure function so a new requirement (a geo radius, a
new sort, a different scoring signal) slots into exactly one place:

* a new filter        -> ``matches_filters``
* a new score signal  -> ``scoring.py``
* a new sort order    -> ``rank`` (and ``SORT_OPTIONS`` in models.py)
* new response hints  -> the warnings block at the end of ``search``
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable
from datetime import date
from functools import lru_cache

from .dedupe import normalize_city
from .models import MergedListing, Pagination, ScoredListing, SearchParams, SearchResult
from .scoring import score_listing


@lru_cache(maxsize=256)
def _keyword_pattern(term: str) -> re.Pattern[str]:
    """Compile (and cache) a whole-word, case-insensitive regex for one term.

    Caching matters because the same term is checked against every listing;
    without it we'd recompile the same regex once per listing per search.
    """
    # Step 1: escape each word so user input like "a.*" or "2-car" is matched
    # literally, never interpreted as regex syntax.
    # Step 2: join words with \s+ so a phrase like "community pool" also
    # matches "community  pool" (extra spaces/newlines in a description).
    body = r"\s+".join(re.escape(part) for part in term.split())

    # Step 3: \b on both ends = whole words only, so "pet" won't match
    # "carpet". IGNORECASE makes "Pool" match "pool".
    return re.compile(rf"\b{body}\b", re.IGNORECASE)


def matches_keywords(text: str, keywords: tuple[str, ...]) -> bool:
    """All terms must match (AND), the way each added keyword narrows results
    on consumer portals."""
    # all() short-circuits: stops at the first term that doesn't match.
    return all(_keyword_pattern(term).search(text) for term in keywords)


def matches_filters(listing: MergedListing, params: SearchParams) -> bool:
    """True if the listing passes every filter the user set.

    Each check is skipped when its parameter is None (not set). Checks are
    ordered cheapest first, so the regex keyword match only runs on listings
    that already passed the simple comparisons.
    """
    # Status: default is {"active"}, so pending/sold are hidden unless asked for.
    if listing.status not in params.statuses:
        return False
    # Price range: both bounds are inclusive.
    if params.min_price is not None and listing.price < params.min_price:
        return False
    if params.max_price is not None and listing.price > params.max_price:
        return False
    # Bedrooms: "at least N".
    if params.min_bedrooms is not None and listing.bedrooms < params.min_bedrooms:
        return False
    # City: exact match after normalizing case and whitespace on both sides.
    if params.city is not None and normalize_city(listing.city) != normalize_city(params.city):
        return False
    # Keywords: matched against every source's description (search_text),
    # not just the one displayed, so merged listings don't lose matches.
    if params.keywords and not matches_keywords(listing.search_text, params.keywords):
        return False
    return True


def rank(scored: list[ScoredListing], sort: str = "relevance") -> list[ScoredListing]:
    """Order results for one of ``SORT_OPTIONS``.

    Every ordering ends in the same deterministic tie-breakers, so the same
    query always returns the same order and pages never overlap or skip
    items: newest listing, then lower price, then listing key (unique).

    ``relevance`` (the default): highest score first, then the tie-breakers.
    The other sorts put their own field first and fall back to relevance,
    so e.g. two homes at the same price still appear best-match first.
    """

    # Fields every ordering ends with, so the order is always fully defined.
    def tiebreak(s: ScoredListing) -> tuple[float, int, float, str]:
        return (-s.score, -s.listing.listed_date.toordinal(), s.listing.price, s.listing.listing_key)

    # The primary key for each non-default sort. Negation = descending.
    primary: dict[str, Callable[[ScoredListing], float]] = {
        "newest": lambda s: -s.listing.listed_date.toordinal(),
        "price_asc": lambda s: s.listing.price,
        "price_desc": lambda s: -s.listing.price,
        "sqft_desc": lambda s: -s.listing.sqft,
    }
    if sort in primary:
        key = primary[sort]
        return sorted(scored, key=lambda s: (key(s), *tiebreak(s)))

    # Relevance: the tie-breaker tuple *is* the ordering. Python sorts tuples
    # element by element; negation flips a field to descending:
    #   1. -score        -> highest score first
    #   2. -date ordinal -> newest listing first (among equal scores)
    #   3. price         -> cheaper first (among equal score and date)
    #   4. listing_key   -> unique, so the order is always fully defined
    return sorted(scored, key=tiebreak)


def paginate(items: list[ScoredListing], page: int, page_size: int) -> tuple[list[ScoredListing], Pagination]:
    """Slice out one page and describe where it sits among all results."""
    total = len(items)

    # Round up: 25 items / 10 per page = 3 pages. Zero items = zero pages
    # (not one empty page), so the UI can tell "no results" apart.
    total_pages = math.ceil(total / page_size) if total else 0

    # Pages are 1-based: page 1 starts at index 0, page 2 at index page_size.
    start = (page - 1) * page_size

    # Python slicing never raises: a start past the end just returns [],
    # which is exactly the "page past the end" behaviour we want.
    return items[start : start + page_size], Pagination(
        page=page, page_size=page_size, total_results=total, total_pages=total_pages
    )


def search(listings: list[MergedListing], params: SearchParams, *, today: date | None = None) -> SearchResult:
    """Run one search end to end.

    ``today`` exists only so tests can pin the clock; in production it's
    left as None and the real date is used.
    """
    # Step 1: choose the reference date for recency. Priority: the asOf
    # parameter from the request, then the injected test date, then today.
    as_of = params.as_of or today or date.today()

    # Step 2: filter. Only listings that pass every filter are scored, so
    # scoring work scales with the number of matches, not the whole dataset.
    matched = [m for m in listings if matches_filters(m, params)]

    # Step 3: score each match against the target budget and recency.
    scored = []
    for m in matched:
        score, breakdown = score_listing(m, params.target_budget, as_of)
        scored.append(ScoredListing(listing=m, score=score, breakdown=breakdown))

    # Step 4: sort *all* matches, then cut out the requested page. Sorting
    # before paginating is essential - otherwise each page would only be
    # sorted within itself.
    page_items, pagination = paginate(rank(scored, params.sort), params.page, params.page_size)

    # Step 5: non-fatal warnings. These explain an empty result without
    # turning it into an error (the request itself was valid).
    warnings: list[str] = []

    # 5a: the city doesn't exist anywhere in the data (likely a typo), as
    # opposed to a real city where the other filters removed everything.
    # Checked against all listings, regardless of status or other filters.
    if params.city is not None:
        known = {normalize_city(m.city) for m in listings}
        if normalize_city(params.city) not in known:
            cities = sorted({m.city for m in listings})
            warnings.append(f"No listings in city '{params.city}'. Cities with listings: {', '.join(cities)}.")

    # 5b: the page number is beyond the last page of real results.
    # (Skipped when there are zero results - "no matches" says it all.)
    if pagination.total_pages and params.page > pagination.total_pages:
        warnings.append(f"Page {params.page} is past the last page ({pagination.total_pages}).")

    return SearchResult(results=page_items, pagination=pagination, warnings=warnings)
