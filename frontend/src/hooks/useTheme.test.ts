/**
 * Tests for {@link useTheme}.
 *
 * @module
 */

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { THEME_KEY, useTheme } from './useTheme'

const attr = () => document.documentElement.getAttribute('data-theme')

describe('useTheme', () => {
  it('defaults to following the system, with no attribute set', () => {
    const { result } = renderHook(() => useTheme())
    expect(result.current[0]).toBe('system')
    expect(attr()).toBeNull()
  })

  it('forces light or dark via data-theme and remembers the choice', () => {
    const { result } = renderHook(() => useTheme())
    act(() => result.current[1]('dark'))
    expect(attr()).toBe('dark')
    expect(localStorage.getItem(THEME_KEY)).toBe('"dark"')
    act(() => result.current[1]('light'))
    expect(attr()).toBe('light')
  })

  it('removes the attribute again for system', () => {
    const { result } = renderHook(() => useTheme())
    act(() => result.current[1]('dark'))
    act(() => result.current[1]('system'))
    expect(attr()).toBeNull()
  })

  it('restores a saved preference on load and ignores junk', () => {
    localStorage.setItem(THEME_KEY, '"dark"')
    expect(renderHook(() => useTheme()).result.current[0]).toBe('dark')
    localStorage.setItem(THEME_KEY, '"purple"')
    expect(renderHook(() => useTheme()).result.current[0]).toBe('system')
  })
})
