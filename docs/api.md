# API reference

All endpoints are read-only `GET` requests under `/api/v1`. With the app running, interactive docs listing every parameter are at http://localhost:8000/docs. They're hidden when `LISTING_ENVIRONMENT=production`. The machine-readable contract, in OpenAPI format, is checked in as [`backend/openapi.json`](../backend/openapi.json), and a test fails if it falls out of date.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/listings` | Search: filter, rank and paginate. Parameters are below. |
| `GET /api/v1/listings/{listingKey}` | One listing, in the same shape as a search result. Accepts `targetBudget` and `asOf` so its score matches the search that linked to it. Returns 404 if the key is unknown. |
| `GET /api/v1/meta` | Cities, statuses, sort options and limits, for building a search form |
| `GET /api/v1/health/live` | Liveness: the process is running |
| `GET /api/v1/health/ready` | Readiness: 200 when the data is loaded and searchable, 503 with the reason when it isn't |
| `GET /api/v1/health` | Summary health, kept for compatibility |

### Versioning

The original paths without a version (`/api/listings` and so on) still work, because existing clients use them. Every response on them carries a `Deprecation: true` header and a `Link` header pointing to the `/api/v1` path that replaces it. A breaking change would ship as `/api/v2` alongside v1. v1 itself won't change in a breaking way.

## Search parameters

Every parameter of `GET /api/v1/listings` is optional.

| Parameter | Type | Notes |
|---|---|---|
| `minPrice`, `maxPrice` | number, 0 or more | Inclusive. `minPrice` greater than `maxPrice` returns 400. |
| `minBedrooms` | whole number, 0 or more | |
| `city` | text | Exact match, ignoring case and extra spaces |
| `keyword` | text | Comma-separated terms, for example `pool, garage`. Matches whole words, ignores case, and every term must match. |
| `targetBudget` | number above 0 | Drives the ranking. See [ranking](ranking.md). |
| `status` | `active`, `pending`, `sold` | Comma-separated. Defaults to `active`. |
| `sort` | `relevance`, `newest`, `price_asc`, `price_desc`, `sqft_desc` | Defaults to `relevance`. Every order ends with the same tie-breakers, so results never shuffle between requests. |
| `page` | whole number, 1 or more | Defaults to 1 |
| `pageSize` | whole number, 1 to 100 | Defaults to 10 |
| `asOf` | date, `YYYY-MM-DD` | The date recency is measured from. Defaults to today. |

## Responses

A successful search:

```json
{
  "results": [{
    "listingKey": "55-elm-ct-vienna-va", "address": "55 Elm Ct", "price": 470000, "bedrooms": 3,
    "latitude": 38.9012, "longitude": -77.2653,
    "relevanceScore": 0.8847,
    "scoreBreakdown": { "budget": 1.0, "recency": 0.6156, "daysOnMarket": 21 },
    "sources": [{ "source": "MLS_A", "id": "A5" }, { "source": "MLS_B", "id": "B11" }],
    "photos": []
  }],
  "pagination": { "page": 1, "pageSize": 10, "totalResults": 7, "totalPages": 1, "hasPrevious": false, "hasNext": false },
  "warnings": []
}
```

`sources` lists every feed record merged into the result. SimplyRETS listings have the source `SIMPLYRETS`. `photos` is a list of `https` image URLs, best first; it's empty for listings with no photos, which includes all the sample data. Both fields are also on `GET /api/v1/listings/{listingKey}`.

### Readiness

`GET /api/v1/health/ready` reports the merged data and each source:

```json
{
  "status": "ok",
  "checks": {
    "data": { "ok": true, "listings": 86, "rawRecords": 90, "skippedRecords": 0, "error": null },
    "sources": {
      "sample": { "status": "ok", "listings": 12, "skippedRecords": 0, "fetchedAt": null, "error": null },
      "simplyrets": {
        "status": "degraded", "listings": 78, "skippedRecords": 0,
        "fetchedAt": "2026-11-22T05:21:46+00:00", "error": "ConnectError: ...", "breaker": "closed"
      }
    }
  }
}
```

A source's `status` is `ok` (fresh data), `degraded` (the download failed, so its last good download is in use; `fetchedAt` says how old it is) or `unavailable` (no data from it). `breaker` is the circuit breaker: `closed` when calls go through, `open` when it has stopped calling SimplyRETS after repeated failures, and `half_open` when it's about to try again. Only a required source (the sample file) can make the service unready. A degraded or unavailable SimplyRETS still answers 200, because searches still work.

## Errors

Every error uses the same shape, defined in `backend/app/errors.py`, so a client needs only one error parser. Check `code`. The `message` wording may change.

One exception: when the service isn't ready, `GET /api/v1/health/ready` returns 503 with its usual health body (`status`, `version`, `environment` and `checks`), not this error shape. Load balancers and Kubernetes only read the status code, and the reason for the failure is in `checks.data.error`.

| Status | `code` | When |
|---|---|---|
| 400 | `INVALID_PARAMETERS` | Any bad input. `details` lists every bad field at once. |
| 404 | `NOT_FOUND` | Unknown listing or route |
| 405 | `METHOD_NOT_ALLOWED` | Anything other than GET |
| 429 | `RATE_LIMITED` | Too many requests. The `Retry-After` header says how many seconds to wait. |
| 500 | `INTERNAL_ERROR` | A bug. The body carries a `requestId` to quote in a report. Internal details are never sent. |

```json
{ "error": { "code": "INVALID_PARAMETERS", "message": "One or more search parameters are invalid.",
  "details": [ { "field": "minPrice", "message": "must not be greater than maxPrice (600000 > 500000)" },
               { "field": "pageSize", "message": "must be 1 or greater" } ] } }
```

## How unusual input is handled

| Situation | Result |
|---|---|
| `minPrice` above `maxPrice`, `pageSize` 0 or below or over 100, `page` below 1, text where a number belongs, negative numbers, `targetBudget` 0 or below, bad dates, unknown status | 400, listing every field error |
| Unknown parameter (for example the typo `minprice`) or a repeated parameter | 400. Ignoring a typo would return wrong results that look right. |
| Unknown `sort` | 400, listing the valid options |
| Blank field | Treated as not set |
| A city with no listings at all | 200 with no results and a warning listing the cities that do exist. The question is valid, it just has an empty answer. |
| `page` past the last page | 200 with no results, full pagination details and a warning. The app offers "Go to last page". |
| A broken record in a feed file | Skipped and logged, so one bad record can't take search down. The count appears in `/health/ready`. |
| SimplyRETS is down or slow | The service keeps serving its last good download, or the other sources if there is none. `/health/ready` stays 200 and shows the source as `degraded` or `unavailable`. |
| A missing or corrupt data file | The service still starts. `/health/ready` returns 503 with the reason, and searches return no results. |

The app turns off the browser's own form validation, so the API is the only source of validation rules, and its messages appear next to the matching fields.
