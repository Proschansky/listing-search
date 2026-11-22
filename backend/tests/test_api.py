"""End-to-end through HTTP: wiring, status codes and response shape."""


def test_health(client):
    body = client.get("/api/health").json()
    assert body == {"status": "ok", "listings": 8, "rawRecords": 12}


def test_meta_lists_cities(client):
    body = client.get("/api/meta").json()
    assert "Springfield" in body["cities"] and body["statuses"] == ["active", "pending", "sold"]


def test_search_response_shape(client):
    res = client.get("/api/listings", params={"targetBudget": 470000, "pageSize": 3, "asOf": "2026-09-05"})
    assert res.status_code == 200
    body = res.json()
    assert set(body) == {"results", "pagination", "warnings"}
    first = body["results"][0]
    for key in ("listingKey", "address", "price", "bedrooms", "relevanceScore", "scoreBreakdown", "sources"):
        assert key in first
    assert body["pagination"] == {
        "page": 1,
        "pageSize": 3,
        "totalResults": 7,
        "totalPages": 3,
        "hasPrevious": False,
        "hasNext": True,
    }


def test_invalid_input_returns_400_with_all_field_errors(client):
    res = client.get("/api/listings", params={"minPrice": 600000, "maxPrice": 500000, "pageSize": 0})
    assert res.status_code == 400
    error = res.json()["error"]
    assert error["code"] == "INVALID_PARAMETERS"
    assert {d["field"] for d in error["details"]} == {"minPrice", "pageSize"}


def test_non_numeric_returns_400_not_422(client):
    res = client.get("/api/listings", params={"minBedrooms": "three"})
    assert res.status_code == 400


def test_unknown_city_is_200_with_warning(client):
    res = client.get("/api/listings", params={"city": "Atlantis"})
    assert res.status_code == 200
    body = res.json()
    assert body["results"] == [] and body["warnings"]


def test_page_past_end_is_200(client):
    res = client.get("/api/listings", params={"page": 99})
    assert res.status_code == 200
    assert res.json()["results"] == []


def test_duplicates_returned_once_with_both_sources(client):
    body = client.get("/api/listings", params={"city": "Springfield", "pageSize": 100}).json()
    assert len(body["results"]) == 2
    main = next(r for r in body["results"] if "Main" in r["address"])
    assert [s["source"] for s in main["sources"]] == ["MLS_A", "MLS_B"]


# --- v1 routes, health probes, detail endpoint, sorting, error shapes --------

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402
from app.repository import ListingRepository  # noqa: E402


@pytest.mark.parametrize("path", ["/api/v1/listings", "/api/listings"])
def test_v1_and_legacy_paths_return_the_same_results(client, path):
    assert (
        client.get(path, params={"asOf": "2026-09-05"}).json()
        == client.get("/api/v1/listings", params={"asOf": "2026-09-05"}).json()
    )


def test_liveness_is_always_ok(client):
    assert client.get("/api/v1/health/live").json() == {"status": "ok"}


def test_readiness_reports_data_checks(client):
    res = client.get("/api/v1/health/ready")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["checks"]["data"] == {
        "ok": True,
        "listings": 8,
        "rawRecords": 12,
        "skippedRecords": 0,
        "error": None,
    }


def test_service_starts_and_reports_unready_when_data_is_broken(tmp_path):
    settings = Settings(listings_path=tmp_path / "missing.json", rate_limit_enabled=False)
    client = TestClient(create_app(settings=settings))
    ready = client.get("/api/v1/health/ready")
    assert ready.status_code == 503
    assert ready.json()["checks"]["data"]["error"].startswith("FileNotFoundError")
    assert client.get("/api/v1/health/live").status_code == 200
    assert client.get("/api/health").json()["status"] == "degraded"
    # Searches still answer (empty), rather than erroring.
    assert client.get("/api/v1/listings").json()["results"] == []


def test_meta_lists_sort_options(client):
    assert client.get("/api/v1/meta").json()["sortOptions"] == [
        "relevance",
        "newest",
        "price_asc",
        "price_desc",
        "sqft_desc",
    ]


def test_sort_by_price_ascending(client):
    prices = [
        r["price"]
        for r in client.get("/api/v1/listings", params={"sort": "price_asc", "status": "active,pending,sold"}).json()[
            "results"
        ]
    ]
    assert prices == sorted(prices)


def test_invalid_sort_is_a_field_error(client):
    res = client.get("/api/v1/listings", params={"sort": "price"})
    assert res.status_code == 400
    assert res.json()["error"]["details"][0]["field"] == "sort"


def test_listing_detail_matches_its_search_result(client):
    params = {"targetBudget": 470000, "asOf": "2026-09-05"}
    first = client.get("/api/v1/listings", params=params).json()["results"][0]
    detail = client.get(f"/api/v1/listings/{first['listingKey']}", params=params)
    assert detail.status_code == 200
    assert detail.json() == first


def test_listing_detail_without_params_scores_by_recency_only(client, sample_repo):
    key = sample_repo.merged[0].listing_key
    body = client.get(f"/api/v1/listings/{key}").json()
    assert body["scoreBreakdown"]["budget"] is None


def test_unknown_listing_is_404_in_the_error_shape(client):
    res = client.get("/api/v1/listings/nope")
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "NOT_FOUND"
    assert "nope" in res.json()["error"]["message"]


def test_listing_detail_rejects_search_only_params(client, sample_repo):
    key = sample_repo.merged[0].listing_key
    res = client.get(f"/api/v1/listings/{key}", params={"page": 2})
    assert res.status_code == 400
    assert res.json()["error"]["details"][0]["field"] == "page"


def test_listing_detail_validates_its_params(client, sample_repo):
    key = sample_repo.merged[0].listing_key
    assert client.get(f"/api/v1/listings/{key}", params={"targetBudget": -1}).status_code == 400


def test_unknown_route_is_404_in_the_error_shape(client):
    res = client.get("/api/v1/nope")
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "NOT_FOUND"


def test_wrong_method_is_405_in_the_error_shape(client):
    res = client.post("/api/v1/listings")
    assert res.status_code == 405
    assert res.json()["error"]["code"] == "METHOD_NOT_ALLOWED"


def test_production_hides_interactive_docs(sample_repo):
    client = TestClient(create_app(sample_repo, Settings(environment="production", rate_limit_enabled=False)))
    assert client.get("/docs").status_code == 404
    assert client.get("/openapi.json").status_code == 404


def test_create_app_loads_the_configured_file(tmp_path):
    import json

    from app.repository import DEFAULT_DATA_PATH

    records = json.loads(DEFAULT_DATA_PATH.read_text())[:2]
    path = tmp_path / "two.json"
    path.write_text(json.dumps(records))
    client = TestClient(create_app(settings=Settings(listings_path=path, rate_limit_enabled=False)))
    assert client.get("/api/v1/health/ready").json()["checks"]["data"]["rawRecords"] == 2
    assert isinstance(client.app.state.store.current, ListingRepository)
