"""The bundled sample source: reads the JSON feed file, and reports a broken one."""

from __future__ import annotations

import pytest

from app.sources.sample import SampleSource


def test_sample_source_reads_the_bundled_file():
    result = SampleSource().load()
    assert (result.name, result.state, len(result.records)) == ("sample", "ok", 12)


@pytest.mark.parametrize(
    ("content", "message"), [(None, "FileNotFoundError"), ("{bad", "JSONDecodeError"), ('{"a": 1}', "JSON list")]
)
def test_sample_source_reports_a_broken_file(tmp_path, content, message):
    path = tmp_path / "feed.json"
    if content is not None:
        path.write_text(content)
    result = SampleSource(path).load()
    assert result.state == "unavailable" and message in result.error
