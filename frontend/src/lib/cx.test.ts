/**
 * Unit tests for {@link cx}.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { cx } from './cx'

describe('cx', () => {
  it('joins class names with spaces', () => {
    expect(cx('a', 'b', 'c')).toBe('a b c')
  })

  it('drops false, null, undefined and empty names', () => {
    const selected = false
    expect(cx('card', selected && 'selected', null, undefined, '', 'listing')).toBe('card listing')
  })

  it('returns an empty string when nothing is left', () => {
    expect(cx(false, undefined)).toBe('')
  })
})
