"""Repository loading, the safe-load fallback, readiness and key lookup."""

from __future__ import annotations

import json
import logging

import pytest

from app.repository import ListingRepository, parse_feed


def test_sample_data_loads_and_is_ready(sample_repo):
    assert sample_repo.ready
    assert sample_repo.load_error is None
    assert len(sample_repo.raw) == 12 and len(sample_repo.merged) == 8


def test_get_finds_a_listing_by_key_or_returns_none(sample_repo):
    first = sample_repo.merged[0]
    assert sample_repo.get(first.listing_key) is first
    assert sample_repo.get("no-such-key") is None


def test_load_safely_turns_a_missing_file_into_an_empty_unready_repo(tmp_path, caplog):
    with caplog.at_level(logging.ERROR):
        repo = ListingRepository.load_safely(tmp_path / "missing.json")
    assert not repo.ready
    assert repo.merged == []
    assert repo.load_error.startswith("FileNotFoundError")
    assert "Could not load listings" in caplog.text


@pytest.mark.parametrize("content", ["{not json", '{"a": 1}'])
def test_load_safely_handles_corrupt_or_wrongly_shaped_files(tmp_path, content):
    path = tmp_path / "bad.json"
    path.write_text(content)
    repo = ListingRepository.load_safely(path)
    assert not repo.ready and repo.load_error


def test_from_file_still_raises_for_callers_that_want_to_fail(tmp_path):
    path = tmp_path / "bad.json"
    path.write_text("[")
    with pytest.raises(ValueError):
        ListingRepository.from_file(path)


def test_skipped_records_are_counted(tmp_path, sample_repo):
    from app.repository import DEFAULT_DATA_PATH

    records = json.loads(DEFAULT_DATA_PATH.read_text())
    records.append({"id": "BAD"})
    path = tmp_path / "feed.json"
    path.write_text(json.dumps(records))
    repo = ListingRepository.from_file(path)
    assert repo.skipped == 1 and repo.ready


def test_an_empty_feed_is_not_ready():
    assert not ListingRepository(parse_feed([])[0]).ready
