/**
 * Shared test data and fetch helpers, shaped like the real API's JSON.
 *
 * @module
 */

import type { ListingResult, Pagination, SearchResponse } from '../api'

/** A realistic result row. */
export const listing: ListingResult = {
  listingKey: '55-elm-ct-vienna-va',
  address: '55 Elm Ct',
  city: 'Vienna',
  state: 'VA',
  zip: '22180',
  price: 470000,
  bedrooms: 3,
  bathrooms: 2,
  sqft: 1300,
  latitude: 38.9012,
  longitude: -77.2653,
  listedDate: '2026-08-15',
  status: 'active',
  description: 'Quiet cul-de-sac.',
  relevanceScore: 0.7312,
  scoreBreakdown: { budget: 1, recency: 0.1, daysOnMarket: 98 },
  photos: [],
  sources: [
    { source: 'MLS_A', id: 'A5', address: '55 Elm Ct', price: 470000, listedDate: '2026-09-04', status: 'active' },
  ],
}

/** A second, distinct row: pending, no target budget, two source feeds. */
export const listing2: ListingResult = {
  ...listing,
  listingKey: '12-oak-ave-reston-va',
  address: '12 Oak Ave',
  city: 'Reston',
  zip: '20190',
  price: 615000,
  bedrooms: 4,
  bathrooms: 3.5,
  sqft: 2450,
  latitude: 38.9586,
  longitude: -77.357,
  listedDate: '2026-07-01',
  status: 'pending',
  description: 'Corner lot with pool.',
  relevanceScore: 0.4,
  scoreBreakdown: { budget: null, recency: 0.4, daysOnMarket: 143 },
  photos: [],
  sources: [
    { source: 'MLS_A', id: 'A9', address: '12 Oak Avenue', price: 615000, listedDate: '2026-07-01', status: 'pending' },
    { source: 'MLS_B', id: 'B3', address: '12 Oak Ave', price: 610000, listedDate: '2026-06-28', status: 'pending' },
  ],
}

/**
 * Build pagination metadata.
 *
 * @param overrides - Fields to replace.
 * @returns A complete `Pagination`.
 */
export const pagination = (overrides: Partial<Pagination> = {}): Pagination => ({
  page: 1,
  pageSize: 10,
  totalResults: 1,
  totalPages: 1,
  hasPrevious: false,
  hasNext: false,
  ...overrides,
})

/**
 * Build a search response containing {@link listing}.
 *
 * @param overrides - Fields to replace, such as an empty `results` list.
 * @returns A complete `SearchResponse`.
 */
export const page = (overrides: Partial<SearchResponse> = {}): SearchResponse => ({
  results: [listing],
  pagination: pagination(),
  warnings: [],
  ...overrides,
})

/** A response with zero matches. */
export const emptyPage = () => page({ results: [], pagination: pagination({ totalResults: 0, totalPages: 0 }) })

/**
 * Create a fake `fetch` response with a JSON body.
 *
 * @param status - HTTP status code.
 * @param body - Value to serialise as the JSON body.
 * @returns A resolved promise, as `fetch` would return.
 */
export function respond(status: number, body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  )
}

/** A 400 body in the API's standard error shape. */
export const validationError = {
  error: {
    code: 'INVALID_PARAMETERS',
    message: 'One or more search parameters are invalid.',
    details: [{ field: 'minPrice', message: 'must not be greater than maxPrice (6 > 5)' }],
  },
}
