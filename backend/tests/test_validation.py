"""Tests for validation.py: turning raw query values into SearchParams.

Covers defaults, valid parsing, blank handling, every invalid-input rule from
the brief (minPrice > maxPrice, pageSize <= 0, non-numeric values, ...), and
that all errors are reported together in one response.
"""

from datetime import date

import pytest

from app.validation import MAX_PAGE_SIZE, InvalidSearchParams, parse_keywords, parse_search_params


def parse(**params):
    return parse_search_params({k: [v] for k, v in params.items()})


def errors_for(**params) -> dict[str, str]:
    with pytest.raises(InvalidSearchParams) as exc:
        parse(**params)
    return {e.field: e.message for e in exc.value.errors}


def test_defaults():
    p = parse_search_params({})
    assert p.page == 1
    assert p.page_size == 10
    assert p.statuses == frozenset({"active"})
    assert p.keywords == ()
    assert p.target_budget is None


def test_valid_values_are_parsed():
    p = parse(
        minPrice="400000",
        maxPrice="500000",
        minBedrooms="2",
        city=" Springfield ",
        keyword="Pool",
        targetBudget="450000",
        status="active,pending",
        page="2",
        pageSize="5",
        asOf="2026-09-01",
    )
    assert (p.min_price, p.max_price, p.min_bedrooms) == (400000, 500000, 2)
    assert p.city == "Springfield"
    assert p.keywords == ("pool",)
    assert p.statuses == {"active", "pending"}
    assert (p.page, p.page_size) == (2, 5)
    assert p.as_of == date(2026, 9, 1)


def test_blank_values_are_treated_as_absent():
    p = parse(minPrice="", city="   ", keyword="")
    assert p.min_price is None and p.city is None and p.keywords == ()


def test_min_price_greater_than_max_price():
    errs = errors_for(minPrice="600000", maxPrice="500000")
    assert "minPrice" in errs and "greater than maxPrice" in errs["minPrice"]


def test_equal_min_and_max_price_is_allowed():
    p = parse(minPrice="500000", maxPrice="500000")
    assert p.min_price == p.max_price == 500000


@pytest.mark.parametrize("size", ["0", "-1", "-50"])
def test_page_size_zero_or_less_rejected(size):
    assert "pageSize" in errors_for(pageSize=size)


def test_page_size_above_max_rejected():
    assert "pageSize" in errors_for(pageSize=str(MAX_PAGE_SIZE + 1))


def test_page_size_at_max_allowed():
    assert parse(pageSize=str(MAX_PAGE_SIZE)).page_size == MAX_PAGE_SIZE


@pytest.mark.parametrize("page", ["0", "-1"])
def test_page_below_one_rejected(page):
    assert "page" in errors_for(page=page)


@pytest.mark.parametrize(
    "field,value",
    [
        ("minPrice", "abc"),
        ("minPrice", "-1"),
        ("maxPrice", "nan"),
        ("maxPrice", "inf"),
        ("minBedrooms", "2.5"),
        ("minBedrooms", "-1"),
        ("targetBudget", "0"),
        ("targetBudget", "-100"),
        ("page", "1.5"),
        ("asOf", "09/01/2026"),
        ("status", "foreclosed"),
    ],
)
def test_invalid_values_rejected(field, value):
    assert field in errors_for(**{field: value})


def test_all_errors_reported_together():
    errs = errors_for(minPrice="x", pageSize="0", status="bogus")
    assert set(errs) == {"minPrice", "pageSize", "status"}


def test_unknown_parameter_rejected():
    # Catches typos like minprice that would otherwise be silently ignored.
    assert "minprice" in errors_for(minprice="100")


def test_repeated_parameter_rejected():
    with pytest.raises(InvalidSearchParams) as exc:
        parse_search_params({"page": ["1", "2"]})
    assert exc.value.errors[0].field == "page"


def test_overlong_text_rejected():
    assert "keyword" in errors_for(keyword="a" * 500)


def test_keywords_split_lowercased_and_deduplicated():
    assert parse_keywords(" Pool, garage ,, POOL, community  pool ") == ("pool", "garage", "community pool")


def test_sort_defaults_to_relevance():
    assert parse_search_params({}).sort == "relevance"


@pytest.mark.parametrize("value", ["relevance", "newest", "price_asc", "price_desc", "sqft_desc", " PRICE_ASC "])
def test_sort_accepts_every_option_case_insensitively(value):
    assert parse(sort=value).sort == value.strip().lower()


def test_blank_sort_means_default():
    assert parse(sort="  ").sort == "relevance"


def test_unknown_sort_rejected_with_the_options_listed():
    message = errors_for(sort="price")["sort"]
    assert "price_asc" in message and "relevance" in message
