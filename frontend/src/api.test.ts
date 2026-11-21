/**
 * Unit tests for `api.ts`: the query-string helpers and the HTTP client.
 *
 * @remarks
 * Covers leaving out blanks and defaults, encoding every field, round-tripping
 * through the URL, ignoring junk in a hand-edited URL, and turning every
 * HTTP failure mode into an {@link ApiError}.
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  backoffDelay,
  EMPTY_QUERY,
  fetchListing,
  fetchMeta,
  fromSearchParams,
  RETRY,
  searchListings,
  toSearchParams,
} from './api'
import { page, respond, validationError } from './test/fixtures'

describe('toSearchParams', () => {
  it('omits blank fields and backend defaults', () => {
    expect(toSearchParams(EMPTY_QUERY).toString()).toBe('pageSize=10')
  })

  it('includes set fields, non-default statuses and pages after the first', () => {
    const qs = toSearchParams({
      ...EMPTY_QUERY,
      minPrice: ' 400000 ',
      city: 'Reston',
      keyword: 'pool, garage',
      statuses: ['active', 'pending'],
      page: 3,
    })
    expect(qs.get('minPrice')).toBe('400000')
    expect(qs.get('city')).toBe('Reston')
    expect(qs.get('keyword')).toBe('pool, garage')
    expect(qs.get('status')).toBe('active,pending')
    expect(qs.get('page')).toBe('3')
  })

  it('round-trips through the URL', () => {
    const query = { ...EMPTY_QUERY, targetBudget: '470000', statuses: ['pending' as const], page: 2 }
    expect(fromSearchParams(toSearchParams(query))).toEqual(query)
  })

  it('ignores junk in the URL rather than crashing', () => {
    const q = fromSearchParams(new URLSearchParams('page=-4&status=bogus,active'))
    expect(q.page).toBe(1)
    expect(q.statuses).toEqual(['active'])
  })
})

describe('fromSearchParams', () => {
  it('returns the defaults for an empty URL', () => {
    expect(fromSearchParams(new URLSearchParams())).toEqual(EMPTY_QUERY)
  })

  it('reads every text field as-is, leaving validation to the API', () => {
    const q = fromSearchParams(
      new URLSearchParams(
        'minPrice=abc&maxPrice=5&minBedrooms=2&city=Reston&keyword=pool&targetBudget=1&pageSize=20&asOf=2026-01-01',
      ),
    )
    expect(q).toMatchObject({
      minPrice: 'abc',
      maxPrice: '5',
      minBedrooms: '2',
      city: 'Reston',
      keyword: 'pool',
      targetBudget: '1',
      pageSize: '20',
      asOf: '2026-01-01',
    })
  })

  it('trims and filters statuses', () => {
    expect(fromSearchParams(new URLSearchParams('status= pending , sold')).statuses).toEqual(['pending', 'sold'])
  })

  it.each(['0', '2.5', 'abc'])('falls back to page 1 for page=%s', (p) => {
    expect(fromSearchParams(new URLSearchParams(`page=${p}`)).page).toBe(1)
  })
})

describe('toSearchParams edge cases', () => {
  it('omits whitespace-only fields', () => {
    expect(toSearchParams({ ...EMPTY_QUERY, city: '   ', pageSize: '' }).toString()).toBe('')
  })

  it('omits the default active-only status but keeps any other single status', () => {
    expect(toSearchParams({ ...EMPTY_QUERY, statuses: ['sold'] }).get('status')).toBe('sold')
    expect(toSearchParams({ ...EMPTY_QUERY, statuses: [] }).has('status')).toBe(false)
  })

  it('omits page 1', () => {
    expect(toSearchParams({ ...EMPTY_QUERY, page: 1 }).has('page')).toBe(false)
  })
})

describe('HTTP calls', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('searchListings requests /api/v1/listings with the encoded query and returns the body', async () => {
    fetchMock.mockReturnValue(respond(200, page()))
    const controller = new AbortController()
    const data = await searchListings({ ...EMPTY_QUERY, city: 'Vienna' }, controller.signal)
    expect(data).toEqual(page())
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/listings?city=Vienna&pageSize=10',
      expect.objectContaining({ signal: controller.signal }),
    )
  })

  it('fetchMeta requests /api/v1/meta', async () => {
    const meta = { cities: ['Vienna'], statuses: ['active'], maxPageSize: 100 }
    fetchMock.mockReturnValue(respond(200, meta))
    await expect(fetchMeta()).resolves.toEqual(meta)
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/meta', expect.objectContaining({ signal: undefined }))
  })

  it('turns a 400 into an ApiError carrying the message and field details', async () => {
    fetchMock.mockReturnValue(respond(400, validationError))
    const err = await searchListings(EMPTY_QUERY).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({
      message: 'One or more search parameters are invalid.',
      status: 400,
      details: validationError.error.details,
    })
  })

  it('uses a generic message when an error body is not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('<h1>Bad gateway</h1>', { status: 502 }))
    await expect(searchListings(EMPTY_QUERY)).rejects.toMatchObject({
      message: 'Request failed (502)',
      status: 502,
      details: [],
    })
  })

  it('uses a generic message when an error body lacks the error shape', async () => {
    fetchMock.mockReturnValue(respond(500, { detail: 'boom' }))
    await expect(fetchMeta()).rejects.toMatchObject({ message: 'Request failed (500)', status: 500 })
  })

  it('reports a network failure as status 0', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(searchListings(EMPTY_QUERY)).rejects.toMatchObject({
      message: 'Could not reach the search service. Is the backend running?',
      status: 0,
    })
  })

  it('re-throws an abort untouched so callers can ignore it', async () => {
    const abort = new DOMException('aborted', 'AbortError')
    fetchMock.mockRejectedValue(abort)
    await expect(searchListings(EMPTY_QUERY)).rejects.toBe(abort)
  })

  it('ApiError defaults to no details', () => {
    const err = new ApiError('x', 0)
    expect(err.details).toEqual([])
    expect(err).toBeInstanceOf(Error)
  })
})

describe('sort in the URL', () => {
  it('omits the default and round-trips the others', () => {
    expect(toSearchParams(EMPTY_QUERY).has('sort')).toBe(false)
    const q = { ...EMPTY_QUERY, sort: 'price_desc' as const }
    expect(toSearchParams(q).get('sort')).toBe('price_desc')
    expect(fromSearchParams(toSearchParams(q)).sort).toBe('price_desc')
  })

  it('ignores an unknown sort in a hand-edited URL', () => {
    expect(fromSearchParams(new URLSearchParams('sort=cheapest')).sort).toBe('relevance')
  })
})

describe('backoffDelay', () => {
  const saved = { ...RETRY }
  beforeEach(() => Object.assign(RETRY, { baseDelayMs: 300, maxDelayMs: 5000 }))
  afterEach(() => Object.assign(RETRY, saved))

  it('doubles the window each attempt, landing in its upper half (jitter)', () => {
    expect(backoffDelay(0, () => 0)).toBe(150)
    expect(backoffDelay(0, () => 0.999999)).toBe(300)
    expect(backoffDelay(1, () => 0)).toBe(300)
    expect(backoffDelay(2, () => 0)).toBe(600)
  })

  it('never exceeds the maximum', () => {
    expect(backoffDelay(20, () => 0.999999)).toBe(5000)
  })
})

describe('retries', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it.each([429, 502, 503, 504])('retries a %i and succeeds', async (status) => {
    fetchMock.mockReturnValueOnce(respond(status, {})).mockReturnValueOnce(respond(200, page()))
    await expect(searchListings(EMPTY_QUERY)).resolves.toEqual(page())
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries a network failure and succeeds', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('offline')).mockReturnValueOnce(respond(200, page()))
    await expect(searchListings(EMPTY_QUERY)).resolves.toEqual(page())
  })

  it('gives up after RETRY.retries extra attempts and reports the last error', async () => {
    fetchMock.mockImplementation(() => respond(503, { error: { code: 'UNAVAILABLE', message: 'Down', details: [] } }))
    await expect(searchListings(EMPTY_QUERY)).rejects.toMatchObject({
      status: 503,
      code: 'UNAVAILABLE',
      message: 'Down',
    })
    expect(fetchMock).toHaveBeenCalledTimes(RETRY.retries + 1)
  })

  it.each([400, 404, 500])('never retries a %i', async (status) => {
    fetchMock.mockImplementation(() => respond(status, {}))
    await expect(searchListings(EMPTY_QUERY)).rejects.toMatchObject({ status })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('honours Retry-After on a 429', async () => {
    const saved = { ...RETRY }
    Object.assign(RETRY, { baseDelayMs: 300, maxDelayMs: 5000 })
    vi.useFakeTimers()
    try {
      fetchMock
        .mockReturnValueOnce(Promise.resolve(new Response('{}', { status: 429, headers: { 'Retry-After': '2' } })))
        .mockReturnValueOnce(respond(200, page()))
      const pending = searchListings(EMPTY_QUERY)
      await vi.advanceTimersByTimeAsync(1999)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      await expect(pending).resolves.toEqual(page())
    } finally {
      vi.useRealTimers()
      Object.assign(RETRY, saved)
    }
  })

  it('stops waiting and rejects with AbortError when aborted mid-backoff', async () => {
    const saved = { ...RETRY }
    Object.assign(RETRY, { baseDelayMs: 10_000, maxDelayMs: 10_000 })
    try {
      fetchMock.mockReturnValue(respond(503, {}))
      const controller = new AbortController()
      const pending = searchListings(EMPTY_QUERY, controller.signal)
      await new Promise((r) => setTimeout(r, 0))
      controller.abort()
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      expect(fetchMock).toHaveBeenCalledOnce()
    } finally {
      Object.assign(RETRY, saved)
    }
  })

  it('does not start a retry wait for an already-aborted signal', async () => {
    const saved = { ...RETRY }
    Object.assign(RETRY, { baseDelayMs: 10_000, maxDelayMs: 10_000 })
    try {
      const controller = new AbortController()
      fetchMock.mockImplementation(() => {
        controller.abort()
        return Promise.reject(new TypeError('offline'))
      })
      await expect(searchListings(EMPTY_QUERY, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      Object.assign(RETRY, saved)
    }
  })
})

describe('error details', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('carries the server code and request ID from a 500', async () => {
    fetchMock.mockReturnValue(
      respond(500, { error: { code: 'INTERNAL_ERROR', message: 'Oops', details: [], requestId: 'r-1' } }),
    )
    await expect(searchListings(EMPTY_QUERY)).rejects.toMatchObject({ code: 'INTERNAL_ERROR', requestId: 'r-1' })
  })

  it('falls back to the X-Request-ID header', async () => {
    fetchMock.mockResolvedValue(new Response('oops', { status: 500, headers: { 'X-Request-ID': 'hdr-1' } }))
    await expect(searchListings(EMPTY_QUERY)).rejects.toMatchObject({ requestId: 'hdr-1', code: 'HTTP_ERROR' })
  })

  it('marks network failures with code NETWORK', async () => {
    fetchMock.mockRejectedValue(new TypeError('offline'))
    await expect(fetchMeta()).rejects.toMatchObject({ code: 'NETWORK', status: 0, name: 'ApiError' })
  })
})

describe('fetchListing', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn(() => respond(200, page().results[0]))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('requests the encoded key with no query when there is no context', async () => {
    await fetchListing('1 Main St/#2', { targetBudget: '', asOf: '' })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/listings/1%20Main%20St%2F%232')
  })

  it('passes trimmed targetBudget and asOf', async () => {
    await fetchListing('k', { targetBudget: ' 500000 ', asOf: '2026-09-01' })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/listings/k?targetBudget=500000&asOf=2026-09-01')
  })

  it('returns the listing', async () => {
    await expect(fetchListing('k', { targetBudget: '', asOf: '' })).resolves.toEqual(page().results[0])
  })
})
