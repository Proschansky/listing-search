"""API contract: the OpenAPI document matches what the code actually accepts.

The search endpoint reads its query string by hand, so its parameters are
documented by hand too (``SEARCH_PARAMETERS`` in main.py). These tests fail
if the docs and the validator ever drift apart, and keep a checked-in copy
of the contract (``openapi.json``) honest so reviewers see API changes in
diffs. Regenerate it with ``python -m scripts.export_openapi``.
"""

from __future__ import annotations

import json
from pathlib import Path

from app.main import DETAIL_PARAMS, SEARCH_PARAMETERS
from app.models import SORT_OPTIONS
from app.validation import KNOWN_PARAMS

CONTRACT = Path(__file__).resolve().parent.parent / "openapi.json"


def test_documented_search_params_match_the_validator():
    assert {p["name"] for p in SEARCH_PARAMETERS} == set(KNOWN_PARAMS)


def test_documented_sort_values_match_the_code():
    sort = next(p for p in SEARCH_PARAMETERS if p["name"] == "sort")
    assert sort["schema"]["enum"] == list(SORT_OPTIONS)


def test_openapi_lists_v1_paths_only(client):
    paths = client.get("/openapi.json").json()["paths"]
    assert all(p.startswith("/api/v1/") for p in paths)
    assert {"/api/v1/listings", "/api/v1/listings/{listing_key}", "/api/v1/health/ready"} <= set(paths)


def test_openapi_documents_search_and_detail_parameters(client):
    paths = client.get("/openapi.json").json()["paths"]
    search = {p["name"] for p in paths["/api/v1/listings"]["get"]["parameters"]}
    detail = {p["name"] for p in paths["/api/v1/listings/{listing_key}"]["get"]["parameters"]}
    assert search == set(KNOWN_PARAMS)
    assert detail == DETAIL_PARAMS | {"listing_key"}


def test_checked_in_contract_is_up_to_date(client):
    live = client.get("/openapi.json").json()
    assert CONTRACT.exists(), "openapi.json missing - run: python -m scripts.export_openapi"
    assert json.loads(CONTRACT.read_text()) == live, (
        "The API changed but openapi.json wasn't regenerated. Run: python -m scripts.export_openapi"
    )
