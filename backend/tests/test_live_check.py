"""``make live-check``: passes only when SimplyRETS returns usable listings.

The real download is replaced, so this never calls the internet.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.sources.base import SourceResult
from app.sources.simplyrets import SimplyRetsSource, to_feed_record
from scripts import live_check

RECORDS = [
    to_feed_record(r)
    for r in json.loads((Path(__file__).parent / "fixtures" / "simplyrets_snapshot.json").read_text())["records"]
]


def fake_load(result):
    return lambda self, **kwargs: result


def test_passes_when_listings_come_back(monkeypatch, capsys):
    monkeypatch.setattr(SimplyRetsSource, "load", fake_load(SourceResult("simplyrets", "ok", records=RECORDS)))
    assert live_check.main() == 0
    assert "3 usable listing(s)" in capsys.readouterr().out


@pytest.mark.parametrize(
    "result",
    [
        SourceResult("simplyrets", "unavailable", error="ConnectError: refused"),
        SourceResult("simplyrets", "ok", records=[{"id": "bad"}]),
    ],
)
def test_fails_when_nothing_usable_comes_back(monkeypatch, capsys, result):
    monkeypatch.setattr(SimplyRetsSource, "load", fake_load(result))
    assert live_check.main() == 1
    out = capsys.readouterr().out
    assert "FAIL" in out
