"""Write the service's OpenAPI contract to backend/openapi.json.

Run from the backend folder:  python -m scripts.export_openapi

The file is checked in so API changes show up in code review as a diff, and
so client code (or a mock server) can be generated without running the API.
``tests/test_contract.py`` fails if it falls out of date.
"""

from __future__ import annotations

import json
from pathlib import Path

from app.config import Settings
from app.main import create_app
from app.repository import ListingRepository

OUT = Path(__file__).resolve().parent.parent / "openapi.json"


def main() -> None:
    # Development settings so the docs routes exist; an empty repository is
    # enough, since the contract doesn't depend on the data.
    app = create_app(ListingRepository([]), Settings(environment="development", rate_limit_enabled=False))
    OUT.write_text(json.dumps(app.openapi(), indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
