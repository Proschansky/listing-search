/**
 * End-to-end accessibility: axe-core in a real browser.
 *
 * @remarks
 * The jsdom suite (`src/a11y.test.tsx`) can't check colour contrast, because
 * jsdom has no layout or computed colours. A real browser can, so this suite
 * runs the full WCAG 2.x A/AA rule set, contrast included, in both themes and
 * in every main UI state.
 *
 * Leaflet's own map controls are third-party markup and are excluded from
 * the map-view audit.
 */

import { AxeBuilder } from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, openApp, settled, test } from './fixtures'

/** Run axe on the page and return the violations, with readable output on failure. */
async function audit(page: Page, exclude: string[] = []) {
  // Audit the settled page: nothing loading, no entrance animations running.
  await settled(page)
  // Only animations that end: an infinite one (a spinner) never "finishes".
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    ),
  )
  let builder = new AxeBuilder({ page }).withTags([
    'wcag2a',
    'wcag2aa',
    'wcag21a',
    'wcag21aa',
    'wcag22aa',
    'best-practice',
  ])
  for (const selector of exclude) builder = builder.exclude(selector)
  const { violations } = await builder.analyze()
  const summary = violations
    .map((v) => `${v.id}: ${v.help}\n  ${v.nodes.map((n) => n.target.join(' ')).join('\n  ')}`)
    .join('\n')
  expect(violations, summary).toEqual([])
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`accessibility (${theme} theme)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    })

    test('results page', async ({ page }) => {
      await openApp(page)
      await audit(page)
    })

    test('validation errors', async ({ page }) => {
      await openApp(page)
      await page.getByLabel('Min price ($)').fill('-5')
      await page.getByRole('button', { name: 'Search', exact: true }).click()
      await expect(page.getByRole('alert')).toBeVisible()
      await audit(page)
    })

    test('empty results and warnings', async ({ page }) => {
      await openApp(page, '?city=Atlantis')
      await audit(page)
    })

    test('detail drawer', async ({ page }) => {
      await openApp(page)
      await page.getByRole('button', { name: /55 Elm/ }).click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await audit(page)
    })

    test('map view', async ({ page }) => {
      await openApp(page)
      await page.getByRole('button', { name: 'Map', exact: true }).click()
      await expect(page.locator('.leaflet-container')).toBeVisible()
      await audit(page, ['.leaflet-control-container', '.leaflet-pane'])
    })
  })
}
