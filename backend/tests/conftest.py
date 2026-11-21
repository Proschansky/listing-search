"""Shared test fixtures and helpers.

* TODAY        - a fixed date so recency scores never depend on the real clock.
* make_listing - build a raw Listing, overriding only the fields a test cares about.
* sample_repo  - the real sample data, loaded once per test session.
* client       - an HTTP test client wired to the sample data (rate limiting off).
"""

from __future__ import annotations

from datetime import date

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.dedupe import merge_listings
from app.main import create_app
from app.models import Listing
from app.repository import ListingRepository

TODAY = date(2026, 9, 5)  # fixed "now" so recency is deterministic


def make_listing(**overrides) -> Listing:
    """Build a raw listing with sensible defaults; override only what a test cares about."""
    base = dict(
        id="X1",
        source="MLS_A",
        address="1 Test St",
        city="Springfield",
        state="VA",
        zip="22150",
        price=500_000.0,
        bedrooms=3,
        bathrooms=2.0,
        sqft=1500,
        latitude=38.80,
        longitude=-77.20,
        listed_date=TODAY,
        status="active",
        description="Nice home.",
    )
    base.update(overrides)
    return Listing(**base)


def merged(*listings: Listing):
    return merge_listings(list(listings))


@pytest.fixture(scope="session")
def sample_repo() -> ListingRepository:
    return ListingRepository.from_file()


# Settings for the shared client. Rate limiting is off because the whole
# suite shares one client (and one IP); test_middleware.py tests the limiter
# with its own apps.
TEST_SETTINGS = Settings(environment="test", rate_limit_enabled=False, _env_file=None)


@pytest.fixture(scope="session")
def client(sample_repo) -> TestClient:
    return TestClient(create_app(sample_repo, TEST_SETTINGS))
