"""Relevance scoring.

score = BUDGET_WEIGHT * budget_fit + RECENCY_WEIGHT * recency      (0..1)

budget_fit (0..1)
    Linear fall-off with distance from the target, as a fraction of it:
        1 - |price - target| / (target * BUDGET_TOLERANCE)
    clamped at 0. With a 25% tolerance, a home at the target scores 1.0,
    10% away scores 0.6, and 25%+ away scores 0. Over- and under-budget are
    treated the same: the user said "around this number", not "at most".
    Relative (not absolute dollars) so it behaves the same at $300k and $3M.

recency (0..1)
    Exponential decay on days on market with a half-life:
        0.5 ** (days_on_market / RECENCY_HALF_LIFE_DAYS)
    New today = 1.0, 30 days = 0.5, 60 days = 0.25. Smooth, never negative,
    and never hits a hard cliff the way "listed in the last N days" would.

Budget gets the larger weight because price fit is what the user asked for
explicitly; recency is a tie-breaker-plus ("fresh listings first").
When no targetBudget is given, the score is recency alone.

Scores are rounded to 4 d.p. so float noise can't create fake orderings;
ties are then broken deterministically in ``search.py``.
"""

from __future__ import annotations

from datetime import date

from .models import MergedListing, ScoreBreakdown

# --- Tunable constants -------------------------------------------------------
# Kept together at the top so they're easy to find, explain and change live.
BUDGET_WEIGHT = 0.7  # share of the score from price fit
RECENCY_WEIGHT = 0.3  # share of the score from freshness (weights sum to 1)
BUDGET_TOLERANCE = 0.25  # 25% away from target -> budget fit drops to 0
RECENCY_HALF_LIFE_DAYS = 30.0  # recency halves every 30 days on market
SCORE_PRECISION = 4  # decimal places kept, so tiny float noise can't reorder


def budget_fit(price: float, target: float) -> float:
    """How close a price is to the target budget, from 0 (far) to 1 (exact)."""
    # Guard: a zero/negative target would divide by zero or invert the maths.
    # Validation already blocks this for API calls; this protects direct use.
    if target <= 0:
        raise ValueError("target must be positive")

    # Distance from target as a fraction of the "tolerance band". E.g. with
    # target 500k and 25% tolerance the band is 125k, so a 550k home has
    # distance 50k / 125k = 0.4.
    distance = abs(price - target) / (target * BUDGET_TOLERANCE)

    # Turn distance into a score: 0 distance -> 1.0, edge of band -> 0.0.
    # max() clamps anything beyond the band at 0 rather than going negative.
    return max(0.0, 1.0 - distance)


def days_on_market(listed: date, as_of: date) -> int:
    """Whole days between the listing date and the reference date."""
    # A listing dated in the future (clock skew, bad feed) counts as brand new
    # rather than getting a recency score above 1.
    return max(0, (as_of - listed).days)


def recency(days: int) -> float:
    """Freshness from 1.0 (listed today) decaying towards 0, halving every
    RECENCY_HALF_LIFE_DAYS."""
    return 0.5 ** (days / RECENCY_HALF_LIFE_DAYS)


def score_listing(listing: MergedListing, target_budget: float | None, as_of: date) -> tuple[float, ScoreBreakdown]:
    """Score one listing for one search. Returns (total, breakdown)."""
    # Step 1: recency is always computed - every listing has a date.
    days = days_on_market(listing.listed_date, as_of)
    rec = recency(days)

    # Step 2: combine with budget fit if the user gave a target budget.
    if target_budget is None:
        # No budget given -> nothing to compare price against, so rank purely
        # by freshness. (Using 0 for budget fit instead would just scale every
        # score by 0.3 without changing the order - this is clearer.)
        total = rec
        fit = None
    else:
        fit = budget_fit(listing.price, target_budget)
        # Weighted sum; both parts are 0..1 and weights sum to 1, so the
        # total is also 0..1.
        total = BUDGET_WEIGHT * fit + RECENCY_WEIGHT * rec

    # Step 3: package the parts for display, rounded the same way as the
    # total so the numbers shown in the UI add up consistently.
    breakdown = ScoreBreakdown(
        budget=None if fit is None else round(fit, SCORE_PRECISION),
        recency=round(rec, SCORE_PRECISION),
        days_on_market=days,
    )

    # Step 4: round the total so two listings that are "really" tied compare
    # as equal and fall through to the deterministic tie-breakers.
    return round(total, SCORE_PRECISION), breakdown
