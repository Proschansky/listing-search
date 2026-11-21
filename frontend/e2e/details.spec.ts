/**
 * End-to-end: the listing detail drawer and the map view.
 */

import { cards, expect, openApp, test, urlParams } from './fixtures'

test.describe('listing details', () => {
  test('opens from a card, shows merged sources, and closes with Escape @smoke', async ({ page, evidence }) => {
    await openApp(page)
    await page.getByRole('button', { name: /55 Elm/ }).click()
    const dialog = page.getByRole('dialog', { name: /55 Elm/ })
    await expect(dialog).toBeVisible()
    // Both feeds' records are listed, with their own spelling of the address.
    await expect(dialog.getByRole('cell', { name: '55 Elm Court' })).toBeVisible()
    await expect(dialog.getByText('MLS_B')).toBeVisible()
    expect(urlParams(page).get('listing')).toBeTruthy()
    await evidence.capture('Detail drawer open')

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    expect(urlParams(page).has('listing')).toBe(false)
    // Focus goes back to the card that opened it.
    await expect(page.getByRole('button', { name: /55 Elm/ })).toBeFocused()
  })

  test('opens straight from a shared link', async ({ page }) => {
    await openApp(page)
    await page.getByRole('button', { name: /22 Birch/ }).click()
    const link = page.url()
    await page.goto('about:blank')
    await page.goto(link)
    await expect(page.getByRole('dialog', { name: /22 Birch/ })).toBeVisible()
  })

  test('says so when a linked listing no longer exists', async ({ page }) => {
    await page.goto('/?listing=no-such-listing')
    await expect(page.getByRole('dialog', { name: 'Listing unavailable' })).toBeVisible()
    await expect(page.getByRole('alert')).toContainText('no longer available')
  })

  test('keeps keyboard focus inside the drawer', async ({ page }) => {
    await openApp(page)
    await page.getByRole('button', { name: /55 Elm/ }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('button', { name: 'Close details' })).toBeFocused()
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab')
      await expect(dialog.locator(':focus')).toHaveCount(1)
    }
  })
})

test.describe('map view', () => {
  test('plots one marker per listing and opens details from a marker', async ({ page, evidence }) => {
    await openApp(page)
    await page.getByRole('button', { name: 'Map', exact: true }).click()
    const map = page.getByRole('region', { name: 'Map of 7 listings' })
    await expect(map).toBeVisible()
    const markers = map.locator('path.leaflet-interactive')
    await expect(markers).toHaveCount(7)
    await evidence.capture('Map view')
    await markers.first().click({ force: true })
    await expect(page.getByRole('dialog')).toBeVisible()
  })

  test('remembers the chosen view across reloads', async ({ page }) => {
    await openApp(page)
    await page.getByRole('button', { name: 'Map', exact: true }).click()
    await page.reload()
    await expect(page.getByRole('button', { name: 'Map', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: 'List', exact: true }).click()
    await expect(cards(page)).toHaveCount(7)
  })
})
