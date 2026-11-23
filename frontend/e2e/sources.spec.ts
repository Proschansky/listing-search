/**
 * End-to-end: listings from the SimplyRETS source, next to the sample data.
 *
 * @remarks
 * These tests use the second API from `playwright.config.ts`, which has
 * SimplyRETS switched on but can't reach it, so it serves the saved snapshot
 * in `backend/tests/fixtures/simplyrets_snapshot.json`. That's the
 * "SimplyRETS is down" case, and it never needs the internet. The page's
 * `/api` calls are sent to that API instead of the usual one.
 *
 * The fixture's photo URLs point at `photos.example.com`, which doesn't
 * exist, so each photo request is answered with a small generated image.
 */

import { SOURCES_API_PORT } from '../playwright.config'
import { cards, expect, openApp, test } from './fixtures'

const SOURCES_API = `http://127.0.0.1:${SOURCES_API_PORT}`

/** A 4x3 PNG in a single soft blue, standing in for a listing photo. */
const PHOTO = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEUlEQVR4nGOYtuUOHDHg5AAA86oZyafmVcQAAAAASUVORK5CYII=',
  'base64',
)

test.beforeEach(async ({ page }) => {
  // Same request, other API: keep the path and query, swap the host.
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const response = await route.fetch({ url: `${SOURCES_API}${url.pathname}${url.search}` })
    await route.fulfill({ response })
  })
  await page.route('https://photos.example.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PHOTO }),
  )
})

test.describe('SimplyRETS source', () => {
  test('shows SimplyRETS listings with their source and photos @smoke', async ({ page, evidence }) => {
    await openApp(page, '?city=Houston')
    // Searches show active listings by default; the fixture has one in Houston.
    await expect(cards(page)).toHaveCount(1)
    await expect(cards(page).first()).toContainText('SIMPLYRETS')
    await evidence.capture('Houston results from SimplyRETS')

    await page.getByRole('button', { name: /1200 Bayou Bend Dr/ }).click()
    const dialog = page.getByRole('dialog', { name: '1200 Bayou Bend Dr' })
    const photos = dialog.getByRole('region', { name: 'Photos (3)' })
    await expect(photos).toBeVisible()
    await expect(photos.getByRole('img', { name: '1200 Bayou Bend Dr, view 1 of 3' })).toBeVisible()
    await evidence.capture('Drawer with SimplyRETS photos')

    // The photo row scrolls with the keyboard.
    await photos.focus()
    await expect(photos).toBeFocused()
  })

  test('still shows the sample listings', async ({ page }) => {
    await openApp(page, '?city=Vienna')
    await expect(cards(page).first()).toContainText('MLS_')
  })

  test('reports SimplyRETS as degraded while serving its saved copy', async ({ request }) => {
    const res = await request.get(`${SOURCES_API}/api/v1/health/ready`)
    // Searches still work, so the service is ready even though SimplyRETS is down.
    expect(res.status()).toBe(200)
    const { checks } = await res.json()
    expect(checks.sources.sample.status).toBe('ok')
    expect(checks.sources.simplyrets).toMatchObject({ status: 'degraded', listings: 3 })
  })
})
