/// <reference types="vitest/config" />
/**
 * Vite and Vitest configuration.
 *
 * @remarks
 * - `server.proxy` forwards `/api/*` to the FastAPI server in development, so
 *   the UI has no hard-coded backend URL and needs no CORS setup. Set
 *   `API_URL` to point it somewhere other than `http://localhost:8000`.
 * - `css` configures the styling setup: SCSS Modules (`*.module.scss`, one
 *   per component) plus one global sheet (`src/styles/global.scss`).
 *   Class names in SCSS are kebab-case (`.card-link`) and are read in
 *   TypeScript as camelCase (`styles.cardLink`). Shared partials
 *   (`_tokens.scss`, `_mixins.scss`) are found via `loadPaths`, so any file
 *   can `@use 'mixins' as m;` without relative paths.
 * - `test` runs unit, component and accessibility tests in a simulated
 *   browser (jsdom), with coverage thresholds that fail the run if unmet.
 *   CSS Modules there keep their original class names (`non-scoped`), so
 *   tests can select `.stale` or check `badge-active`. Real builds hash
 *   them, so no two components' classes can ever collide.
 *   Playwright end-to-end tests live in `e2e/` and are excluded here.
 *
 * @module
 */
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  css: {
    modules: { localsConvention: 'camelCaseOnly' },
    preprocessorOptions: {
      scss: { loadPaths: [fileURLToPath(new URL('./src/styles', import.meta.url))] },
    },
  },
  // Pre-bundle Leaflet at startup. Otherwise Vite discovers it the first time
  // the map view opens and reloads the page mid-session, which can land in the
  // middle of a user action (or an e2e test).
  optimizeDeps: { include: ['leaflet'] },
  server: {
    proxy: {
      '/api': process.env.API_URL ?? 'http://localhost:8000',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    // Vitest's default is 5 s per test. Tests that type with userEvent (one
    // key at a time) and run full-page axe audits can exceed that on a busy
    // machine (e.g. while a git hook runs everything at once), failing for
    // reasons that have nothing to do with the code. 15 s still catches a
    // genuine hang.
    testTimeout: 15_000,
    css: { include: /\.module\.scss$/, modules: { classNameStrategy: 'non-scoped' } },
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.mjs'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}', 'scripts/lib/**/*.mjs'],
      exclude: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.mjs', 'src/test/**', 'src/test-setup.ts'],
      // The build fails (and so do CI and the pre-push hook) if coverage
      // drops below these. Raise them as coverage improves; never lower them
      // to get a change through.
      thresholds: { statements: 95, branches: 95, functions: 95, lines: 95 },
    },
  },
})
