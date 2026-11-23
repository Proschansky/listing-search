"""Sources together: from_sources, the store, refreshing, and the app with SimplyRETS on."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.repository import ListingRepository
from app.sources.base import SourceResult
from app.sources.sample import SampleSource
from app.sources.simplyrets import SimplyRetsSource
from app.store import RepositoryStore, build_sources, needs_refresh, refresh, refresh_forever

SNAPSHOT = Path(__file__).parent / "fixtures" / "simplyrets_snapshot.json"


class StubSource:
    """A source that returns whatever result a test hands it."""

    def __init__(self, result: SourceResult, *, required: bool = False):
        self.name = result.name
        self.required = required
        self.result = result
        self.calls: list[bool] = []

    def load(self, *, allow_network: bool = True) -> SourceResult:
        self.calls.append(allow_network)
        return self.result


def simplyrets_records():
    from app.sources.simplyrets import to_feed_record

    return [to_feed_record(r) for r in json.loads(SNAPSHOT.read_text())["records"]]


# --- from_sources ---------------------------------------------------------------------


def test_from_sources_merges_all_sources_and_reports_each():
    sr = StubSource(SourceResult("simplyrets", "ok", records=simplyrets_records(), skipped=1))
    repo = ListingRepository.from_sources([SampleSource(), sr])
    assert repo.ready and len(repo.raw) == 15 and len(repo.merged) == 11
    assert repo.source_status["sample"]["status"] == "ok"
    assert repo.source_status["simplyrets"] == {
        "status": "ok",
        "listings": 3,
        "skippedRecords": 1,
        "fetchedAt": None,
        "error": None,
    }
    assert repo.skipped == 1


def test_from_sources_counts_invalid_records_per_source():
    bad = {"id": "X", "source": "SIMPLYRETS"}  # missing every other field
    repo = ListingRepository.from_sources(
        [StubSource(SourceResult("simplyrets", "ok", records=[*simplyrets_records(), bad]))]
    )
    assert repo.source_status["simplyrets"]["skippedRecords"] == 1
    assert repo.source_status["simplyrets"]["listings"] == 3


def test_an_optional_source_failing_leaves_the_service_ready():
    down = StubSource(SourceResult("simplyrets", "unavailable", error="refused", detail={"breaker": "open"}))
    repo = ListingRepository.from_sources([SampleSource(), down])
    assert repo.ready and repo.load_error is None
    assert repo.source_status["simplyrets"] == {
        "status": "unavailable",
        "listings": 0,
        "skippedRecords": 0,
        "fetchedAt": None,
        "error": "refused",
        "breaker": "open",
    }


def test_a_required_source_failing_makes_the_service_unready(tmp_path):
    repo = ListingRepository.from_sources([SampleSource(tmp_path / "missing.json")])
    assert not repo.ready and "FileNotFoundError" in repo.load_error


def test_from_sources_passes_allow_network_through():
    stub = StubSource(SourceResult("simplyrets", "ok"))
    ListingRepository.from_sources([stub], allow_network=False)
    assert stub.calls == [False]


# --- Store and refresh -------------------------------------------------------------


def test_store_swaps_in_a_ready_repository_and_keeps_the_old_one_otherwise():
    first = ListingRepository.from_sources([SampleSource()])
    store = RepositoryStore(first)
    assert not store.replace(ListingRepository([]))
    assert store.current is first
    second = ListingRepository.from_sources([SampleSource()])
    assert store.replace(second) and store.current is second


def test_refresh_reloads_every_source():
    store = RepositoryStore(ListingRepository([]))
    assert refresh(store, [SampleSource()])
    assert len(store.current.merged) == 8


def test_refresh_forever_survives_a_failing_refresh_and_keeps_going():
    calls = []

    class Exploding:
        name, required = "boom", False

        def load(self, *, allow_network=True):
            calls.append(1)
            raise RuntimeError("bug")

    async def run():
        task = asyncio.create_task(refresh_forever(RepositoryStore(ListingRepository([])), [Exploding()], 0.01))
        await asyncio.sleep(0.2)
        task.cancel()

    asyncio.run(run())
    assert len(calls) >= 2


def test_build_sources_follows_the_settings(tmp_path):
    settings = Settings(sources=["simplyrets", "sample"], simplyrets_cache_path=tmp_path / "c.json", _env_file=None)
    sources = build_sources(settings)
    assert [s.name for s in sources] == ["simplyrets", "sample"]
    assert isinstance(sources[0], SimplyRetsSource) and needs_refresh(sources)
    assert not needs_refresh(build_sources(Settings(_env_file=None)))


# --- The app with SimplyRETS configured -------------------------------------------------


def offline_settings(tmp_path, *, snapshot: bool) -> Settings:
    cache = tmp_path / "simplyrets.json"
    if snapshot:
        cache.write_text(SNAPSHOT.read_text())
    return Settings(
        sources=["sample", "simplyrets"],
        simplyrets_url="http://127.0.0.1:9/unreachable",
        simplyrets_cache_path=cache,
        simplyrets_timeout_seconds=0.2,
        rate_limit_enabled=False,
        _env_file=None,
    )


def test_app_starts_on_the_snapshot_without_calling_simplyrets(tmp_path):
    client = TestClient(create_app(settings=offline_settings(tmp_path, snapshot=True)))
    ready = client.get("/api/v1/health/ready").json()
    assert ready["status"] == "ok"
    sr = ready["checks"]["sources"]["simplyrets"]
    assert (sr["status"], sr["listings"], sr["error"]) == ("degraded", 3, "waiting for the first download")
    houston = client.get("/api/v1/listings", params={"city": "Houston", "status": "active,pending,sold"}).json()
    assert {r["sources"][0]["source"] for r in houston["results"]} == {"SIMPLYRETS"}
    assert all(r["photos"] for r in houston["results"])


def test_app_reports_simplyrets_unavailable_with_no_snapshot(tmp_path):
    client = TestClient(create_app(settings=offline_settings(tmp_path, snapshot=False)))
    ready = client.get("/api/v1/health/ready")
    assert ready.status_code == 200
    assert ready.json()["checks"]["sources"]["simplyrets"]["status"] == "unavailable"


def test_lifespan_refreshes_and_stops_cleanly(tmp_path):
    # Entering the TestClient runs the lifespan: the first refresh tries the
    # (unreachable) API, keeps the snapshot, and the task is cancelled on exit.
    settings = offline_settings(tmp_path, snapshot=True)
    with TestClient(create_app(settings=settings)) as client:
        for _ in range(100):
            sr = client.get("/api/v1/health/ready").json()["checks"]["sources"]["simplyrets"]
            if sr["error"] != "waiting for the first download":
                break
            asyncio.run(asyncio.sleep(0.05))
        assert sr["status"] == "degraded" and sr["listings"] == 3
        assert sr["error"] != "waiting for the first download"
