/**
 * Shared setup for every end-to-end test.
 *
 * @remarks
 * Extends Playwright's `test` so every test automatically:
 * - blocks OpenStreetMap tile requests, so the map view works offline and
 *   tests never depend on (or load) a third-party server;
 * - fails if the page logs a console error or throws an uncaught exception,
 *   which catches broken UI that still happens to pass its assertions.
 *
 * - records PR evidence when `PW_EVIDENCE_DIR` is set (by `npm run
 *   pr:evidence`): screenshots of the UI, every `/api` request and response,
 *   and a DevTools-style network panel built from them. Tests can add named
 *   screenshots at key moments with `await evidence.capture('Drawer open')`;
 *   a final screenshot is always taken. In normal runs `capture` does nothing.
 *
 * Also exports small helpers for the things most tests do.
 *
 * @module
 */

import { test as base, expect, type Page, type Request, type Response, type TestInfo } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { renderNetworkHtml, slug, type NetworkEntry } from '../scripts/lib/evidence.mjs'

/** What tests can do with evidence. */
export interface Evidence {
  /** Save a named screenshot of the page right now (no-op outside evidence runs). */
  capture(label: string): Promise<void>
}

/** `true` for the app's own API calls (not the page, assets or map tiles). */
const isApi = (url: string) => new URL(url).pathname.startsWith('/api/')

/** OpenStreetMap tile requests, which every test blocks. */
const TILE_URL = /tile\.openstreetmap\.org/

/**
 * Record one test's evidence into `<root>/<test slug>/`.
 *
 * @param page - The test's page.
 * @param testInfo - Playwright's info about the running test.
 * @param root - The run folder (`PW_EVIDENCE_DIR`).
 * @returns The `Evidence` handle and a `finish` step to run after the test.
 */
function recordEvidence(page: Page, testInfo: TestInfo, root: string) {
  const file = relative(join(testInfo.config.rootDir, '..'), testInfo.file)
  const title = testInfo.titlePath.slice(1).join(' › ')
  const dir = join(root, slug(`${basename(file, '.spec.ts')} ${title}`))
  mkdirSync(dir, { recursive: true })

  const screenshots: { label: string; file: string }[] = []
  const network: NetworkEntry[] = []
  const pending: Promise<void>[] = []
  const startedAt = new Map<Request, number>()

  page.on('request', (req) => {
    if (isApi(req.url())) startedAt.set(req, Date.now())
  })
  const record = async (req: Request, res: Response | null) => {
    const url = new URL(req.url())
    let body: unknown
    if (res) body = await res.json().catch(() => res.text().catch(() => ''))
    network.push({
      method: req.method(),
      url: url.pathname + url.search,
      status: res?.status() ?? 0,
      durationMs: Date.now() - (startedAt.get(req) ?? Date.now()),
      requestId: res?.headers()['x-request-id'],
      contentType: res?.headers()['content-type'],
      body,
      error: res ? undefined : (req.failure()?.errorText ?? 'failed'),
    })
  }
  page.on('response', (res) => {
    if (isApi(res.url())) pending.push(record(res.request(), res))
  })
  page.on('requestfailed', (req) => {
    if (isApi(req.url())) pending.push(record(req, null))
  })
  // Map tiles are blocked for every test (see `consoleErrors` above). Note
  // whether this test tried to load any, so the PR evidence can explain why
  // its map screenshots show markers on a blank background.
  let mapTilesBlocked = false
  page.on('requestfailed', (req) => {
    if (TILE_URL.test(req.url())) mapTilesBlocked = true
  })

  const evidence: Evidence = {
    async capture(label) {
      const name = `${String(screenshots.length + 1).padStart(2, '0')}-${slug(label)}.png`
      // The whole page normally, so long result lists are fully visible. With
      // a modal open, just the viewport: a full-page capture would stretch
      // the page under the fixed-position dialog and garble the picture.
      const modalOpen = (await page.locator('[aria-modal="true"]').count()) > 0
      await page.screenshot({ path: join(dir, name), fullPage: !modalOpen })
      screenshots.push({ label, file: name })
    },
  }

  const finish = async () => {
    if (!page.isClosed()) await evidence.capture('Final state').catch(() => {})
    await Promise.allSettled(pending)
    // Render the network panel in a separate page of the same browser.
    const panel = await page.context().newPage()
    await panel.setContent(renderNetworkHtml(title, network))
    await panel.screenshot({ path: join(dir, 'network.png'), fullPage: true })
    await panel.close()
    writeFileSync(
      join(dir, 'evidence.json'),
      JSON.stringify(
        {
          title,
          file,
          status: testInfo.status,
          dir: basename(dir),
          screenshots,
          networkImage: 'network.png',
          network,
          mapTilesBlocked,
        },
        null,
        2,
      ),
    )
  }
  return { evidence, finish }
}

export const test = base.extend<{ consoleErrors: string[]; evidence: Evidence }>({
  evidence: [
    async ({ page }, use, testInfo) => {
      const root = process.env.PW_EVIDENCE_DIR
      if (!root) {
        await use({ capture: async () => {} })
        return
      }
      const { evidence, finish } = recordEvidence(page, testInfo, root)
      await use(evidence)
      await finish()
    },
    { auto: true },
  ],
  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = []
      await page.route(TILE_URL, (route) => route.abort())
      page.on('console', (msg) => {
        // Aborted tile requests show up as resource errors; they're expected.
        if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text())
      })
      page.on('pageerror', (err) => errors.push(err.message))
      await use(errors)
      expect(errors, 'unexpected console errors').toEqual([])
    },
    { auto: true },
  ],
})

export { expect }

/** All listing cards currently shown. */
// Direct children only: each card contains its own list (beds, baths, sq ft).
export const cards = (page: Page) => page.getByRole('list', { name: 'Search results' }).locator(':scope > li')

/**
 * Open the app (optionally with a query string) and wait for results.
 *
 * @param page - The Playwright page.
 * @param query - e.g. `"?city=Reston"`.
 */
export async function openApp(page: Page, query = '') {
  await page.goto(`/${query}`)
  await expect(page.getByRole('heading', { name: /Results · \d+ found/ })).toBeVisible()
  await settled(page)
}

/**
 * Wait until the results area has finished loading (`aria-busy` is false),
 * so screenshots and accessibility audits never catch a half-loaded page.
 *
 * @param page - The Playwright page.
 */
export async function settled(page: Page) {
  await expect(page.getByRole('region', { name: 'Results' })).toHaveAttribute('aria-busy', 'false')
}

/** The URL's search parameters right now. */
export const urlParams = (page: Page) => new URL(page.url()).searchParams
