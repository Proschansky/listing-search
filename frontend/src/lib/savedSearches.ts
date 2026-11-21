/**
 * The saved-search data model: its stored shape, limits, validation and the
 * human-readable summary used as a default name.
 *
 * @remarks
 * Kept apart from the `SavedSearches` component so the rules can be unit
 * tested on their own, and so the component file exports only a component
 * (which React Fast Refresh needs to hot-reload it reliably).
 *
 * @module
 */

import { SORT_LABELS, type SearchQuery } from '../api'
import { usd } from './format'

/** One saved search as stored in `localStorage`. */
export interface SavedSearch {
  /** Unique id (creation time plus a random suffix). */
  id: string
  name: string
  /**
   * The search as a query string, e.g. `"city=Vienna&pageSize=10"`.
   *
   * @remarks
   * Stored in the same format as the page URL, so a saved search and a
   * shared link are always interchangeable, and old saves stay readable
   * because `fromSearchParams` already tolerates junk and missing fields.
   */
  params: string
  /** ISO timestamp of when it was saved. */
  createdAt: string
}

/** Storage key; bump the version if the stored shape ever changes. */
export const SAVED_KEY = 'listing-search:saved-searches:v1'

/** Keeps the list short enough to scan; the oldest save is dropped first. */
export const MAX_SAVED = 10

/**
 * Runtime check that storage really holds a list of saved searches.
 *
 * @param v - Whatever was parsed from storage.
 * @returns `true` if it's safe to treat `v` as `SavedSearch[]`.
 */
export const isSavedList = (v: unknown): v is SavedSearch[] =>
  Array.isArray(v) &&
  v.every((s) => s && typeof s.id === 'string' && typeof s.name === 'string' && typeof s.params === 'string')

/**
 * Summarise a search in a few words, used as the default name.
 *
 * @param q - The search to describe.
 * @returns e.g. `"Vienna · 3+ bd · $400,000–$650,000 · "pool""`, or `"All active listings"`.
 */
export function describeQuery(q: SearchQuery): string {
  const parts: string[] = []
  if (q.city.trim()) parts.push(q.city.trim())
  if (q.minBedrooms.trim()) parts.push(`${q.minBedrooms.trim()}+ bd`)
  const min = Number(q.minPrice)
  const max = Number(q.maxPrice)
  if (q.minPrice.trim() && q.maxPrice.trim()) parts.push(`${usd.format(min)}–${usd.format(max)}`)
  else if (q.minPrice.trim()) parts.push(`from ${usd.format(min)}`)
  else if (q.maxPrice.trim()) parts.push(`up to ${usd.format(max)}`)
  if (q.keyword.trim()) parts.push(`"${q.keyword.trim()}"`)
  if (q.targetBudget.trim()) parts.push(`budget ${usd.format(Number(q.targetBudget))}`)
  if (q.statuses.join() !== 'active') parts.push(q.statuses.join('/'))
  if (q.sort !== 'relevance') parts.push(SORT_LABELS[q.sort])
  return parts.length ? parts.join(' · ') : 'All active listings'
}
