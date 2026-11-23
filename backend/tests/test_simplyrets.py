"""SimplyRETS source: mapping, paging, and what ``load`` returns when things fail.

HTTP calls go to an ``httpx.MockTransport``, so nothing here touches the
internet. The fixture records are hand-written in SimplyRETS's format.
"""

from __future__ import annotations

import copy
import json
import logging
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest

from app.models import Listing
from app.sources.resilience import CircuitBreaker, SnapshotCache
from app.sources.simplyrets import (
    MAX_PAGES,
    SOURCE_NAME,
    SimplyRetsSource,
    fetch_all,
    to_feed_record,
)

FIXTURE = Path(__file__).parent / "fixtures" / "simplyrets_snapshot.json"
RECORDS = json.loads(FIXTURE.read_text())["records"]
NOW = datetime(2026, 9, 5, 12, 0, tzinfo=timezone.utc)
URL = "https://api.example.com/properties"
SECRET = "demo-secret"  # noqa: S105 - a fake password; the log test checks it never appears


def raw(**overrides):
    """The first fixture record, with nested overrides like property={"bedrooms": 5}."""
    record = copy.deepcopy(RECORDS[0])
    for key, value in overrides.items():
        if isinstance(value, dict) and isinstance(record.get(key), dict):
            record[key].update(value)
        else:
            record[key] = value
    return record


# --- Mapping -----------------------------------------------------------------


def test_maps_every_field_into_the_feed_format():
    assert to_feed_record(raw()) == {
        "id": "9001",
        "source": SOURCE_NAME,
        "address": "1200 Bayou Bend Dr",
        "city": "Houston",
        "state": "TX",
        "zip": "77002",
        "price": 485000,
        "bedrooms": 3,
        "bathrooms": 2.5,
        "sqft": 1850,
        "latitude": 29.7604,
        "longitude": -95.3698,
        "listedDate": "2026-08-20",
        "status": "active",
        "description": "Two-story home near the bayou trail, covered patio.",
        "photos": [f"https://photos.example.com/simplyrets/9001/{i}.jpg" for i in (1, 2, 3)],
    }


def test_every_fixture_record_maps_and_validates():
    listings = [Listing.from_dict(to_feed_record(r)) for r in RECORDS]
    assert [x.status for x in listings] == ["active", "pending", "sold"]
    assert all(x.state == "TX" and x.source == SOURCE_NAME and x.photos for x in listings)


@pytest.mark.parametrize(
    ("status", "expected"),
    [("Active", "active"), ("ActiveUnderContract", "pending"), ("Pending", "pending"), ("Closed", "sold")],
)
def test_maps_statuses(status, expected):
    assert to_feed_record(raw(mls={"status": status}))["status"] == expected


@pytest.mark.parametrize("status", ["Withdrawn", "Expired", "Hold", None])
def test_skips_statuses_the_app_does_not_show(status):
    assert to_feed_record(raw(mls={"status": status})) is None


@pytest.mark.parametrize(("state", "code"), [("Texas", "TX"), ("New York", "NY"), ("tx", "TX"), (" Virginia ", "VA")])
def test_converts_state_names_to_codes(state, code):
    assert to_feed_record(raw(address={"state": state}))["state"] == code


def test_skips_an_unknown_state():
    assert to_feed_record(raw(address={"state": "Atlantis"})) is None


@pytest.mark.parametrize(
    ("prop", "baths"),
    [
        ({"bathrooms": 3.5}, 3.5),  # SimplyRETS's own total wins
        ({"bathrooms": None, "bathsFull": 2, "bathsHalf": 1}, 2.5),
        ({"bathrooms": None, "bathsFull": 1, "bathsHalf": 0, "bathsThreeQuarter": 1}, 1.75),
    ],
)
def test_totals_bathrooms(prop, baths):
    assert to_feed_record(raw(property=prop))["bathrooms"] == baths


def test_skips_a_listing_with_no_bathroom_counts():
    assert to_feed_record(raw(property={"bathrooms": None, "bathsFull": None, "bathsHalf": None})) is None


@pytest.mark.parametrize("missing", ["mlsId", "listPrice", "listDate"])
def test_skips_a_listing_missing_a_required_field(missing):
    record = raw()
    del record[missing]
    assert to_feed_record(record) is None


def test_skips_a_listing_with_fields_of_the_wrong_type():
    assert to_feed_record(raw(address="1200 Bayou Bend Dr")) is None


def test_skips_a_listing_with_a_nonnumeric_bathroom_count():
    assert to_feed_record(raw(property={"bathrooms": "two"})) is None


def test_defaults_optional_fields():
    record = to_feed_record(raw(remarks=None, photos=None, address={"postalCode": None}))
    assert (record["description"], record["photos"], record["zip"]) == ("", [], "")


# --- Fetching pages ------------------------------------------------------------


def transport(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_fetch_all_asks_for_every_status_and_follows_next_links():
    seen = []

    def handler(request):
        seen.append(request.url)
        if "offset" not in str(request.url):
            return httpx.Response(200, json=RECORDS[:2], headers={"Link": f'<{URL}?offset=2&limit=500>; rel="next"'})
        return httpx.Response(200, json=RECORDS[2:])

    assert fetch_all(transport(handler), URL) == RECORDS
    first = seen[0]
    assert first.params.get_list("status") == ["Active", "ActiveUnderContract", "Pending", "Closed"]
    assert first.params["limit"] == "500"
    assert str(seen[1]) == f"{URL}?offset=2&limit=500"


def test_fetch_all_fails_rather_than_return_a_cut_off_download():
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(200, json=[], headers={"Link": f'<{URL}?again>; rel="next"'})

    with pytest.raises(ValueError, match="incomplete"):
        fetch_all(transport(handler), URL)
    assert len(calls) == MAX_PAGES


def test_fetch_all_follows_a_relative_next_link():
    seen = []

    def handler(request):
        seen.append(str(request.url))
        if len(seen) == 1:
            return httpx.Response(200, json=RECORDS[:1], headers={"Link": '</properties?offset=1>; rel="next"'})
        return httpx.Response(200, json=RECORDS[1:])

    assert fetch_all(transport(handler), URL) == RECORDS
    assert seen[1] == "https://api.example.com/properties?offset=1"


@pytest.mark.parametrize(
    "link",
    [
        "https://evil.example.net/properties?offset=1",  # another host
        "http://api.example.com/properties?offset=1",  # https down to http
        "https://api.example.com:8443/properties?offset=1",  # another port
    ],
)
def test_fetch_all_refuses_next_links_to_another_server(link):
    calls = []

    def handler(request):
        calls.append(str(request.url))
        return httpx.Response(200, json=RECORDS, headers={"Link": f'<{link}>; rel="next"'})

    with pytest.raises(ValueError, match="another server"):
        fetch_all(transport(handler), URL)
    assert len(calls) == 1  # the credentials never went to the other server


@pytest.mark.parametrize("code", [429, 500, 503])
def test_fetch_all_marks_server_trouble_as_retryable(code):
    from app.sources.resilience import RetryableError

    with pytest.raises(RetryableError, match=str(code)):
        fetch_all(transport(lambda r: httpx.Response(code)), URL)


def test_fetch_all_marks_network_errors_as_retryable():
    from app.sources.resilience import RetryableError

    def handler(request):
        raise httpx.ConnectError("refused", request=request)

    with pytest.raises(RetryableError, match="ConnectError"):
        fetch_all(transport(handler), URL)


def test_fetch_all_does_not_retry_bad_credentials():
    with pytest.raises(httpx.HTTPStatusError):
        fetch_all(transport(lambda r: httpx.Response(401)), URL)


def test_fetch_all_rejects_a_body_that_is_not_a_list():
    with pytest.raises(ValueError, match="list of listings"):
        fetch_all(transport(lambda r: httpx.Response(200, json={"error": "x"})), URL)


# --- load(): fresh data, snapshot, breaker ------------------------------------


def make_source(tmp_path, handler, *, breaker=None):
    return SimplyRetsSource(
        url=URL,
        username="demo-user",
        password=SECRET,
        timeout=1,
        cache=SnapshotCache(tmp_path / "cache.json"),
        breaker=breaker,
        transport=httpx.MockTransport(handler),
        sleep=lambda s: None,
        now=lambda: NOW,
    )


def ok(request):
    return httpx.Response(200, json=RECORDS)


def down(request):
    raise httpx.ConnectError("refused", request=request)


def test_load_returns_fresh_records_and_saves_a_snapshot(tmp_path):
    source = make_source(tmp_path, ok)
    result = source.load()
    assert (result.name, result.state, result.error) == ("simplyrets", "ok", None)
    assert len(result.records) == 3 and result.skipped == 0
    assert result.fetched_at == NOW and result.detail == {"breaker": "closed"}
    assert SnapshotCache(tmp_path / "cache.json").load() == (RECORDS, NOW)


def test_load_counts_records_it_cannot_map(tmp_path):
    bad = raw(mls={"status": "Withdrawn"})
    source = make_source(tmp_path, lambda r: httpx.Response(200, json=[*RECORDS, bad, "not a dict"]))
    result = source.load()
    assert len(result.records) == 3 and result.skipped == 2


def test_load_sends_basic_auth(tmp_path):
    seen = []
    make_source(tmp_path, lambda r: seen.append(r.headers["authorization"]) or ok(r)).load()
    assert seen and seen[0].startswith("Basic ")


def test_load_retries_brief_failures(tmp_path):
    calls = []

    def flaky(request):
        calls.append(1)
        return httpx.Response(503) if len(calls) < 3 else ok(request)

    assert make_source(tmp_path, flaky).load().state == "ok"
    assert len(calls) == 3


def test_load_falls_back_to_the_snapshot_when_the_api_is_down(tmp_path):
    make_source(tmp_path, ok).load()  # leaves a snapshot behind
    result = make_source(tmp_path, down).load()
    assert result.state == "degraded"
    assert len(result.records) == 3 and result.fetched_at == NOW
    assert "refused" in result.error


@pytest.mark.parametrize("body", [[{}], [raw(listPrice=-5)], [raw(property={"bathrooms": "two"})]])
def test_a_download_with_nothing_usable_keeps_the_last_good_snapshot(tmp_path, body):
    make_source(tmp_path, ok).load()
    result = make_source(tmp_path, lambda r: httpx.Response(200, json=body)).load()
    assert result.state == "degraded" and "none usable" in result.error
    assert len(result.records) == 3
    assert SnapshotCache(tmp_path / "cache.json").load() == (RECORDS, NOW)


def test_an_empty_download_is_accepted(tmp_path):
    result = make_source(tmp_path, lambda r: httpx.Response(200, json=[])).load()
    assert (result.state, result.records) == ("ok", [])


def test_a_bad_record_in_the_snapshot_is_skipped_not_fatal(tmp_path):
    SnapshotCache(tmp_path / "cache.json").save([*RECORDS, raw(property={"bathrooms": "two"})], NOW)
    result = make_source(tmp_path, down).load(allow_network=False)
    assert (result.state, len(result.records), result.skipped) == ("degraded", 3, 1)


def test_load_is_unavailable_with_no_snapshot(tmp_path):
    result = make_source(tmp_path, down).load()
    assert (result.state, result.records) == ("unavailable", [])
    assert result.detail == {"breaker": "closed"}


def test_load_without_network_uses_only_the_snapshot(tmp_path):
    calls = []
    source = make_source(tmp_path, lambda r: calls.append(1) or ok(r))
    assert source.load(allow_network=False).state == "unavailable"
    SnapshotCache(tmp_path / "cache.json").save(RECORDS, NOW)
    result = source.load(allow_network=False)
    assert result.state == "degraded" and result.error == "waiting for the first download"
    assert calls == []


def test_an_open_breaker_stops_calls_until_it_cools_off(tmp_path):
    now = [0.0]
    breaker = CircuitBreaker(failure_threshold=2, reset_after=60, clock=lambda: now[0])
    calls = []
    source = make_source(tmp_path, lambda r: calls.append(1) or down(r), breaker=breaker)
    source.load()
    source.load()
    tries_so_far = len(calls)
    result = source.load()
    assert len(calls) == tries_so_far  # breaker open: no call made
    assert result.detail == {"breaker": "open"} and "circuit breaker open" in result.error
    now[0] = 61
    source.load()  # half-open: one trial call
    assert len(calls) > tries_so_far


def test_a_success_closes_the_breaker(tmp_path):
    breaker = CircuitBreaker(failure_threshold=1, reset_after=0)
    make_source(tmp_path, down, breaker=breaker).load()
    assert make_source(tmp_path, ok, breaker=breaker).load().detail == {"breaker": "closed"}


def test_credentials_never_reach_the_logs(tmp_path, caplog):
    with caplog.at_level(logging.DEBUG):
        make_source(tmp_path, down).load()
        make_source(tmp_path, lambda r: httpx.Response(401)).load()
    assert SECRET not in caplog.text
    assert "SimplyRETS download failed" in caplog.text
