"""Structured logging: JSON lines and request-ID tagging."""

from __future__ import annotations

import json
import logging

from app.observability import JsonFormatter, RequestIdFilter, configure_logging, request_id_var


def _record(msg="hello", **extra):
    record = logging.LogRecord("app.test", logging.INFO, __file__, 1, msg, None, None)
    for key, value in extra.items():
        setattr(record, key, value)
    return record


def test_filter_tags_records_with_the_current_request_id():
    token = request_id_var.set("abc")
    try:
        record = _record()
        assert RequestIdFilter().filter(record) is True
        assert record.request_id == "abc"
    finally:
        request_id_var.reset(token)


def test_filter_uses_a_dash_outside_a_request():
    record = _record()
    RequestIdFilter().filter(record)
    assert record.request_id == "-"


def test_json_formatter_emits_one_object_with_core_fields_and_extras():
    line = JsonFormatter().format(_record("got %s", request_id="r1", status=200, args=None))
    data = json.loads(line)
    assert data["level"] == "INFO"
    assert data["logger"] == "app.test"
    assert data["request_id"] == "r1"
    assert data["status"] == 200
    assert data["timestamp"].endswith("+00:00")


def test_json_formatter_keeps_tracebacks_on_one_line():
    try:
        raise ValueError("bad")
    except ValueError:
        import sys

        record = _record(exc_info=sys.exc_info())
    line = JsonFormatter().format(record)
    assert "\n" not in line
    assert "ValueError: bad" in json.loads(line)["exception"]


def test_json_formatter_survives_unserialisable_extras():
    from pathlib import Path

    assert json.loads(JsonFormatter().format(_record(path=Path("/x"))))["path"] == "/x"


def _ours():
    return [h for h in logging.getLogger().handlers if h.get_name() == "listing-search"]


def test_configure_logging_replaces_its_own_handler_instead_of_stacking():
    configure_logging("INFO", "json")
    configure_logging("DEBUG", "text")
    assert len(_ours()) == 1
    assert logging.getLogger().level == logging.DEBUG
    assert not isinstance(_ours()[0].formatter, JsonFormatter)
    configure_logging("INFO", "json")
    assert isinstance(_ours()[0].formatter, JsonFormatter)
    configure_logging("INFO", "text")  # leave the default for other tests


def test_configure_logging_leaves_other_handlers_alone():
    other = logging.NullHandler()
    logging.getLogger().addHandler(other)
    try:
        configure_logging("INFO", "text")
        assert other in logging.getLogger().handlers
    finally:
        logging.getLogger().removeHandler(other)
