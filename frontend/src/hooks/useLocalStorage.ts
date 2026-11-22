/**
 * State that survives a page reload, stored in `localStorage`.
 *
 * @module
 */

import { useCallback, useState } from 'react'

/**
 * Read a JSON value from `localStorage`, falling back on any problem.
 *
 * @remarks
 * Storage can be unavailable (private browsing, blocked cookies) and can hold
 * anything (an older app version's format, manual edits). Every access is
 * wrapped so storage trouble degrades to "nothing saved" instead of a crash.
 *
 * @typeParam T - Expected type of the stored value.
 * @param key - Storage key.
 * @param fallback - Value to use when nothing valid is stored.
 * @param isValid - Guard that checks the parsed value really is a `T`.
 * @returns The stored value, or `fallback`.
 */
export function readStorage<T>(key: string, fallback: T, isValid: (v: unknown) => v is T): T {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return fallback
    const parsed: unknown = JSON.parse(raw)
    return isValid(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

/**
 * Like `useState`, but persisted to `localStorage` under `key`.
 *
 * @typeParam T - Type of the value.
 * @param key - Storage key. Include a version (such as `":v1"`) so a future
 *   format change can start fresh instead of misreading old data.
 * @param fallback - Initial value when nothing valid is stored.
 * @param isValid - Guard that validates what was read back.
 * @returns `[value, setValue]`, as with `useState`.
 */
export function useLocalStorage<T>(key: string, fallback: T, isValid: (v: unknown) => v is T) {
  const [value, setValue] = useState<T>(() => readStorage(key, fallback, isValid))

  const update = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next
        try {
          window.localStorage.setItem(key, JSON.stringify(resolved))
        } catch {
          // Quota exceeded or storage disabled: keep the in-memory value anyway.
        }
        return resolved
      })
    },
    [key],
  )

  return [value, update] as const
}
