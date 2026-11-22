/**
 * End-to-end: searching, filtering, validation, sorting and paging against
 * the real API and sample data (8 merged listings, 7 of them active).
 */

import { cards, expect, openApp, test, urlParams } from './fixtures'

test.describe('search', () => {
  test('shows ranked active listings on load @smoke', async ({ page, evidence }) => {
    await openApp(page)
    await evidence.capture('Results on load')
    await expect(page.getByRole('heading', { name: 'Results · 7 found' })).toBeVisible()
    await expect(cards(page)).toHaveCount(7)
    // Duplicates from the two feeds are merged: one card per home.
    await expect(page.getByRole('heading', { name: /55 Elm/ })).toHaveCount(1)
  })

  test('filters by city and keyword, and keeps the search in the URL', async ({ page, evidence }) => {
    await openApp(page)
    await page.getByLabel('City').fill('Reston')
    await page.getByLabel('Keywords').fill('pool')
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Results · 1 found' })).toBeVisible()
    await expect(cards(page).first()).toContainText('100 Maple Dr')
    await evidence.capture('Filtered to Reston + pool')
    expect(urlParams(page).get('city')).toBe('Reston')
    expect(urlParams(page).get('keyword')).toBe('pool')

    // The URL alone reproduces the search after a reload.
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Results · 1 found' })).toBeVisible()
    await expect(page.getByLabel('City')).toHaveValue('Reston')
  })

  test('shows the API validation error next to the field', async ({ page, evidence }) => {
    await openApp(page)
    await page.getByLabel('Min price ($)').fill('600000')
    await page.getByLabel('Max price ($)').fill('500000')
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('must not be greater than maxPrice')
    await expect(page.getByLabel('Min price ($)')).toHaveAttribute('aria-invalid', 'true')
    await evidence.capture('Validation error shown next to the field')
    // Validation errors aren't retryable: fixing the input is the way out.
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0)
  })

  test('sets prices by typing with commas or with the slider', async ({ page, evidence }) => {
    await openApp(page)
    const maxBox = page.getByLabel('Max price ($)')
    await maxBox.fill('$500,000')
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await expect.poll(() => urlParams(page).get('maxPrice')).toBe('500000')
    await expect(maxBox).toHaveValue('500,000')

    // One arrow press moves the handle down one $25,000 step.
    const handle = page.getByRole('slider', { name: 'Highest price' })
    await expect(handle).toHaveAttribute('aria-valuetext', '$500,000')
    await handle.focus()
    await page.keyboard.press('ArrowLeft')
    await expect(maxBox).toHaveValue('475,000')
    await expect(handle).toHaveAttribute('aria-valuetext', '$475,000')
    await evidence.capture('Max price set with the slider')
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await expect.poll(() => urlParams(page).get('maxPrice')).toBe('475000')
  })

  test('drags both price handles with a mouse', async ({ page, evidence }) => {
    // The two handles are two range inputs stacked on one track, and only
    // the round handles take the pointer. A real drag is the only way to
    // check that each handle can be grabbed and moves the right value.
    await openApp(page)
    const high = page.getByRole('slider', { name: 'Highest price' })
    const low = page.getByRole('slider', { name: 'Lowest price' })
    const box = await high.boundingBox()
    if (!box) throw new Error('slider has no box')
    const y = box.y + box.height / 2
    const thumb = 10 // half the handle's width

    // High handle starts at the right end ("No max"); drag it to the middle.
    await page.mouse.move(box.x + box.width - thumb, y)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2, y, { steps: 8 })
    await page.mouse.up()
    await expect(page.getByLabel('Max price ($)')).not.toHaveValue('')
    await expect(page.getByLabel('Min price ($)')).toHaveValue('')

    // Low handle starts at the left end ("No min"); drag it a quarter of the way.
    await page.mouse.move(box.x + thumb, y)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 4, y, { steps: 8 })
    await page.mouse.up()
    await expect(page.getByLabel('Min price ($)')).not.toHaveValue('')
    await evidence.capture('Price range set by dragging both handles')

    // The range stays valid: low below high, so the search succeeds.
    const lowValue = Number(await low.inputValue())
    expect(lowValue).toBeGreaterThan(0)
    expect(lowValue).toBeLessThan(Number(await high.inputValue()))
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await expect(page.getByRole('heading', { name: /Results · \d+ found/ })).toBeVisible()
    await expect.poll(() => urlParams(page).get('minPrice')).toBeTruthy()
    await expect.poll(() => urlParams(page).get('maxPrice')).toBeTruthy()
  })

  test('explains an unknown city with a warning, not an error', async ({ page }) => {
    await openApp(page, '?city=Atlantis')
    await expect(page.getByText(/No listings in city 'Atlantis'/)).toBeVisible()
    await expect(page.getByText(/No listings match these filters/)).toBeVisible()
  })

  test('includes pending listings when that status is ticked', async ({ page }) => {
    await openApp(page)
    await page.getByRole('checkbox', { name: 'pending' }).check()
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Results · 8 found' })).toBeVisible()
    await expect(page.getByText('42 Willow Way')).toBeVisible()
  })

  test('sorts by price and pages through results', async ({ page }) => {
    await openApp(page, '?pageSize=5')
    await page.getByRole('combobox', { name: 'Sort' }).selectOption('price_asc')
    await expect(cards(page).first()).toContainText('789 Pine Rd') // $399,000, the cheapest
    expect(urlParams(page).get('sort')).toBe('price_asc')

    await expect(page.getByRole('navigation', { name: 'Pagination' })).toContainText('Page 1 of 2')
    await page.getByRole('button', { name: /Next/ }).click()
    await expect(page.getByRole('navigation', { name: 'Pagination' })).toContainText('showing 6–7 of 7')
    await expect(cards(page)).toHaveCount(2)
    await expect(page.getByLabel('Rank 6')).toBeVisible()
  })

  test('ranks the closest price first when a target budget is set', async ({ page }) => {
    await openApp(page, '?asOf=2026-09-05')
    await page.getByLabel('Target budget ($)').fill('470000')
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await expect(cards(page).first()).toContainText('55 Elm')
  })

  test('offers a jump back from a page past the end', async ({ page }) => {
    await openApp(page, '?page=9')
    await expect(page.getByText('This page is empty.')).toBeVisible()
    await page.getByRole('button', { name: 'Go to last page (1)' }).click()
    await expect(cards(page)).toHaveCount(7)
  })

  test('Reset clears every filter', async ({ page }) => {
    await openApp(page, '?city=Vienna&sort=newest')
    await page.getByRole('button', { name: 'Reset', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Results · 7 found' })).toBeVisible()
    await expect(page.getByLabel('City')).toHaveValue('')
    expect(urlParams(page).has('city')).toBe(false)
  })

  test('searches as you type when the toggle is on', async ({ page }) => {
    await openApp(page)
    await page.getByText('Search as you type').click()
    await page.getByLabel('City').pressSequentially('Fairfax', { delay: 40 })
    await expect(page.getByRole('heading', { name: 'Results · 1 found' })).toBeVisible()
    // The preference survives a reload.
    await page.reload()
    await expect(page.getByRole('checkbox', { name: 'Search as you type' })).toBeChecked()
  })
})
