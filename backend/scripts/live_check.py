"""Check the real SimplyRETS API still works with the app (``make live-check``).

The unit tests never touch the internet, so they can't notice SimplyRETS
changing its format or going away. This script downloads the real feed
once, maps it, and fails if nothing usable comes back. Run it by hand
before a demo or after upgrading; CI doesn't run it, because a third-party
outage shouldn't break the build.

It writes its snapshot to a temporary folder, so your own cached copy is
left alone.
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

from app.config import Settings
from app.models import Listing
from app.sources.resilience import SnapshotCache
from app.sources.simplyrets import SimplyRetsSource


def main() -> int:
    settings = Settings()
    with tempfile.TemporaryDirectory() as tmp:
        source = SimplyRetsSource(
            url=settings.simplyrets_url,
            username=settings.simplyrets_username.get_secret_value(),
            password=settings.simplyrets_password.get_secret_value(),
            timeout=settings.simplyrets_timeout_seconds,
            cache=SnapshotCache(Path(tmp) / "simplyrets.json"),
        )
        result = source.load()
    valid = []
    for record in result.records:
        try:
            valid.append(Listing.from_dict(record))
        except ValueError as exc:
            print(f"  invalid record {record.get('id')}: {exc}")
    print(f"SimplyRETS: {result.state}, {len(valid)} usable listing(s), {result.skipped} skipped")
    if result.error:
        print(f"  error: {result.error}")
    if result.state != "ok" or not valid:
        print("FAIL: no usable listings from SimplyRETS")
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
