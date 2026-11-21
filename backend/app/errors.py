"""The single error envelope every failure response uses.

Shape::

    {"error": {"code": "INVALID_PARAMETERS",      # stable, machine-readable
               "message": "One or more ...",       # human-readable summary
               "details": [{"field": ..., "message": ...}],  # per-field, may be empty
               ...extra}}                          # e.g. "requestId" on a 500

Clients switch on ``code`` (never on ``message``, which may be reworded) and
show ``details`` next to the matching inputs. Using one shape for 400, 404,
429 and 500 means a client needs exactly one error parser.

Example::

    >>> error_body("NOT_FOUND", "No such listing.")
    {'error': {'code': 'NOT_FOUND', 'message': 'No such listing.', 'details': []}}
"""

from __future__ import annotations

from typing import Any


def error_body(code: str, message: str, details: list[dict[str, str]] | None = None, **extra: Any) -> dict[str, Any]:
    """Build the error envelope. ``extra`` adds fields beside code/message/details."""
    return {"error": {"code": code, "message": message, "details": details or [], **extra}}
