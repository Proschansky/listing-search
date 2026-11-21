/**
 * End-to-end: how the UI behaves when the API misbehaves.
 *
 * Uses Playwright's network interception (`page.route`) to make the real API
 * fail in controlled ways: down, briefly unavailable, or erroring.
 */

import { cards, expect, openApp, test } from './fixtures'

const SEARCH = /\/api\/v1\/listings\?/

test.describe('resilience', () => {
  test('retries a brief outage automatically, invisibly to the user', async ({ page }) => {
    let failures = 0
    await page.route(SEARCH, async (route) => {
      // The first request gets a 503; the client's backoff retry gets through.
      if (failures++ < 1)
        return route.fulfill({
          status: 503,
          json: { error: { code: 'UNAVAILABLE', message: 'Restarting', details: [] } },
        })
      return route.continue()
    })
    await openApp(page)
    await expect(cards(page)).toHaveCount(7)
    await expect(page.getByRole('alert')).toHaveCount(0)
    expect(failures).toBe(2)
  })

  test('shows a clear error when the API is down, and recovers with Try again', async ({ page }) => {
    await page.route(SEARCH, (route) => route.abort('connectionrefused'))
    await page.goto('/')
    await expect(page.getByRole('alert')).toContainText('Could not reach the search service')

    await page.unroute(SEARCH)
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(cards(page)).toHaveCount(7)
  })

  test('shows the request ID from a server error so it can be reported', async ({ page }) => {
    await page.route(SEARCH, (route) =>
      route.fulfill({
        status: 500,
        json: {
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Something went wrong on our side.',
            details: [],
            requestId: 'e2e-req-1',
          },
        },
      }),
    )
    await page.goto('/')
    await expect(page.getByRole('alert')).toContainText('Reference: e2e-req-1')
  })

  test('the real API tags every response with a request ID and security headers', async ({ request }) => {
    const res = await request.get('/api/v1/listings')
    expect(res.status()).toBe(200)
    expect(res.headers()['x-request-id']).toMatch(/^[0-9a-f]{32}$/)
    expect(res.headers()['x-content-type-options']).toBe('nosniff')
  })

  test('a slow response keeps the old results on screen (dimmed), never blank', async ({ page }) => {
    await openApp(page, '?pageSize=5')
    await page.route(SEARCH, async (route) => {
      await new Promise((r) => setTimeout(r, 800))
      await route.continue()
    })
    await page.getByRole('button', { name: /Next/ }).click()
    // Old results stay visible (dimmed) while the region is busy.
    await expect(page.getByRole('region', { name: 'Results' })).toHaveAttribute('aria-busy', 'true')
    await expect(cards(page)).toHaveCount(5)
    await expect(cards(page)).toHaveCount(2)
  })
})
