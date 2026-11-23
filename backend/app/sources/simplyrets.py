"""The SimplyRETS live feed (https://simplyrets.com).

SimplyRETS serves MLS listings over a JSON API. Its free demo login
(``simplyrets`` / ``simplyrets``) returns about 80 synthetic listings around
Houston, which is enough to run a real HTTP feed next to the bundled sample.

The work is split so each part can be tested on its own:

1. ``to_feed_record`` maps one SimplyRETS listing to the app's feed format.
   It's a pure function, so the mapping rules are tested without any HTTP.
2. ``fetch_all`` downloads every page, following the ``Link`` header.
3. ``SimplyRetsSource.load`` puts them together with retries, a circuit
   breaker and a snapshot of the last good download, so the service keeps
   serving SimplyRETS listings when the API is down.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

import httpx

from ..models import Listing
from .base import SourceResult
from .resilience import CircuitBreaker, RetryableError, SnapshotCache, retry

log = logging.getLogger(__name__)

SOURCE_NAME = "SIMPLYRETS"  # the `source` value on every record from this feed

# SimplyRETS statuses the app understands. Others (Withdrawn, Expired,
# Hold, Incomplete and so on) aren't for sale or sold, so they're skipped.
STATUS_MAP = {
    "Active": "active",
    "ActiveUnderContract": "pending",
    "Pending": "pending",
    "Closed": "sold",
}

# SimplyRETS sends full state names ("Texas"); the app uses USPS codes.
STATE_CODES = {
    "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR", "California": "CA",
    "Colorado": "CO", "Connecticut": "CT", "Delaware": "DE", "District of Columbia": "DC",
    "Florida": "FL", "Georgia": "GA", "Hawaii": "HI", "Idaho": "ID", "Illinois": "IL",
    "Indiana": "IN", "Iowa": "IA", "Kansas": "KS", "Kentucky": "KY", "Louisiana": "LA",
    "Maine": "ME", "Maryland": "MD", "Massachusetts": "MA", "Michigan": "MI", "Minnesota": "MN",
    "Mississippi": "MS", "Missouri": "MO", "Montana": "MT", "Nebraska": "NE", "Nevada": "NV",
    "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY",
    "North Carolina": "NC", "North Dakota": "ND", "Ohio": "OH", "Oklahoma": "OK", "Oregon": "OR",
    "Pennsylvania": "PA", "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD",
    "Tennessee": "TN", "Texas": "TX", "Utah": "UT", "Vermont": "VT", "Virginia": "VA",
    "Washington": "WA", "West Virginia": "WV", "Wisconsin": "WI", "Wyoming": "WY",
}  # fmt: skip

# Ask for every status the app shows; by default SimplyRETS omits Closed.
REQUESTED_STATUSES = ("Active", "ActiveUnderContract", "Pending", "Closed")
PAGE_SIZE = 500  # the largest page SimplyRETS serves
MAX_PAGES = 50  # a safety stop in case the API keeps returning "next" links


def _state_code(name: Any) -> str | None:
    """A USPS state code from a full name or a code. None if unrecognised."""
    if not isinstance(name, str):
        return None
    name = name.strip()
    if len(name) == 2 and name.upper() in STATE_CODES.values():
        return name.upper()
    return STATE_CODES.get(name)


def _bathrooms(prop: dict[str, Any]) -> float | None:
    """Total bathrooms: SimplyRETS's own total if given, else full + half + three-quarter."""
    if prop.get("bathrooms") is not None:
        return float(prop["bathrooms"])
    full, half, three_quarter = (prop.get(k) or 0 for k in ("bathsFull", "bathsHalf", "bathsThreeQuarter"))
    total = full + 0.5 * half + 0.75 * three_quarter
    return float(total) if total else None


def to_feed_record(raw: dict[str, Any]) -> dict[str, Any] | None:
    """Map one SimplyRETS listing to the app's feed format.

    Returns None when the listing can't be used: a status the app doesn't
    show, or a missing field the app needs. ``Listing.from_dict`` still
    validates the result, the same as for every other source.

    >>> rec = to_feed_record({
    ...     "mlsId": 1005192, "listPrice": 520000, "listDate": "2015-03-04T18:50:30Z",
    ...     "remarks": "Big yard.", "photos": ["https://cdn.example/1.jpg"],
    ...     "mls": {"status": "Active"},
    ...     "address": {"full": "74434 East Sweet Bottom Br #18393", "city": "Houston",
    ...                 "state": "Texas", "postalCode": "77096"},
    ...     "property": {"bedrooms": 3, "bathsFull": 2, "bathsHalf": 1, "area": 1800},
    ...     "geo": {"lat": 29.69, "lng": -95.47},
    ... })
    >>> rec["source"], rec["id"], rec["state"], rec["bathrooms"], rec["status"], rec["listedDate"]
    ('SIMPLYRETS', '1005192', 'TX', 2.5, 'active', '2015-03-04')
    >>> to_feed_record({"mls": {"status": "Withdrawn"}}) is None
    True
    """
    try:
        status = STATUS_MAP.get(str((raw.get("mls") or {}).get("status")))
        address = raw.get("address") or {}
        prop = raw.get("property") or {}
        geo = raw.get("geo") or {}
        state = _state_code(address.get("state"))
        bathrooms = _bathrooms(prop)
        required = (
            status,
            raw.get("mlsId"),
            address.get("full"),
            address.get("city"),
            state,
            raw.get("listPrice"),
            prop.get("bedrooms"),
            bathrooms,
            prop.get("area"),
            geo.get("lat"),
            geo.get("lng"),
            raw.get("listDate"),
        )
        if any(value is None for value in required):
            return None
        return {
            "id": str(raw["mlsId"]),
            "source": SOURCE_NAME,
            "address": address["full"],
            "city": address["city"],
            "state": state,
            "zip": str(address.get("postalCode") or ""),
            "price": raw["listPrice"],
            "bedrooms": prop["bedrooms"],
            "bathrooms": bathrooms,
            "sqft": prop["area"],
            "latitude": geo["lat"],
            "longitude": geo["lng"],
            "listedDate": str(raw["listDate"])[:10],  # "2015-03-04T18:50:30Z" -> "2015-03-04"
            "status": status,
            "description": raw.get("remarks") or "",
            "photos": raw.get("photos") or [],
        }
    except (AttributeError, TypeError, ValueError):
        # A field of an unexpected type ("address" as a string, or
        # "bathrooms" as "two"). Skip this record, not the whole download.
        return None


def _same_origin(a: httpx.URL, b: httpx.URL) -> bool:
    return (a.scheme, a.host, a.port) == (b.scheme, b.host, b.port)


def fetch_all(client: httpx.Client, url: str) -> list[dict[str, Any]]:
    """Download every listing, following the ``Link: <...>; rel="next"`` header.

    Raises ``RetryableError`` for failures worth retrying (network errors,
    timeouts, 429, 5xx), ``httpx.HTTPStatusError`` for other bad statuses
    (such as 401 for bad credentials) and ``ValueError`` for a response the
    app can't trust: a body that isn't a list, a ``next`` link to another
    server, or more pages than ``MAX_PAGES``.
    """
    origin = httpx.URL(url)
    params: dict[str, Any] | None = {"limit": PAGE_SIZE, "status": list(REQUESTED_STATUSES)}
    records: list[dict[str, Any]] = []
    next_url: str | None = url
    for _ in range(MAX_PAGES):
        if next_url is None:
            return records
        try:
            response = client.get(next_url, params=params)
        except httpx.TransportError as exc:  # connection refused, DNS, timeouts
            raise RetryableError(f"{type(exc).__name__}: {exc}") from exc
        if response.status_code == 429 or response.status_code >= 500:
            raise RetryableError(f"SimplyRETS answered {response.status_code}")
        response.raise_for_status()
        page = response.json()
        if not isinstance(page, list):
            raise ValueError("SimplyRETS returned something other than a list of listings")
        records.extend(page)
        # The next link already carries every query parameter.
        link = response.links.get("next", {}).get("url")
        next_url = None
        if link:
            resolved = response.url.join(link)
            # The client sends the login with every request, so only follow
            # links to the server we were configured to call. A link to any
            # other host, or from https down to http, could leak it.
            if not _same_origin(resolved, origin):
                raise ValueError(f"SimplyRETS sent a next-page link to another server ({resolved.host})")
            next_url = str(resolved)
        params = None
    if next_url is not None:
        # Treating a cut-off download as complete would replace the snapshot
        # and drop every listing past the cap, so fail and keep the snapshot.
        raise ValueError(f"SimplyRETS still had pages after {MAX_PAGES}; download incomplete")
    return records


def _usable(records: list[dict[str, Any]]) -> bool:
    """Whether any mapped record passes the same check the repository applies."""
    for record in records:
        try:
            Listing.from_dict(record)
        except ValueError:
            continue
        return True
    return False


class SimplyRetsSource:
    """Listings from the SimplyRETS API, with retries, a circuit breaker and a snapshot.

    How ``load`` decides what to return:

    1. With ``allow_network=False``, or while the breaker is open, it doesn't
       call the API and returns the snapshot (degraded) if there is one.
    2. Otherwise it downloads every page, retrying brief failures. On success
       it saves the snapshot and returns the fresh records (ok).
    3. If the download fails, it returns the snapshot (degraded), or nothing
       (unavailable) if there isn't one.

    SimplyRETS is optional (``required = False``): when it's unavailable the
    service still runs on the other sources and reports SimplyRETS as down.
    """

    name = "simplyrets"
    required = False

    def __init__(
        self,
        *,
        url: str,
        username: str,
        password: str,
        timeout: float,
        cache: SnapshotCache,
        breaker: CircuitBreaker | None = None,
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], None] | None = None,
        now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    ):
        self.url = url
        self._auth = (username, password)
        self.timeout = timeout
        self.cache = cache
        self.breaker = breaker or CircuitBreaker()
        self._transport = transport  # tests pass httpx.MockTransport
        self._sleep = sleep
        self._now = now

    def _download(self) -> list[dict[str, Any]]:
        with httpx.Client(auth=self._auth, timeout=self.timeout, transport=self._transport) as client:
            return retry(lambda: fetch_all(client, self.url), sleep=self._sleep or time.sleep)

    def _from_snapshot(self, error: str) -> SourceResult:
        snapshot = self.cache.load()
        detail = {"breaker": self.breaker.state}
        if snapshot is None:
            return SourceResult(self.name, "unavailable", error=error, detail=detail)
        records, fetched_at = snapshot
        return self._mapped("degraded", records, fetched_at, error=error)

    def _mapped(
        self, state: str, raw: list[dict[str, Any]], fetched_at: datetime, error: str | None = None
    ) -> SourceResult:
        mapped = [to_feed_record(r) for r in raw if isinstance(r, dict)]
        records = [r for r in mapped if r is not None]
        return SourceResult(
            self.name,
            state,  # type: ignore[arg-type]
            records=records,
            skipped=len(raw) - len(records),
            error=error,
            fetched_at=fetched_at,
            detail={"breaker": self.breaker.state},
        )

    def load(self, *, allow_network: bool = True) -> SourceResult:
        if not allow_network:
            return self._from_snapshot("waiting for the first download")
        if not self.breaker.allow():
            return self._from_snapshot("circuit breaker open after repeated failures; not calling SimplyRETS")
        try:
            raw = self._download()
        except (RetryableError, httpx.HTTPError, ValueError) as exc:
            self.breaker.record_failure()
            # httpx's messages name the URL but never the credentials, which
            # travel in the Authorization header.
            log.warning("SimplyRETS download failed: %s", exc)
            return self._from_snapshot(str(exc))
        mapped = [to_feed_record(r) for r in raw if isinstance(r, dict)]
        if raw and not _usable([r for r in mapped if r is not None]):
            # A download full of records the app can't use is a broken
            # response, not "SimplyRETS has no listings". Saving it would
            # overwrite the last good snapshot, so treat it as a failure.
            self.breaker.record_failure()
            log.warning("SimplyRETS returned %d record(s), none usable", len(raw))
            return self._from_snapshot(f"SimplyRETS returned {len(raw)} record(s), none usable")
        self.breaker.record_success()
        fetched_at = self._now()
        self.cache.save(raw, fetched_at)
        return self._mapped("ok", raw, fetched_at)
