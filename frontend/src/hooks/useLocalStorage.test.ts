/**
 * Tests for {@link useLocalStorage} and {@link readStorage}.
 *
 * @module
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readStorage, useLocalStorage } from './useLocalStorage'

const isNumber = (v: unknown): v is number => typeof v === 'number'

afterEach(() => vi.restoreAllMocks())

describe('readStorage', () => {
  it('returns the fallback when nothing is stored', () => {
    expect(readStorage('k', 7, isNumber)).toBe(7)
  })

  it('returns a valid stored value', () => {
    localStorage.setItem('k', '42')
    expect(readStorage('k', 7, isNumber)).toBe(42)
  })

  it('ignores corrupt JSON', () => {
    localStorage.setItem('k', '{oops')
    expect(readStorage('k', 7, isNumber)).toBe(7)
  })

  it('ignores a value of the wrong shape', () => {
    localStorage.setItem('k', '"text"')
    expect(readStorage('k', 7, isNumber)).toBe(7)
  })

  it('survives storage being unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    expect(readStorage('k', 7, isNumber)).toBe(7)
  })
})

describe('useLocalStorage', () => {
  it('starts from the stored value and persists updates', () => {
    localStorage.setItem('k', '1')
    const { result } = renderHook(() => useLocalStorage('k', 0, isNumber))
    expect(result.current[0]).toBe(1)
    act(() => result.current[1](5))
    expect(result.current[0]).toBe(5)
    expect(localStorage.getItem('k')).toBe('5')
  })

  it('supports functional updates', () => {
    const { result } = renderHook(() => useLocalStorage('k', 1, isNumber))
    act(() => result.current[1]((n) => n + 1))
    act(() => result.current[1]((n) => n + 1))
    expect(result.current[0]).toBe(3)
  })

  it('keeps working in memory when saving fails', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    const { result } = renderHook(() => useLocalStorage('k', 0, isNumber))
    act(() => result.current[1](9))
    expect(result.current[0]).toBe(9)
  })
})
