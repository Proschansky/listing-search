"""The source interface: what a SourceResult holds by default."""

from __future__ import annotations

from app.sources.base import SourceResult


def test_a_result_defaults_to_no_records_and_no_problems():
    result = SourceResult("x", "ok")
    assert (result.records, result.skipped, result.error, result.fetched_at, result.detail) == ([], 0, None, None, {})


def test_results_do_not_share_their_default_lists():
    a, b = SourceResult("a", "ok"), SourceResult("b", "ok")
    a.records.append({"id": "1"})
    assert b.records == []
