"""Tests for dedupe.py: address normalization and cross-feed merging.

Checks that format variants match (St/Street, Apt/Unit/#), that different
units, cities or far-apart coordinates do NOT merge, and the merge rules
(freshest record for display, earliest listedDate, all descriptions searchable).
"""

from datetime import date

import pytest

from app.dedupe import merge_listings, normalize_address
from tests.conftest import make_listing


@pytest.mark.parametrize(
    "a,b",
    [
        ("123 Main St, Apt 4B", "123 Main Street, Unit 4B"),
        ("456 Oak Ave", "456 Oak Avenue"),
        ("55 Elm Ct", "55 Elm Court"),
        ("9 First St #2", "9 First Street Suite 2"),
        ("10 N. Lake Dr.", "10 North Lake Drive"),
    ],
)
def test_equivalent_addresses_normalize_the_same(a, b):
    assert normalize_address(a) == normalize_address(b)


def test_different_units_do_not_match():
    assert normalize_address("123 Main St Apt 4B") != normalize_address("123 Main St Apt 5B")


def test_sample_data_merges_four_cross_feed_duplicates(sample_repo):
    assert len(sample_repo.raw) == 12
    assert len(sample_repo.merged) == 8
    groups = {tuple(s.id for s in m.sources) for m in sample_repo.merged if len(m.sources) > 1}
    assert groups == {("A1", "B7"), ("A2", "B8"), ("A3", "B9"), ("A5", "B11")}


def test_zip_disagreement_does_not_block_merge(sample_repo):
    oak = next(m for m in sample_repo.merged if "oak" in m.listing_key)
    assert {s.id for s in oak.sources} == {"A2", "B8"}


def test_primary_is_freshest_record_and_listed_date_is_earliest():
    older = make_listing(id="B1", source="MLS_B", address="1 Test Street", price=510_000, listed_date=date(2026, 8, 1))
    newer = make_listing(id="A1", source="MLS_A", address="1 Test St", price=500_000, listed_date=date(2026, 8, 20))
    [m] = merge_listings([older, newer])
    assert m.price == 500_000  # from the freshest record
    assert m.address == "1 Test St"
    assert m.listed_date == date(2026, 8, 1)  # true time on market
    assert [s.source for s in m.sources] == ["MLS_A", "MLS_B"]


def test_search_text_covers_every_source_description():
    a = make_listing(id="A1", source="MLS_A", description="Community pool.")
    b = make_listing(id="B1", source="MLS_B", description="Two-car garage.")
    [m] = merge_listings([a, b])
    assert "pool" in m.search_text and "garage" in m.search_text


def test_same_address_far_apart_is_not_merged():
    a = make_listing(id="A1", latitude=38.80, longitude=-77.20)
    b = make_listing(id="B1", source="MLS_B", latitude=38.90, longitude=-77.40)  # ~20 km away
    merged = merge_listings([a, b])
    assert len(merged) == 2
    assert len({m.listing_key for m in merged}) == 2


def test_same_address_different_city_is_not_merged():
    a = make_listing(id="A1", city="Springfield")
    b = make_listing(id="B1", source="MLS_B", city="Fairfax")
    assert len(merge_listings([a, b])) == 2


def test_listing_keys_are_unique_and_stable(sample_repo):
    keys = [m.listing_key for m in sample_repo.merged]
    assert len(keys) == len(set(keys))
    assert "123-main-st-unit-4b-springfield-va" in keys
