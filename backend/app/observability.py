"""Structured logging with a request ID on every line.

The problem this solves: when several requests run at once, their log lines
interleave. Without a shared ID you can't tell which "Skipped record" or
"Unhandled error" line belongs to which request.

How it works:

1. ``RequestContextMiddleware`` (in ``middleware.py``) gives each request an
   ID - the caller's ``X-Request-ID`` header if it sent a sane one, otherwise
   a fresh UUID - and stores it in ``request_id_var``.
2. A ``contextvars.ContextVar`` is like a thread-local that also works with
   ``async``: each request sees only its own value, even when many requests
   are in flight on the same event loop.
3. ``RequestIdFilter`` copies that value onto every log record, so both
   formatters below can print it.
4. The ID is echoed back in the ``X-Request-ID`` response header and inside
   500 error bodies, so a user's bug report can be matched to server logs.

Example::

    >>> import json, logging
    >>> record = logging.LogRecord("app", logging.INFO, __file__, 1, "hello", None, None)
    >>> record.request_id = "abc"
    >>> json.loads(JsonFormatter().format(record))["request_id"]
    'abc'
"""

from __future__ import annotations

import json
import logging
import sys
from contextvars import ContextVar
from datetime import datetime, timezone

# Name given to the handler configure_logging installs, so it can find and
# replace its own handler without touching anyone else's.
_HANDLER_NAME = "listing-search"

# "-" when there's no request in progress (e.g. log lines during startup).
request_id_var: ContextVar[str] = ContextVar("request_id", default="-")

# Attributes every LogRecord has. Anything *else* on a record came from
# ``log.info("...", extra={...})`` and is added to the JSON output as a field.
_STANDARD_ATTRS = frozenset(vars(logging.LogRecord("", 0, "", 0, "", None, None))) | {
    "message",
    "asctime",
    "request_id",
}


class RequestIdFilter(logging.Filter):
    """Attach the current request's ID to every log record that passes through."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_var.get()
        return True  # never drops records; it only annotates them


class JsonFormatter(logging.Formatter):
    """One JSON object per line: timestamp, level, logger, message, request ID, extras."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            # ISO-8601 in UTC, so logs from different servers sort correctly.
            "timestamp": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "request_id": getattr(record, "request_id", "-"),
        }
        # Structured extras, e.g. log.info("request", extra={"status": 200}).
        for key, value in vars(record).items():
            if key not in _STANDARD_ATTRS:
                payload[key] = value
        # Full traceback as a string field, so one error stays one log line.
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        # default=str: never let an odd value (a date, a Path) break logging.
        return json.dumps(payload, default=str)


def configure_logging(level: str = "INFO", fmt: str = "text") -> None:
    """Install one stdout handler on the root logger with the chosen format.

    Safe to call more than once (tests build many apps): the handler this
    function installed last time is replaced rather than stacked, so lines are
    never printed twice. Handlers installed by anything else (an APM agent,
    pytest's log capture) are left alone.
    """
    handler = logging.StreamHandler(sys.stdout)
    handler.set_name(_HANDLER_NAME)
    handler.addFilter(RequestIdFilter())
    if fmt == "json":
        handler.setFormatter(JsonFormatter())
    else:
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s [%(request_id)s] %(name)s: %(message)s"))

    root = logging.getLogger()
    for existing in [h for h in root.handlers if h.get_name() == _HANDLER_NAME]:
        root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(level)

    # Uvicorn's own access log would duplicate ours (which carries the
    # request ID and duration), so quiet it down.
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
