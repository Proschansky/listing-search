"""The bundled sample feed: a JSON file in the app's own feed format."""

from __future__ import annotations

import json
from pathlib import Path

from ..repository import DEFAULT_DATA_PATH
from .base import SourceResult


class SampleSource:
    """Reads listing records from a local JSON file (a list of records).

    The file is part of the app, so if it's missing or broken the service is
    misconfigured: the source is ``required``, and the readiness check fails.
    """

    name = "sample"
    required = True

    def __init__(self, path: Path = DEFAULT_DATA_PATH):
        self.path = path

    def load(self, *, allow_network: bool = True) -> SourceResult:
        # allow_network is part of the Source interface; a local file never needs it.
        try:
            with open(self.path, encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError) as exc:  # json.JSONDecodeError is a ValueError
            return SourceResult(self.name, "unavailable", error=f"{type(exc).__name__}: {exc}")
        if not isinstance(data, list):
            return SourceResult(
                self.name, "unavailable", error=f"ValueError: {self.path} must contain a JSON list of listing records"
            )
        return SourceResult(self.name, "ok", records=data)
