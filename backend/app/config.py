"""Application settings, read once from environment variables.

Why a settings object instead of scattered ``os.environ`` lookups:

* **One place to look.** Every knob the service has is listed below with its
  type, default and meaning. A reviewer never has to grep for ``environ``.
* **Validated at startup.** ``pydantic-settings`` parses and type-checks each
  value when the app boots, so ``LISTING_RATE_LIMIT_PER_MINUTE=abc`` fails
  immediately with a clear message instead of crashing on the first request.
* **Testable.** ``create_app(settings=Settings(...))`` lets a test build an
  app with exactly the configuration it needs, no environment patching.

Every variable uses the ``LISTING_`` prefix, e.g. ``LISTING_LOG_FORMAT=json``.
A ``.env`` file next to the backend is also read if present (handy locally;
never commit real secrets to it).

Example::

    >>> Settings(rate_limit_per_minute=5).rate_limit_per_minute
    5
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from .repository import DEFAULT_DATA_PATH


class Settings(BaseSettings):
    """Every configurable value in the service, with safe defaults for local dev."""

    model_config = SettingsConfigDict(
        env_prefix="LISTING_",  # LISTING_LOG_LEVEL -> log_level
        env_file=".env",  # optional; missing file is fine
        extra="ignore",  # unrelated LISTING_* vars don't break startup
    )

    # --- Deployment ---------------------------------------------------------
    environment: Literal["development", "test", "production"] = Field(
        default="development",
        description="Shown in /health. In production, interactive API docs are disabled.",
    )

    # --- Data ---------------------------------------------------------------
    listings_path: Path = Field(
        default=DEFAULT_DATA_PATH,
        description="JSON feed file to load at startup. Defaults to the bundled sample data.",
    )

    # --- Logging ------------------------------------------------------------
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    log_format: Literal["json", "text"] = Field(
        default="text",
        description=(
            "'json' emits one JSON object per line (what log aggregators such as "
            "Datadog, CloudWatch or Loki ingest). 'text' is easier to read locally."
        ),
    )

    # --- HTTP ---------------------------------------------------------------
    cors_origins: list[str] = Field(
        default_factory=lambda: ["http://localhost:5173", "http://127.0.0.1:5173"],
        description="Browser origins allowed to call the API directly (JSON list in the env var).",
    )

    # --- Rate limiting ------------------------------------------------------
    rate_limit_enabled: bool = True
    rate_limit_per_minute: int = Field(
        default=120,
        ge=1,
        description="Sustained requests per minute allowed per client IP.",
    )
    rate_limit_burst: int = Field(
        default=30,
        ge=1,
        description="Extra requests a client may make in a quick burst before being throttled.",
    )

    @property
    def docs_enabled(self) -> bool:
        """Swagger UI (/docs) and ReDoc are handy in dev but leak the surface in prod."""
        return self.environment != "production"


@lru_cache
def get_settings() -> Settings:
    """The process-wide settings, built on first use and then cached.

    Cached so the environment is parsed exactly once; tests bypass this by
    passing their own ``Settings`` to ``create_app``.
    """
    return Settings()
