"""Settings: defaults, environment overrides and validation."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.config import Settings, get_settings
from app.repository import DEFAULT_DATA_PATH


def test_defaults_are_safe_for_local_development(monkeypatch):
    for key in list(__import__("os").environ):
        if key.startswith("LISTING_"):
            monkeypatch.delenv(key)
    s = Settings(_env_file=None)
    assert s.environment == "development"
    assert s.listings_path == DEFAULT_DATA_PATH
    assert s.rate_limit_enabled and s.rate_limit_per_minute == 120
    assert s.docs_enabled


def test_environment_variables_override_defaults(monkeypatch, tmp_path):
    monkeypatch.setenv("LISTING_LOG_FORMAT", "json")
    monkeypatch.setenv("LISTING_RATE_LIMIT_PER_MINUTE", "5")
    monkeypatch.setenv("LISTING_LISTINGS_PATH", str(tmp_path / "x.json"))
    monkeypatch.setenv("LISTING_CORS_ORIGINS", '["https://app.example.com"]')
    s = Settings(_env_file=None)
    assert s.log_format == "json"
    assert s.rate_limit_per_minute == 5
    assert s.listings_path == tmp_path / "x.json"
    assert s.cors_origins == ["https://app.example.com"]


@pytest.mark.parametrize(
    ("var", "value"),
    [("LISTING_RATE_LIMIT_PER_MINUTE", "abc"), ("LISTING_RATE_LIMIT_PER_MINUTE", "0"), ("LISTING_LOG_FORMAT", "xml")],
)
def test_bad_values_fail_fast_at_startup(monkeypatch, var, value):
    monkeypatch.setenv(var, value)
    with pytest.raises(ValidationError):
        Settings(_env_file=None)


def test_docs_are_disabled_in_production():
    assert not Settings(environment="production").docs_enabled


def test_get_settings_is_cached():
    assert get_settings() is get_settings()
