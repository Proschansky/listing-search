"""Turn raw query-string values into a validated ``SearchParams``.

Kept free of any web framework so it can be unit-tested directly.
All problems are collected and reported together, so the UI can highlight
every bad field at once instead of making the user fix them one by one.

Pattern used throughout: each ``_number`` / ``_integer`` / ``_text`` helper
either returns a clean value (or ``None`` if the field was left blank), or
appends a ``FieldError`` to the shared ``errors`` list and returns ``None``.
At the end, if the list isn't empty, everything is raised in one exception.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date

from .models import SORT_OPTIONS, VALID_STATUSES, SearchParams

DEFAULT_PAGE_SIZE = 10
MAX_PAGE_SIZE = 100  # stops one request from asking for an unbounded page
MAX_TEXT_LENGTH = 200  # generous for a city or keyword list, blocks abuse

# Every parameter the API understands. Anything else is rejected as a typo.
KNOWN_PARAMS = (
    "minPrice",
    "maxPrice",
    "minBedrooms",
    "city",
    "keyword",
    "targetBudget",
    "status",
    "page",
    "pageSize",
    "asOf",
    "sort",
)


@dataclass(frozen=True)
class FieldError:
    """One problem with one parameter, e.g. ("pageSize", "must be 1 or greater")."""

    field: str
    message: str

    def to_dict(self) -> dict[str, str]:
        return {"field": self.field, "message": self.message}


class InvalidSearchParams(Exception):
    """Raised with *every* validation error found; mapped to HTTP 400 in main.py."""

    def __init__(self, errors: list[FieldError]):
        # The plain-text message is handy in logs and test failures.
        super().__init__("; ".join(f"{e.field}: {e.message}" for e in errors))
        self.errors = errors


def _blank(value: str | None) -> bool:
    """A missing parameter and an empty/whitespace-only one mean the same
    thing: "not set". (An empty form input sends ``minPrice=``.)"""
    return value is None or value.strip() == ""


def _number(name: str, value: str | None, errors: list[FieldError], *, positive: bool = False) -> float | None:
    """Parse a non-negative number (or strictly positive if ``positive``)."""
    # Not set -> no filter, not an error.
    if _blank(value):
        return None

    # Must parse as a number at all.
    try:
        number = float(value)  # type: ignore[arg-type]
    except ValueError:
        errors.append(FieldError(name, f"must be a number, got {value!r}"))
        return None

    # float() happily accepts "nan" and "inf" - neither is a usable price.
    if not math.isfinite(number):
        errors.append(FieldError(name, "must be a finite number"))
        return None

    # Range checks. targetBudget must be > 0 (it's a divisor in scoring);
    # prices just can't be negative.
    if positive and number <= 0:
        errors.append(FieldError(name, "must be greater than 0"))
        return None
    if number < 0:
        errors.append(FieldError(name, "must be 0 or greater"))
        return None
    return number


def _integer(
    name: str, value: str | None, errors: list[FieldError], *, minimum: int, maximum: int | None = None
) -> int | None:
    """Parse a whole number within [minimum, maximum]."""
    if _blank(value):
        return None

    # int("2.5") raises, so fractional bedrooms/pages are rejected rather
    # than silently truncated.
    try:
        number = int(value.strip())  # type: ignore[union-attr]
    except ValueError:
        errors.append(FieldError(name, f"must be a whole number, got {value!r}"))
        return None

    # Bounds checks - this is where pageSize <= 0 and page < 1 are caught.
    if number < minimum:
        errors.append(FieldError(name, f"must be {minimum} or greater"))
        return None
    if maximum is not None and number > maximum:
        errors.append(FieldError(name, f"must be {maximum} or less"))
        return None
    return number


def _text(name: str, value: str | None, errors: list[FieldError]) -> str | None:
    """Trim free text and enforce a length cap."""
    if _blank(value):
        return None
    text = value.strip()  # type: ignore[union-attr]
    if len(text) > MAX_TEXT_LENGTH:
        errors.append(FieldError(name, f"must be at most {MAX_TEXT_LENGTH} characters"))
        return None
    return text


def parse_keywords(value: str | None) -> tuple[str, ...]:
    """Comma-separated terms, like Zillow's keyword box. Each term may be a
    phrase ("community pool"). Blank terms are dropped; duplicates removed."""
    if _blank(value):
        return ()
    seen: list[str] = []
    for term in value.split(","):  # type: ignore[union-attr]
        # Lowercase and collapse inner whitespace so "Community   Pool" and
        # "community pool" are treated as the same term.
        cleaned = " ".join(term.lower().split())
        # Skip empties (from ",," or a trailing comma) and repeats, keeping
        # first-seen order. A list is fine here - keyword lists are tiny.
        if cleaned and cleaned not in seen:
            seen.append(cleaned)
    return tuple(seen)


def parse_search_params(raw: Mapping[str, Sequence[str]]) -> SearchParams:
    """``raw`` maps each parameter name to every value it was given with,
    so repeated parameters (``?page=1&page=2``) can be rejected rather than
    silently picking one."""
    # All problems found go here; nothing is raised until the very end.
    errors: list[FieldError] = []

    # Step 1: reject unknown parameter names. A typo like "minprice" would
    # otherwise be ignored and return unfiltered results that *look* right.
    for name in sorted(raw):
        if name not in KNOWN_PARAMS:
            errors.append(FieldError(name, f"unknown parameter. Supported: {', '.join(KNOWN_PARAMS)}"))

    # Step 2: reduce each known parameter to a single value (or None), and
    # reject any parameter that was supplied more than once - it's ambiguous
    # which one the caller meant.
    values: dict[str, str | None] = {}
    for name in KNOWN_PARAMS:
        given = list(raw.get(name, []))
        if len(given) > 1:
            errors.append(FieldError(name, "was given more than once"))
            values[name] = None
        else:
            values[name] = given[0] if given else None

    # Step 3: price range. Each bound is validated on its own first; the
    # cross-field check only runs if both parsed successfully.
    min_price = _number("minPrice", values["minPrice"], errors)
    max_price = _number("maxPrice", values["maxPrice"], errors)
    if min_price is not None and max_price is not None and min_price > max_price:
        # Attach the error to minPrice so the UI highlights that field.
        # (min == max is allowed: "exactly this price" is a valid question.)
        errors.append(FieldError("minPrice", f"must not be greater than maxPrice ({min_price:g} > {max_price:g})"))

    # Step 4: the remaining simple fields.
    min_bedrooms = _integer("minBedrooms", values["minBedrooms"], errors, minimum=0)
    target_budget = _number("targetBudget", values["targetBudget"], errors, positive=True)
    city = _text("city", values["city"], errors)

    # Step 5: keywords - length-check the raw text, then split into terms.
    keyword_text = _text("keyword", values["keyword"], errors)
    keywords = parse_keywords(keyword_text)

    # Step 6: status filter. Default is active-only; otherwise a
    # comma-separated subset of active/pending/sold.
    statuses: frozenset[str] = frozenset({"active"})
    if not _blank(values["status"]):
        requested = {s.strip().lower() for s in values["status"].split(",") if s.strip()}  # type: ignore[union-attr]
        unknown = sorted(requested - VALID_STATUSES)
        if unknown:
            errors.append(
                FieldError(
                    "status",
                    f"unknown value(s) {', '.join(unknown)}. Use any of: {', '.join(sorted(VALID_STATUSES))}",
                )
            )
        elif requested:
            statuses = frozenset(requested)

    # Step 7: pagination. page starts at 1; pageSize is capped at
    # MAX_PAGE_SIZE. Zero or negative values are errors, not "use default".
    page = _integer("page", values["page"], errors, minimum=1)
    page_size = _integer("pageSize", values["pageSize"], errors, minimum=1, maximum=MAX_PAGE_SIZE)

    # Step 8: optional reference date for recency scoring (YYYY-MM-DD).
    as_of = None
    if not _blank(values["asOf"]):
        try:
            as_of = date.fromisoformat(values["asOf"].strip())  # type: ignore[union-attr]
        except ValueError:
            errors.append(FieldError("asOf", "must be a date in YYYY-MM-DD format"))

    # Step 9: result ordering. Blank means the default (relevance); anything
    # not in SORT_OPTIONS is an error rather than a silent fallback, so a
    # typo like sort=price never quietly returns relevance order.
    sort = "relevance"
    if not _blank(values["sort"]):
        requested_sort = values["sort"].strip().lower()  # type: ignore[union-attr]
        if requested_sort in SORT_OPTIONS:
            sort = requested_sort
        else:
            errors.append(FieldError("sort", f"must be one of: {', '.join(SORT_OPTIONS)}"))

    # Step 10: if anything at all was wrong, report every problem together.
    if errors:
        raise InvalidSearchParams(errors)

    # Step 11: everything is valid - build the immutable params object,
    # filling defaults for pagination fields that weren't supplied.
    return SearchParams(
        min_price=min_price,
        max_price=max_price,
        min_bedrooms=min_bedrooms,
        city=city,
        keywords=keywords,
        target_budget=target_budget,
        statuses=statuses,
        page=page or 1,
        page_size=page_size or DEFAULT_PAGE_SIZE,
        as_of=as_of,
        sort=sort,
    )
