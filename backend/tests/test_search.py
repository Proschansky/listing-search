"""Tests for search.py: filtering, keywords, ranking, ties and pagination.

Uses the real sample data where it reads naturally, and small synthetic
listings (via make_listing) where a test needs exact control, e.g. to force
a tied score or produce 25 results for pagination boundaries.
"""

from datetime import date, timedelta

from app.dedupe import merge_listings
from app.models import SearchParams
from app.search import matches_keywords, search
from tests.conftest import TODAY, make_listing


def run(listings, **params):
    return search(listings, SearchParams(**params), today=TODAY)


def addresses(result):
    return [r.listing.address for r in result.results]


# --- filters --------------------------------------------------------------


def test_default_excludes_pending_and_sold(sample_repo):
    result = run(sample_repo.merged, page_size=100)
    assert all(r.listing.status == "active" for r in result.results)
    assert "42 Willow Way" not in addresses(result)  # the pending one
    assert result.pagination.total_results == 7


def test_status_opt_in_includes_pending(sample_repo):
    result = run(sample_repo.merged, statuses=frozenset({"active", "pending"}), page_size=100)
    assert "42 Willow Way" in addresses(result)


def test_price_range_is_inclusive(sample_repo):
    result = run(sample_repo.merged, min_price=450_000, max_price=525_000, page_size=100)
    prices = sorted(r.listing.price for r in result.results)
    assert prices == [450_000, 470_000, 525_000]


def test_min_bedrooms(sample_repo):
    result = run(sample_repo.merged, min_bedrooms=4, page_size=100)
    assert addresses(result) == ["22 Birch Ln"]


def test_city_is_case_and_whitespace_insensitive(sample_repo):
    result = run(sample_repo.merged, city="  rESTON ", page_size=100)
    assert {r.listing.city for r in result.results} == {"Reston"}
    assert result.pagination.total_results == 2


def test_combined_filters(sample_repo):
    result = run(sample_repo.merged, city="Springfield", min_bedrooms=3, max_price=600_000)
    assert addresses(result) == ["456 Oak Ave"]


# --- keyword --------------------------------------------------------------


def test_keyword_is_case_insensitive():
    assert matches_keywords("Community POOL access", ("pool",))


def test_keyword_matches_whole_words_only():
    assert not matches_keywords("New carpet throughout", ("pet",))
    assert matches_keywords("Pet friendly", ("pet",))


def test_multiple_keywords_must_all_match():
    text = "Townhome with 2-car garage, community pool."
    assert matches_keywords(text, ("garage", "pool"))
    assert not matches_keywords(text, ("garage", "fireplace"))


def test_keyword_phrase():
    assert matches_keywords("Townhome with community   pool", ("community pool",))
    assert not matches_keywords("pool in the community", ("community pool",))


def test_keyword_with_regex_characters_is_literal():
    assert not matches_keywords("anything", ("a.*",))
    assert matches_keywords("2-car garage", ("2-car",))


def test_keyword_matches_any_merged_source(sample_repo):
    # "Renovated" only appears in MLS_B's copy (B8) of 456 Oak Ave.
    result = run(sample_repo.merged, keywords=("renovated",))
    assert addresses(result) == ["456 Oak Ave"]
    assert {s.id for s in result.results[0].listing.sources} == {"A2", "B8"}


# --- no matches -----------------------------------------------------------


def test_no_matches_returns_empty_with_zero_pages(sample_repo):
    result = run(sample_repo.merged, keywords=("helipad",))
    assert result.results == []
    assert result.pagination.total_results == 0
    assert result.pagination.total_pages == 0
    assert result.warnings == []


def test_unknown_city_returns_empty_with_helpful_warning(sample_repo):
    result = run(sample_repo.merged, city="Atlantis")
    assert result.results == []
    assert "Atlantis" in result.warnings[0] and "Reston" in result.warnings[0]


def test_known_city_with_no_matches_has_no_city_warning(sample_repo):
    result = run(sample_repo.merged, city="Reston", max_price=100_000)
    assert result.results == [] and result.warnings == []


def test_empty_dataset():
    result = run([])
    assert result.results == [] and result.pagination.total_pages == 0


# --- ranking & ties -------------------------------------------------------


def test_results_sorted_by_score_desc(sample_repo):
    result = run(sample_repo.merged, target_budget=470_000, page_size=100)
    scores = [r.score for r in result.results]
    assert scores == sorted(scores, reverse=True)
    assert result.results[0].listing.address == "55 Elm Ct"


def test_tied_scores_break_by_newest_then_price_then_key():
    same_day = TODAY - timedelta(days=10)
    # Equal distance from the 500k budget (one over, one under) and equal age
    # -> identical scores; lower price wins the tie.
    over = make_listing(id="1", address="1 Over St", price=520_000, listed_date=same_day)
    under = make_listing(id="2", address="2 Under St", price=480_000, listed_date=same_day)
    result = run(merge_listings([over, under]), target_budget=500_000)
    assert result.results[0].score == result.results[1].score
    assert addresses(result) == ["2 Under St", "1 Over St"]


def test_full_tie_falls_back_to_listing_key():
    a = make_listing(id="1", address="20 B St")
    b = make_listing(id="2", address="10 A St")
    result = run(merge_listings([a, b]), target_budget=500_000)
    assert addresses(result) == ["10 A St", "20 B St"]


def test_ordering_is_identical_across_repeated_calls(sample_repo):
    first = addresses(run(sample_repo.merged, target_budget=500_000, page_size=100))
    for _ in range(5):
        assert addresses(run(sample_repo.merged, target_budget=500_000, page_size=100)) == first


def test_as_of_param_overrides_today(sample_repo):
    # Without a budget, rank is pure recency. The newest merged listing is
    # 22 Birch Ln (2026-09-03), so asOf=2026-09-04 gives it 1 day on market.
    result = search(sample_repo.merged, SearchParams(as_of=date(2026, 9, 4)), today=date(2030, 1, 1))
    top = result.results[0]
    assert top.listing.address == "22 Birch Ln"
    assert top.breakdown.days_on_market == 1


# --- pagination -----------------------------------------------------------


def _many(n):
    return merge_listings(
        [make_listing(id=str(i), address=f"{i} Test St", listed_date=TODAY - timedelta(days=i)) for i in range(n)]
    )


def test_first_page():
    result = run(_many(25), page=1, page_size=10)
    p = result.pagination
    assert len(result.results) == 10
    assert (p.total_results, p.total_pages) == (25, 3)
    assert p.to_dict()["hasPrevious"] is False and p.to_dict()["hasNext"] is True


def test_partial_last_page():
    result = run(_many(25), page=3, page_size=10)
    assert len(result.results) == 5
    assert result.pagination.to_dict()["hasNext"] is False


def test_exact_multiple_of_page_size():
    result = run(_many(20), page=2, page_size=10)
    assert len(result.results) == 10 and result.pagination.total_pages == 2


def test_page_past_end_is_empty_with_metadata_and_warning():
    result = run(_many(25), page=4, page_size=10)
    assert result.results == []
    assert result.pagination.total_pages == 3
    assert "past the last page" in result.warnings[0]


def test_pages_cover_every_result_exactly_once():
    listings = _many(23)
    seen = []
    for page in range(1, 4):
        seen += [r.listing.listing_key for r in run(listings, page=page, page_size=10).results]
    assert len(seen) == 23 == len(set(seen))


def test_page_size_one():
    result = run(_many(3), page=3, page_size=1)
    assert len(result.results) == 1 and result.pagination.total_pages == 3


# --- sort orders ------------------------------------------------------------


def _sort_fixture():
    """Three listings with distinct prices, sizes and dates."""
    return merge_listings(
        [
            make_listing(id="1", address="1 A St", price=300_000, sqft=900, listed_date=TODAY - timedelta(days=30)),
            make_listing(id="2", address="2 B St", price=700_000, sqft=2500, listed_date=TODAY - timedelta(days=1)),
            make_listing(id="3", address="3 C St", price=500_000, sqft=1800, listed_date=TODAY - timedelta(days=10)),
        ]
    )


def test_sort_newest_first():
    assert addresses(run(_sort_fixture(), sort="newest")) == ["2 B St", "3 C St", "1 A St"]


def test_sort_price_ascending_and_descending():
    assert addresses(run(_sort_fixture(), sort="price_asc")) == ["1 A St", "3 C St", "2 B St"]
    assert addresses(run(_sort_fixture(), sort="price_desc")) == ["2 B St", "3 C St", "1 A St"]


def test_sort_largest_first():
    assert addresses(run(_sort_fixture(), sort="sqft_desc")) == ["2 B St", "3 C St", "1 A St"]


def test_sorts_break_ties_by_relevance():
    # Same price: the better budget match (closer date -> higher recency) wins.
    same_price = merge_listings(
        [
            make_listing(id="1", address="1 Old St", price=500_000, listed_date=TODAY - timedelta(days=60)),
            make_listing(id="2", address="2 New St", price=500_000, listed_date=TODAY),
        ]
    )
    assert addresses(run(same_price, sort="price_asc")) == ["2 New St", "1 Old St"]


def test_sort_is_applied_before_pagination():
    page2 = run(_sort_fixture(), sort="price_asc", page=2, page_size=2)
    assert addresses(page2) == ["2 B St"]
