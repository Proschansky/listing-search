/**
 * Tests for {@link useDebouncedCallback}, with fake timers.
 *
 * @module
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDebouncedCallback } from './useDebouncedCallback'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('useDebouncedCallback', () => {
  it('runs only after the quiet period', () => {
    const fn = vi.fn()
    const { result } = renderHook(() => useDebouncedCallback(fn, 300))
    act(() => result.current[0]('a'))
    act(() => vi.advanceTimersByTime(299))
    expect(fn).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(fn).toHaveBeenCalledExactlyOnceWith('a')
  })

  it('restarts the timer on every call and uses the last arguments', () => {
    const fn = vi.fn()
    const { result } = renderHook(() => useDebouncedCallback(fn, 300))
    act(() => result.current[0]('a'))
    act(() => vi.advanceTimersByTime(200))
    act(() => result.current[0]('ab'))
    act(() => vi.advanceTimersByTime(200))
    expect(fn).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(100))
    expect(fn).toHaveBeenCalledExactlyOnceWith('ab')
  })

  it('always calls the latest function', () => {
    const first = vi.fn()
    const latest = vi.fn()
    const { result, rerender } = renderHook(({ fn }) => useDebouncedCallback(fn, 100), { initialProps: { fn: first } })
    act(() => result.current[0]())
    rerender({ fn: latest })
    act(() => vi.advanceTimersByTime(100))
    expect(latest).toHaveBeenCalledOnce()
    expect(first).not.toHaveBeenCalled()
  })

  it('cancel() drops a pending call', () => {
    const fn = vi.fn()
    const { result } = renderHook(() => useDebouncedCallback(fn, 100))
    act(() => result.current[0]())
    act(() => result.current[1]())
    act(() => vi.advanceTimersByTime(500))
    expect(fn).not.toHaveBeenCalled()
  })

  it('never fires after unmount', () => {
    const fn = vi.fn()
    const { result, unmount } = renderHook(() => useDebouncedCallback(fn, 100))
    act(() => result.current[0]())
    unmount()
    vi.advanceTimersByTime(500)
    expect(fn).not.toHaveBeenCalled()
  })
})
