"""Tests for scoring.py: budget fit, recency decay and the combined score.

Each test pins one property of the formula (symmetry, linear fall-off,
half-life, weighting, 0..1 range), so a change to the formula shows exactly
which behavior it altered.
"""

from datetime import date, timedelta

import pytest

from app.dedupe import merge_listings
from app.scoring import (
    BUDGET_WEIGHT,
    RECENCY_HALF_LIFE_DAYS,
    RECENCY_WEIGHT,
    budget_fit,
    recency,
    score_listing,
)
from tests.conftest import TODAY, make_listing


def one(**overrides):
    [m] = merge_listings([make_listing(**overrides)])
    return m


def test_budget_fit_is_one_at_target():
    assert budget_fit(500_000, 500_000) == 1.0


def test_budget_fit_is_symmetric_over_and_under():
    assert budget_fit(450_000, 500_000) == pytest.approx(budget_fit(550_000, 500_000))


def test_budget_fit_falls_off_linearly_and_clamps_at_zero():
    assert budget_fit(550_000, 500_000) == pytest.approx(0.6)  # 10% away
    assert budget_fit(625_000, 500_000) == 0.0  # 25% away
    assert budget_fit(2_000_000, 500_000) == 0.0


def test_budget_fit_is_relative_to_price_level():
    assert budget_fit(330_000, 300_000) == pytest.approx(budget_fit(3_300_000, 3_000_000))


def test_recency_half_life():
    assert recency(0) == 1.0
    assert recency(int(RECENCY_HALF_LIFE_DAYS)) == pytest.approx(0.5)
    assert recency(int(RECENCY_HALF_LIFE_DAYS * 2)) == pytest.approx(0.25)


def test_future_listed_date_counts_as_new():
    _, breakdown = score_listing(one(listed_date=TODAY + timedelta(days=3)), None, TODAY)
    assert breakdown.days_on_market == 0 and breakdown.recency == 1.0


def test_score_without_budget_is_recency_only():
    score, breakdown = score_listing(one(listed_date=TODAY - timedelta(days=30)), None, TODAY)
    assert breakdown.budget is None
    assert score == pytest.approx(0.5)


def test_score_combines_weights():
    m = one(price=550_000, listed_date=TODAY - timedelta(days=30))
    score, _ = score_listing(m, 500_000, TODAY)
    assert score == pytest.approx(BUDGET_WEIGHT * 0.6 + RECENCY_WEIGHT * 0.5)


def test_closer_to_budget_beats_newer_when_budget_gap_is_large():
    on_budget_older = one(id="A", address="1 A St", price=500_000, listed_date=TODAY - timedelta(days=20))
    off_budget_new = one(id="B", address="2 B St", price=600_000, listed_date=TODAY)
    a, _ = score_listing(on_budget_older, 500_000, TODAY)
    b, _ = score_listing(off_budget_new, 500_000, TODAY)
    assert a > b


def test_newer_wins_when_budget_fit_is_equal():
    old = one(price=500_000, listed_date=TODAY - timedelta(days=40))
    new = one(price=500_000, listed_date=TODAY - timedelta(days=5))
    assert score_listing(new, 500_000, TODAY)[0] > score_listing(old, 500_000, TODAY)[0]


def test_scores_stay_in_unit_range():
    for price in (1, 250_000, 500_000, 10_000_000):
        for age in (0, 10, 365, 5000):
            s, _ = score_listing(one(price=price, listed_date=TODAY - timedelta(days=age)), 500_000, TODAY)
            assert 0.0 <= s <= 1.0


def test_target_must_be_positive():
    with pytest.raises(ValueError):
        budget_fit(100, 0)


def test_as_of_changes_recency_not_order_of_equal_aged_items():
    m = one(listed_date=date(2026, 9, 1))
    early, _ = score_listing(m, None, date(2026, 9, 1))
    late, _ = score_listing(m, None, date(2026, 12, 1))
    assert early > late
