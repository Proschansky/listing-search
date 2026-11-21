/**
 * Unit tests for the saved-search data rules.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { EMPTY_QUERY } from '../api'
import { describeQuery, isSavedList } from './savedSearches'

describe('describeQuery', () => {
  it('names the default search', () => {
    expect(describeQuery(EMPTY_QUERY)).toBe('All active listings')
  })

  it('summarises every set filter in order', () => {
    expect(
      describeQuery({
        ...EMPTY_QUERY,
        city: ' Vienna ',
        minBedrooms: '3',
        minPrice: '400000',
        maxPrice: '650000',
        keyword: 'pool',
        targetBudget: '500000',
        statuses: ['active', 'pending'],
        sort: 'price_asc',
      }),
    ).toBe('Vienna · 3+ bd · $400,000–$650,000 · "pool" · budget $500,000 · active/pending · Price: low to high')
  })

  it('describes one-sided price ranges', () => {
    expect(describeQuery({ ...EMPTY_QUERY, minPrice: '400000' })).toBe('from $400,000')
    expect(describeQuery({ ...EMPTY_QUERY, maxPrice: '650000' })).toBe('up to $650,000')
  })
})

describe('isSavedList', () => {
  it('accepts a list of well-formed saves', () => {
    expect(isSavedList([])).toBe(true)
    expect(isSavedList([{ id: '1', name: 'n', params: 'city=x', createdAt: '' }])).toBe(true)
  })

  it.each([null, {}, 'x', [{ id: 1, name: 'n', params: '' }], [{ id: '1', name: 'n' }], [null]])('rejects %j', (v) => {
    expect(isSavedList(v)).toBe(false)
  })
})
