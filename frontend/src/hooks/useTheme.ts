/**
 * Light / dark / system colour theme.
 *
 * @module
 */

import { useEffect } from 'react'
import { useLocalStorage } from './useLocalStorage'

/** `system` follows the operating system's setting; the others force a theme. */
export type ThemePreference = 'system' | 'light' | 'dark'

/** Storage key for the saved preference. */
export const THEME_KEY = 'listing-search:theme:v1'

const isTheme = (v: unknown): v is ThemePreference => v === 'system' || v === 'light' || v === 'dark'

/**
 * The user's theme preference, persisted and applied to the page.
 *
 * @remarks
 * The stylesheet defines the light palette by default and the dark one under
 * `prefers-color-scheme: dark`. Setting `data-theme` on `<html>` overrides
 * that in either direction; `system` removes the attribute so the OS decides.
 *
 * @returns `[preference, setPreference]`.
 */
export function useTheme() {
  const [theme, setTheme] = useLocalStorage<ThemePreference>(THEME_KEY, 'system', isTheme)

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
  }, [theme])

  return [theme, setTheme] as const
}
