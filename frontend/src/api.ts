/**
 * API client: types for the backend's JSON, plus the functions that build
 * query strings and call the endpoints.
 *
 * @remarks
 * Every network call in the app goes through this module, so components never
 * deal with URLs or HTTP details. The response types mirror the backend's JSON
 * exactly (see the `to_dict` methods in `backend/app/models.py`).
 *
 * Failures likely to be temporary are retried with exponential backoff and
 * jitter: the network dropping, the API restarting (502, 503, 504) and rate
 * limiting (429, honouring the server's `Retry-After`). All calls are GETs,
 * which are safe to repeat. A 400 or 404 is never retried, because asking
 * again won't change the answer.
 *
 * Every call takes an `AbortSignal`. Aborting also stops any pending retry
 * wait, so a superseded search can't fire late requests.
 *
 * Every failure becomes an {@link ApiError} carrying the server's error
 * `code` and, for 500s, the `requestId` to quote in a bug report.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

/** A listing's market status. Only `active` is shown unless the user opts in. */
export type Status = 'active' | 'pending' | 'sold'

/** Orderings the API supports. Mirrors `SORT_OPTIONS` in `backend/app/models.py`. */
export type SortOption = 'relevance' | 'newest' | 'price_asc' | 'price_desc' | 'sqft_desc'

/** Labels for the sort control, in display order. */
export const SORT_LABELS: Record<SortOption, string> = {
  relevance: 'Best match',
  newest: 'Newest',
  price_asc: 'Price: low to high',
  price_desc: 'Price: high to low',
  sqft_desc: 'Largest',
}

/** One original feed record that contributed to a merged listing. */
export interface SourceRef {
  /** Feed the record came from, for example `"MLS_A"`. */
  source: string
  /** The record's id. Unique only within its own source. */
  id: string
  /** Address exactly as that feed spelled it. */
  address: string
  /** List price according to that feed. */
  price: number
  /** ISO date that feed listed the home. */
  listedDate: string
  /** Status according to that feed. */
  status: Status
}

/** One search result: a merged property plus its relevance score. */
export interface ListingResult {
  /** Stable unique id derived from the normalized address. Used as the React list key. */
  listingKey: string
  address: string
  city: string
  state: string
  zip: string
  price: number
  bedrooms: number
  bathrooms: number
  sqft: number
  /** WGS84 coordinates, used by the map view. */
  latitude: number
  longitude: number
  /** Earliest date any feed listed the home (its true time on market). */
  listedDate: string
  status: Status
  description: string
  /** Weighted score from 0 to 1. Higher ranks first. */
  relevanceScore: number
  /**
   * The parts that make up {@link ListingResult.relevanceScore}.
   * `budget` is `null` when the search had no target budget.
   */
  scoreBreakdown: { budget: number | null; recency: number; daysOnMarket: number }
  /** Every feed record that was merged into this listing. */
  sources: SourceRef[]
  /**
   * Photo URLs (always `https`), best first. Empty when no feed has photos,
   * which is the case for the bundled sample data.
   */
  photos: string[]
}

/** Page metadata returned with every search. */
export interface Pagination {
  /** Current page, starting at 1. */
  page: number
  pageSize: number
  /** Matches across all pages. */
  totalResults: number
  /** `0` when nothing matched at all. */
  totalPages: number
  hasPrevious: boolean
  hasNext: boolean
}

/** The body of a successful `GET /api/listings` response. */
export interface SearchResponse {
  /** This page's results, already ranked by the API. */
  results: ListingResult[]
  pagination: Pagination
  /** Non-fatal notes, for example `"No listings in city 'X'"`. */
  warnings: string[]
}

/** One validation problem from a 400 response, tied to a form field. */
export interface FieldError {
  /** Query parameter name, for example `"minPrice"`. Matches the form field name. */
  field: string
  message: string
}

/** Reference data from `GET /api/meta`. */
export interface Meta {
  /** Every city that has listings, used for the city input's suggestions. */
  cities: string[]
  statuses: Status[]
  maxPageSize: number
}

// ---------------------------------------------------------------------------
// Query model
// ---------------------------------------------------------------------------

/**
 * Everything the user can set in the search form.
 *
 * @remarks
 * Values are kept as strings because they come straight from inputs. The
 * backend owns validation, so the rules live in exactly one place.
 */
export interface SearchQuery {
  minPrice: string
  maxPrice: string
  minBedrooms: string
  city: string
  /** Comma-separated terms, for example `"pool, garage"`. */
  keyword: string
  targetBudget: string
  /** Statuses to include. The form never lets this become empty. */
  statuses: Status[]
  pageSize: string
  /** Reference date (`YYYY-MM-DD`) for recency scoring. Blank means today. */
  asOf: string
  /** Result order. `relevance` is the default and is left out of URLs. */
  sort: SortOption
  /** Page to fetch, starting at 1. */
  page: number
}

/** The starting form state, and what "Reset" goes back to. */
export const EMPTY_QUERY: SearchQuery = {
  minPrice: '',
  maxPrice: '',
  minBedrooms: '',
  city: '',
  keyword: '',
  targetBudget: '',
  statuses: ['active'],
  pageSize: '10',
  asOf: '',
  sort: 'relevance',
  page: 1,
}

/**
 * An error from the API, or from failing to reach it.
 *
 * @remarks
 * Carries any per-field validation details so the form can highlight the bad
 * inputs.
 */
export class ApiError extends Error {
  /** HTTP status. `0` means the request never got a response. */
  readonly status: number
  /** Field-level validation errors from a 400 response. Empty otherwise. */
  readonly details: FieldError[]
  /** The server's machine-readable error code, for example `"RATE_LIMITED"`. `"NETWORK"` if unreachable. */
  readonly code: string
  /** The server's request ID for 500s, to quote in a bug report. */
  readonly requestId?: string

  /**
   * @param message - Human-readable summary shown to the user.
   * @param status - HTTP status code, or `0` for a network failure.
   * @param details - Field-level validation errors, if any.
   * @param code - Machine-readable error code from the server.
   * @param requestId - Server request ID, when the server sent one.
   */
  constructor(message: string, status: number, details: FieldError[] = [], code = 'HTTP_ERROR', requestId?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.details = details
    this.code = code
    this.requestId = requestId
  }
}

/**
 * The plain string fields that map one-to-one onto query parameters.
 *
 * @remarks
 * `statuses` and `page` need special handling, so they're not in this list.
 */
const TEXT_FIELDS = [
  'minPrice',
  'maxPrice',
  'minBedrooms',
  'city',
  'keyword',
  'targetBudget',
  'pageSize',
  'asOf',
] as const

// ---------------------------------------------------------------------------
// Converting between the form state and a URL query string
// ---------------------------------------------------------------------------

/**
 * Build the query string for a search.
 *
 * @remarks
 * Blank fields and values equal to the backend's defaults are left out, so
 * requests and shareable URLs stay short.
 *
 * @param query - The current search.
 * @returns Query parameters ready for `/api/listings` or the page URL.
 *
 * @example
 * ```ts
 * toSearchParams({ ...EMPTY_QUERY, city: 'Reston', page: 2 }).toString()
 * // => "city=Reston&pageSize=10&page=2"
 * ```
 */
export function toSearchParams(query: SearchQuery): URLSearchParams {
  const params = new URLSearchParams()

  // Step 1: copy over every non-blank text field. Blank fields are skipped
  // entirely, so the request means "no filter" rather than "filter on ''".
  for (const key of TEXT_FIELDS) {
    const value = query[key].trim()
    if (value) params.set(key, value)
  }

  // Step 2: statuses as a comma-separated list, but only if they differ
  // from the backend default (just "active"), to keep URLs short and clean.
  if (query.statuses.length && !(query.statuses.length === 1 && query.statuses[0] === 'active')) {
    params.set('status', query.statuses.join(','))
  }

  // Step 3: sort order, only when it isn't the default.
  if (query.sort !== 'relevance') params.set('sort', query.sort)

  // Step 4: page number, only when past the first page (page 1 is the default).
  if (query.page > 1) params.set('page', String(query.page))
  return params
}

/**
 * Rebuild a search from a URL query string. The inverse of {@link toSearchParams}.
 *
 * @remarks
 * Lets a search survive a page refresh or be shared as a link. Junk values
 * are dropped or replaced with defaults rather than crashing.
 *
 * @param params - Query parameters, usually from `window.location.search`.
 * @returns A complete search, with defaults for anything missing.
 */
export function fromSearchParams(params: URLSearchParams): SearchQuery {
  // Start from defaults so any parameter missing from the URL keeps its default.
  const query: SearchQuery = { ...EMPTY_QUERY }

  // Text fields: copy whatever is in the URL as-is. The backend validates it,
  // so a bad value from a hand-edited URL produces a normal field error.
  for (const key of TEXT_FIELDS) {
    const value = params.get(key)
    if (value !== null) query[key] = value
  }

  // Statuses: split the list and keep only recognised values, so a junk
  // URL like ?status=bogus can't put the form into an impossible state.
  const status = params.get('status')
  if (status) {
    query.statuses = status
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is Status => s === 'active' || s === 'pending' || s === 'sold')
  }

  // Sort: only a known option; anything else keeps the default.
  const sort = params.get('sort')
  if (sort && sort in SORT_LABELS) query.sort = sort as SortOption

  // Page: must be a positive whole number; anything else falls back to 1.
  const page = Number(params.get('page'))
  query.page = Number.isInteger(page) && page > 0 ? page : 1
  return query
}

// ---------------------------------------------------------------------------
// HTTP calls
// ---------------------------------------------------------------------------

/** Base path of the versioned API. The Vite dev proxy and nginx forward it to the backend. */
export const API_BASE = '/api/v1'

/**
 * Retry policy. Exported (and mutable) so tests can set `baseDelayMs` to 0
 * instead of waiting for real backoff delays.
 */
export const RETRY = {
  /** Extra attempts after the first, so up to 3 requests in total. */
  retries: 2,
  /** Delay before the first retry; doubles on each attempt. */
  baseDelayMs: 300,
  /** Upper bound on any single wait, including a server's `Retry-After`. */
  maxDelayMs: 5000,
}

/** Statuses worth retrying: rate limited, or the API briefly unavailable. */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504])

/**
 * How long to wait before retry number `attempt` (starting at 0).
 *
 * @remarks
 * Exponential backoff (300 ms, 600 ms, 1.2 s, …) spaces retries out so a
 * struggling server gets room to recover. "Full jitter" then picks a random
 * point in the upper half of that window, so many clients that failed at the
 * same moment don't all retry at the same moment too.
 *
 * @param attempt - Zero-based retry number.
 * @param random - Source of randomness in [0, 1); injectable for tests.
 * @returns Milliseconds to wait, never more than `RETRY.maxDelayMs`.
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(RETRY.maxDelayMs, RETRY.baseDelayMs * 2 ** attempt)
  return Math.round(ceiling / 2 + random() * (ceiling / 2))
}

/**
 * Read a `Retry-After` header given in seconds.
 *
 * @param response - The 429/503 response.
 * @returns Milliseconds to wait (capped), or `undefined` if absent or unparseable.
 */
function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get('Retry-After'))
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, RETRY.maxDelayMs) : undefined
}

/**
 * Wait `ms` milliseconds, or reject straight away if `signal` aborts.
 *
 * @param ms - Delay in milliseconds.
 * @param signal - Abort signal; aborting cancels the wait.
 * @returns A promise that resolves after the delay.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal!.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** `true` for the error a fetch (or our sleep) throws when its signal aborts. */
function isAbort(err: unknown): boolean {
  return (err as Error)?.name === 'AbortError'
}

/**
 * GET a URL and parse the JSON body, turning every failure mode into an {@link ApiError}.
 *
 * @typeParam T - Expected shape of a successful response body.
 * @param url - Path to request, for example `/api/v1/meta`.
 * @param signal - Optional abort signal for cancelling the request (and any retry wait).
 * @returns The parsed response body.
 * @throws {@link ApiError} on a network failure or a non-2xx response, once retries are used up.
 * @throws `DOMException` named `AbortError` if `signal` is aborted. It's
 *   re-thrown untouched so callers can tell it apart and ignore it.
 */
async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const canRetry = attempt < RETRY.retries

    // Step 1: send the request. fetch() only rejects on network failure
    // (server down, offline) or an abort. HTTP error statuses resolve normally.
    let response: Response
    try {
      response = await fetch(url, { signal, headers: { Accept: 'application/json' } })
    } catch (err) {
      // A deliberate abort (a newer search replaced this one) is re-thrown
      // untouched so the caller can recognise and ignore it.
      if (isAbort(err)) throw err
      // Anything else means we never reached the server: worth another try.
      if (canRetry) {
        await sleep(backoffDelay(attempt), signal)
        continue
      }
      throw new ApiError('Could not reach the search service. Is the backend running?', 0, [], 'NETWORK')
    }

    // Step 2: a temporary failure with attempts left -> wait and go round
    // again. Prefer the server's Retry-After over our own backoff guess.
    if (RETRYABLE_STATUS.has(response.status) && canRetry) {
      await sleep(retryAfterMs(response) ?? backoffDelay(attempt), signal)
      continue
    }

    // Step 3: read the body as JSON. A proxy error page might be HTML, so a
    // parse failure isn't fatal here: we still want to report the status.
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      // fall through: non-JSON body is handled below
    }

    // Step 4: on an HTTP error, pull the message, code, field details and
    // request ID out of our standard error shape, with fallbacks.
    if (!response.ok) {
      const error = (
        body as { error?: { code?: string; message?: string; details?: FieldError[]; requestId?: string } } | null
      )?.error
      throw new ApiError(
        error?.message ?? `Request failed (${response.status})`,
        response.status,
        error?.details ?? [],
        error?.code ?? 'HTTP_ERROR',
        error?.requestId ?? response.headers.get('X-Request-ID') ?? undefined,
      )
    }

    // Step 5: success. Hand back the parsed body with its expected type.
    return body as T
  }
}

/**
 * Run a search against `GET /api/v1/listings`.
 *
 * @param query - The search to run.
 * @param signal - Lets the caller cancel the request if a newer search starts.
 * @returns One page of ranked results with pagination metadata and warnings.
 * @throws {@link ApiError} on validation errors (400) or network failure.
 */
export function searchListings(query: SearchQuery, signal?: AbortSignal): Promise<SearchResponse> {
  return getJson<SearchResponse>(`${API_BASE}/listings?${toSearchParams(query)}`, signal)
}

/**
 * Fetch one listing from `GET /api/v1/listings/{key}`, scored like the search that linked to it.
 *
 * @param listingKey - The listing's key.
 * @param context - The `targetBudget` and `asOf` of the current search, so the score matches.
 * @param signal - Optional abort signal.
 * @returns The listing in the same shape as a search result.
 * @throws {@link ApiError} with status 404 if no listing has that key.
 */
export function fetchListing(
  listingKey: string,
  context: Pick<SearchQuery, 'targetBudget' | 'asOf'>,
  signal?: AbortSignal,
): Promise<ListingResult> {
  const params = new URLSearchParams()
  if (context.targetBudget.trim()) params.set('targetBudget', context.targetBudget.trim())
  if (context.asOf.trim()) params.set('asOf', context.asOf.trim())
  const qs = params.toString()
  return getJson<ListingResult>(`${API_BASE}/listings/${encodeURIComponent(listingKey)}${qs ? `?${qs}` : ''}`, signal)
}

/**
 * Fetch reference data (the list of cities) from `GET /api/v1/meta`.
 *
 * @param signal - Optional abort signal for cancelling the request.
 * @returns Cities, statuses and the maximum page size.
 * @throws {@link ApiError} on network failure or a non-2xx response.
 */
export function fetchMeta(signal?: AbortSignal): Promise<Meta> {
  return getJson<Meta>(`${API_BASE}/meta`, signal)
}
