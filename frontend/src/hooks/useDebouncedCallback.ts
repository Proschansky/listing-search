/**
 * Debouncing for "search as you type".
 *
 * @module
 */

import { useCallback, useEffect, useRef } from 'react'

/**
 * Wrap `fn` so that it only runs once calls have stopped for `delayMs`.
 *
 * @remarks
 * While the user types "Springfield", the form changes on every key press.
 * Searching on each one would send 11 requests, most of them useless. The
 * debounced function restarts its timer on every call, so `fn` runs once,
 * with the arguments of the *last* call, after typing pauses.
 *
 * - The latest `fn` is always the one called (it's kept in a ref), so the
 *   caller never sees stale state.
 * - A pending call is cancelled when the component unmounts, so nothing
 *   fires against a page that's gone.
 * - `cancel()` drops a pending call (e.g. when the user submits by hand).
 *
 * Firing from a timer callback (rather than syncing a debounced *value* into
 * state from an effect) follows React's guidance: state changes come from
 * events, not from effects reacting to other state.
 *
 * @typeParam A - The function's argument types.
 * @param fn - The function to debounce.
 * @param delayMs - Quiet period before `fn` runs.
 * @returns `[debounced, cancel]`.
 */
export function useDebouncedCallback<A extends unknown[]>(fn: (...args: A) => void, delayMs: number) {
  const fnRef = useRef(fn)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    fnRef.current = fn
  }, [fn])

  const cancel = useCallback(() => clearTimeout(timer.current), [])

  // Cancel any pending call on unmount.
  useEffect(() => cancel, [cancel])

  const debounced = useCallback(
    (...args: A) => {
      clearTimeout(timer.current)
      timer.current = setTimeout(() => fnRef.current(...args), delayMs)
    },
    [delayMs],
  )

  return [debounced, cancel] as const
}
