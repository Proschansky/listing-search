/**
 * End-to-end: saved searches and the colour theme, which persist in the browser.
 */

import { expect, openApp, test, urlParams } from './fixtures'

test.describe('saved searches', () => {
  test('saves a search, keeps it across reloads, re-runs and deletes it', async ({ page }) => {
    await openApp(page, '?city=Springfield')
    await page.getByLabel('Name for this search').fill('Springfield condos')
    await page.getByRole('button', { name: 'Save current' }).click()

    await page.getByRole('button', { name: 'Reset', exact: true }).click()
    await expect(page.getByLabel('City')).toHaveValue('')
    await page.reload()

    await page.getByRole('button', { name: 'Springfield condos', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Results · 2 found' })).toBeVisible()
    expect(urlParams(page).get('city')).toBe('Springfield')

    await page.getByRole('button', { name: 'Delete saved search Springfield condos' }).click()
    await expect(page.getByText(/Nothing saved yet/)).toBeVisible()
  })
})

test.describe('theme', () => {
  test('dark mode applies and persists; Auto follows the OS @smoke', async ({ page, evidence }) => {
    await openApp(page)
    await page.getByRole('button', { name: 'Dark', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await evidence.capture('Dark theme')
    const darkBg = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

    await page.getByRole('button', { name: 'Light', exact: true }).click()
    const lightBg = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)
    expect(lightBg).not.toBe(darkBg)

    await page.emulateMedia({ colorScheme: 'dark' })
    await page.getByRole('button', { name: 'Auto', exact: true }).click()
    await expect(page.locator('html')).not.toHaveAttribute('data-theme')
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe(darkBg)
  })
})
