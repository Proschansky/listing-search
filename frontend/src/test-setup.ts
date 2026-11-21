/**
 * Vitest setup, run before every test file.
 *
 * @remarks
 * - Adds jest-dom's DOM matchers, such as `toBeInTheDocument()` and
 *   `toHaveAttribute()`, to Vitest's `expect`.
 * - Removes the API client's retry delays, so tests of retry behaviour
 *   don't wait for real backoff. (The delay maths itself is unit-tested via
 *   `backoffDelay` in `api.test.ts`.)
 * - Clears `localStorage` and the theme attribute after each test, so saved
 *   searches and preferences never leak from one test into the next.
 *
 * @module
 */

import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { RETRY } from './api'

RETRY.baseDelayMs = 0
RETRY.maxDelayMs = 0

afterEach(() => {
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})
