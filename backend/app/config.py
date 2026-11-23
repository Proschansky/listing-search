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

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

from .repository import DEFAULT_DATA_PATH

# Where the last good SimplyRETS download is kept (git-ignored).
DEFAULT_SIMPLYRETS_CACHE = Path(__file__).resolve().parent.parent / ".cache" / "simplyrets.json"


SourceName = Literal["sample", "simplyrets"]


def _sample_only() -> list[SourceName]:
    """The default source list: just the bundled sample."""
    return ["sample"]


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
        description="JSON feed file the sample source loads. Defaults to the bundled sample data.",
    )
    sources: list[SourceName] = Field(
        default_factory=lambda: _sample_only(),
        description=(
            "Which listing sources to load, as a JSON list. 'sample' is the bundled file; "
            "'simplyrets' is the SimplyRETS live feed. start.sh and docker-compose turn both on."
        ),
    )

    # --- SimplyRETS feed (only used when "simplyrets" is in sources) ---------
    simplyrets_url: str = Field(
        default="https://api.simplyrets.com/properties",
        description="SimplyRETS properties endpoint.",
    )
    # The defaults are SimplyRETS's public demo login. SecretStr keeps them
    # out of logs and error messages; a real account would be set by env var.
    simplyrets_username: SecretStr = SecretStr("simplyrets")
    simplyrets_password: SecretStr = SecretStr("simplyrets")
    simplyrets_timeout_seconds: float = Field(
        default=5.0,
        gt=0,
        description="Time limit for each request to SimplyRETS.",
    )
    simplyrets_refresh_minutes: float = Field(
        default=15.0,
        gt=0,
        description="How often a running service downloads the feed again.",
    )
    simplyrets_cache_path: Path = Field(
        default=DEFAULT_SIMPLYRETS_CACHE,
        description="Last good download, used when SimplyRETS can't be reached.",
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
