/**
 * Playwright end-to-end test configuration.
 *
 * @remarks
 * End-to-end tests drive a real browser against the real stack: the FastAPI
 * backend on the bundled sample data, and the Vite dev server in front of it.
 * Nothing is mocked, except that OpenStreetMap map tiles are blocked so tests
 * never depend on the internet (see `e2e/fixtures.ts`).
 *
 * `webServer` starts the servers before the tests and stops them after. They
 * use their own ports (API 8100, UI 5180, and a second API on 8101 for the
 * data-sources spec), so the suite can run while a dev server is up on the
 * usual 8000/5173. With `reuseExistingServer`, a server
 * already listening on those ports is reused locally (faster iterations) but
 * never in CI.
 *
 * Browser: CI (Linux) uses Playwright's bundled Chromium. Locally it uses
 * the installed Google Chrome (`channel: 'chrome'`), because Playwright's
 * Chromium download doesn't support every OS version (macOS 12, for one). Set
 * `PW_CHANNEL=chromium` to force the bundled one.
 *
 * Run: `npm run test:e2e` (headless) or `npm run test:e2e -- --ui` (watch it).
 *
 * @module
 */

import { defineConfig, devices } from '@playwright/test'

const API_PORT = 8100
// A second API with the SimplyRETS source switched on, for e2e/sources.spec.ts.
// It's offline: SimplyRETS's URL points at a closed port, so it serves a
// saved snapshot (a hand-written test fixture) and reports itself degraded.
export const SOURCES_API_PORT = 8101
const UI_PORT = 5180
const isCI = Boolean(process.env.CI)
const channel = process.env.PW_CHANNEL ?? (isCI ? 'chromium' : 'chrome')

export default defineConfig({
  testDir: './e2e',
  // Each test gets a fresh browser context (cookies, storage), so tests are
  // independent and safe to run in parallel.
  fullyParallel: true,
  // Locally, a few workers is plenty and doesn't swamp the machine with
  // browser windows; CI runners get Playwright's default.
  workers: isCI ? undefined : 4,
  // A stray test.only must never silently skip the rest of the suite in CI.
  forbidOnly: isCI,
  // Retry in CI only, and record a trace when a retry happens, so a flaky
  // failure can be replayed step by step (npx playwright show-trace ...).
  retries: isCI ? 2 : 0,
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  // Evidence runs (npm run pr:evidence) also take full-page screenshots and
  // render a network panel per test, so they get more time.
  timeout: process.env.PW_EVIDENCE_DIR ? 60_000 : 30_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL: `http://127.0.0.1:${UI_PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // Video needs Playwright's ffmpeg download, which (like its Chromium)
    // isn't available on every OS (macOS 12, for one), so it's recorded in CI only.
    // Traces and screenshots cover local debugging.
    video: isCI ? 'retain-on-failure' : 'off',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel } },
    // The layout changes below 640px; run the smoke tests at phone size too.
    { name: 'mobile', use: { ...devices['Pixel 7'], channel }, grep: /@smoke/ },
  ],
  webServer: [
    {
      // The real API. Rate limiting is off because the whole suite comes from
      // one IP; the limiter has its own backend tests.
      command: `../backend/.venv/bin/uvicorn app.main:app --port ${API_PORT}`,
      cwd: '../backend',
      url: `http://127.0.0.1:${API_PORT}/api/v1/health/ready`,
      env: { LISTING_RATE_LIMIT_ENABLED: 'false', LISTING_ENVIRONMENT: 'test' },
      reuseExistingServer: !isCI,
      timeout: 60_000,
    },
    {
      // Sample data plus SimplyRETS, with no internet needed (see SOURCES_API_PORT).
      command: `../backend/.venv/bin/uvicorn app.main:app --port ${SOURCES_API_PORT}`,
      cwd: '../backend',
      url: `http://127.0.0.1:${SOURCES_API_PORT}/api/v1/health/ready`,
      env: {
        LISTING_RATE_LIMIT_ENABLED: 'false',
        LISTING_ENVIRONMENT: 'test',
        LISTING_SOURCES: '["sample","simplyrets"]',
        LISTING_SIMPLYRETS_URL: 'http://127.0.0.1:9/properties',
        LISTING_SIMPLYRETS_TIMEOUT_SECONDS: '0.5',
        LISTING_SIMPLYRETS_CACHE_PATH: 'tests/fixtures/simplyrets_snapshot.json',
      },
      reuseExistingServer: !isCI,
      timeout: 60_000,
    },
    {
      // The UI, proxying /api to the API above (see vite.config.ts).
      command: `npm run dev -- --port ${UI_PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${UI_PORT}`,
      env: { API_URL: `http://127.0.0.1:${API_PORT}` },
      reuseExistingServer: !isCI,
      timeout: 60_000,
    },
  ],
})
