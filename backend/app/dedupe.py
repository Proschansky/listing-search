"""Merge raw feed records that describe the same property.

Feeds disagree on formatting ("123 Main St, Apt 4B" vs "123 Main Street,
Unit 4B") and sometimes on facts (456 Oak Ave has zip 22150 in MLS_A and
22151 in MLS_B). So we match on a *normalized* street address + city + state,
and use coordinates as a safety check, rather than comparing raw strings or
trusting zip.

Matching rule
-------------
Two records are the same property when
  1. their normalized address, city and state are identical, AND
  2. their coordinates are within ``MAX_MATCH_DISTANCE_KM`` of each other.

Rule 2 guards against false merges, e.g. "100 Main St" existing in two
different neighbourhoods that share a city name in a messy feed.

Merge rule
----------
* The *primary* record (most recent ``listedDate``; ties broken by source
  name) supplies display fields such as address, price and description: it's
  the freshest view of the listing.
* ``listedDate`` is the *earliest* across sources - that's when the home
  actually came on the market, so a feed that picked it up late can't make it
  look newer than it is.
* Keyword search runs over every source's description, so a term that only
  one feed mentions still matches.
"""

from __future__ import annotations

import math
import re
from collections import defaultdict

from .models import Listing, MergedListing, SourceRef

# 200 m: generous enough for small geocoding differences between feeds,
# tight enough that two different buildings won't be merged.
MAX_MATCH_DISTANCE_KM = 0.2

# Long-form street words -> the standard USPS-style abbreviation, so
# "Street" and "St" normalize to the same token. Directions are included
# because feeds vary between "North" and "N" too.
_SUFFIXES = {
    "street": "st",
    "avenue": "ave",
    "av": "ave",
    "road": "rd",
    "lane": "ln",
    "drive": "dr",
    "court": "ct",
    "boulevard": "blvd",
    "place": "pl",
    "terrace": "ter",
    "circle": "cir",
    "parkway": "pkwy",
    "highway": "hwy",
    "north": "n",
    "south": "s",
    "east": "e",
    "west": "w",
}

# Every way feeds say "this is a unit inside a building". All of them are
# collapsed to the single word "unit" so "Apt 4B" == "Unit 4B" == "#4B".
_UNIT_WORDS = {"apt", "apartment", "unit", "suite", "ste", "#"}


def normalize_address(address: str) -> str:
    """Canonical form for matching: lowercase, no punctuation, standard
    abbreviations, and every unit designator collapsed to ``unit``.

    >>> normalize_address("123 Main Street, Unit 4B")
    '123 main st unit 4b'
    >>> normalize_address("123 Main St, Apt 4B")
    '123 main st unit 4b'
    """
    # Step 1: lowercase, and put spaces around "#" so "#4B" becomes the
    # separate tokens "#" and "4b" (otherwise "#4b" would be one token).
    text = address.lower().replace("#", " # ")

    # Step 2: replace punctuation (commas, periods, etc.) with spaces.
    # "#" is kept because it's meaningful as a unit marker.
    text = re.sub(r"[^\w#\s]", " ", text)

    # Step 3: walk the words and swap each for its canonical form.
    # split() with no argument also collapses repeated whitespace.
    tokens = []
    for token in text.split():
        if token in _UNIT_WORDS:
            tokens.append("unit")
        else:
            # Abbreviate if it's a known long form; otherwise keep as-is.
            tokens.append(_SUFFIXES.get(token, token))
    return " ".join(tokens)


def normalize_city(city: str) -> str:
    """Lowercase and collapse whitespace: "  Fairfax " -> "fairfax"."""
    return " ".join(city.lower().split())


def _haversine_km(a: Listing, b: Listing) -> float:
    """Great-circle distance between two listings' coordinates, in km.

    The standard haversine formula: accurate for short distances on a
    sphere, which is all we need for "are these the same building?".
    """
    # Trigonometry functions need radians, not degrees.
    lat1, lon1, lat2, lon2 = map(math.radians, (a.latitude, a.longitude, b.latitude, b.longitude))
    # h is the haversine of the central angle between the two points.
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    # Convert the angle to a distance using Earth's mean radius (6371 km).
    return 2 * 6371.0 * math.asin(math.sqrt(h))


def _slug(text: str) -> str:
    """Make a URL/React-key-safe id: "123 main st springfield va" ->
    "123-main-st-springfield-va"."""
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def _merge_group(key: str, group: list[Listing]) -> MergedListing:
    """Combine records already known to be the same property into one."""
    # Step 1: pick the primary record - the one listed most recently, since
    # it's the freshest view (latest price, latest description). Negating
    # the date's ordinal sorts newest-first; source and id break any tie so
    # the choice is deterministic.
    primary = sorted(group, key=lambda r: (-r.listed_date.toordinal(), r.source, r.id))[0]

    # Step 2: a stable ordering of all contributing records (by source, then
    # id) for the `sources` list and the combined search text, so output
    # never depends on the order records happened to appear in the feed.
    ordered = sorted(group, key=lambda r: (r.source, r.id))

    # Step 3: build the merged listing. Most fields come from the primary;
    # listed_date and search_text are computed across *all* records.
    return MergedListing(
        listing_key=key,
        address=primary.address,
        city=primary.city,
        state=primary.state,
        zip=primary.zip,
        price=primary.price,
        bedrooms=primary.bedrooms,
        bathrooms=primary.bathrooms,
        sqft=primary.sqft,
        latitude=primary.latitude,
        longitude=primary.longitude,
        # Earliest date = when the home first hit the market in any feed.
        listed_date=min(r.listed_date for r in group),
        status=primary.status,
        description=primary.description,
        # Join every feed's description so a keyword that only one feed
        # mentions (e.g. "renovated" in MLS_B only) still finds the home.
        search_text=" \n ".join(r.description for r in ordered),
        # Keep a reference to every original record for traceability.
        sources=tuple(
            SourceRef(
                source=r.source,
                id=r.id,
                address=r.address,
                price=r.price,
                listed_date=r.listed_date,
                status=r.status,
            )
            for r in ordered
        ),
    )


def merge_listings(listings: list[Listing]) -> list[MergedListing]:
    """Collapse duplicate feed records into one ``MergedListing`` per property."""
    # Step 1: bucket records by (normalized address, city, state). Records in
    # the same bucket are *candidates* for being the same property. Zip is
    # deliberately not part of the key because feeds disagree on it.
    by_key: dict[tuple[str, str, str], list[Listing]] = defaultdict(list)
    for listing in listings:
        key = (
            normalize_address(listing.address),
            normalize_city(listing.city),
            listing.state.upper(),
        )
        by_key[key].append(listing)

    merged: list[MergedListing] = []
    for (addr, city, state), candidates in by_key.items():
        # Step 2: within a bucket, split into clusters by distance so that
        # records with the same text but far-apart coordinates stay separate.
        # Each record joins the first cluster whose first member is within
        # MAX_MATCH_DISTANCE_KM; otherwise it starts a new cluster. Sorting
        # first keeps the clustering deterministic.
        clusters: list[list[Listing]] = []
        for record in sorted(candidates, key=lambda r: (r.source, r.id)):
            for cluster in clusters:
                if _haversine_km(cluster[0], record) <= MAX_MATCH_DISTANCE_KM:
                    cluster.append(record)
                    break
            else:
                # for/else: runs only if no cluster matched (no `break`).
                clusters.append([record])

        # Step 3: merge each cluster into one listing. The first cluster gets
        # the plain key; any extra clusters at the same address get "-2",
        # "-3", ... so every listing_key stays unique.
        base_key = _slug(f"{addr} {city} {state}")
        for i, cluster in enumerate(clusters):
            listing_key = base_key if i == 0 else f"{base_key}-{i + 1}"
            merged.append(_merge_group(listing_key, cluster))

    # Step 4: return in a stable order (by key) so the in-memory data is the
    # same on every startup, which keeps results and tests reproducible.
    return sorted(merged, key=lambda m: m.listing_key)
