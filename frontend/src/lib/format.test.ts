/**
 * Unit tests for the shared display formatters.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { formatDate, usd } from './format'

describe('usd', () => {
  it('formats whole dollars with separators and no cents', () => {
    expect(usd.format(450000)).toBe('$450,000')
    expect(usd.format(399999.6)).toBe('$400,000')
  })
})

describe('formatDate', () => {
  it('formats an ISO date as a short US date', () => {
    expect(formatDate('2026-03-04')).toBe('Mar 4, 2026')
  })

  it('never shifts the day, whatever the time zone', () => {
    // A naive new Date('2026-01-01') shown in a UTC-5 zone reads Dec 31.
    expect(formatDate('2026-01-01')).toBe('Jan 1, 2026')
  })

  it('returns unparseable input unchanged', () => {
    expect(formatDate('soon')).toBe('soon')
  })
})
