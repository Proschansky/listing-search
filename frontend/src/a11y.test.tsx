/**
 * Accessibility suite: audits the whole page with axe-core in every UI state.
 *
 * @remarks
 * Uses axe-core (free and open source) against WCAG 2.x A/AA and axe's
 * best-practice rules, including the page-level landmark and heading rules
 * that the per-component checks skip. Alongside axe, it checks behaviours axe
 * can't see: keyboard reachability, focusable controls having names, and
 * live-region announcements.
 *
 * @module
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { expectNoA11yViolations } from './test/axe'
import { emptyPage, listing, listing2, page, pagination, respond, validationError } from './test/fixtures'

let fetchMock: ReturnType<typeof vi.fn>

/**
 * Answer every search with `search`, and `/api/meta` with a city list.
 *
 * @param search - Produces the search response.
 */
function mockSearch(search: () => Promise<Response>) {
  fetchMock.mockImplementation((url: string) =>
    url.startsWith('/api/v1/meta')
      ? respond(200, { cities: ['Vienna', 'Reston'], statuses: [], maxPageSize: 100 })
      : search(),
  )
}

beforeEach(() => {
  // index.html sets these in the real page; jsdom starts without them.
  document.title = 'Listing Search'
  document.documentElement.lang = 'en'
  window.history.replaceState(null, '', '/')
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// A full-page axe audit takes a second or two in jsdom; allow headroom.
describe('accessibility (axe-core, whole page)', { timeout: 20_000 }, () => {
  it('loading state', async () => {
    mockSearch(() => new Promise(() => {}))
    render(<App />)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    await expectNoA11yViolations()
  })

  it('results state, with several pages and every status', async () => {
    mockSearch(() =>
      respond(
        200,
        page({
          results: [
            page().results[0],
            listing2,
            { ...listing2, listingKey: 'sold-1', status: 'sold', address: '9 Pine Rd' },
          ],
          pagination: pagination({ page: 2, totalResults: 40, totalPages: 4, hasPrevious: true, hasNext: true }),
        }),
      ),
    )
    render(<App />)
    await screen.findByText('55 Elm Ct')
    await expectNoA11yViolations()
  })

  it('results state with Advanced options expanded', async () => {
    mockSearch(() => respond(200, page()))
    render(<App />)
    await screen.findByText('55 Elm Ct')
    await userEvent.click(screen.getByText('Advanced'))
    await expectNoA11yViolations()
  })

  it('no-results state', async () => {
    mockSearch(() => respond(200, emptyPage()))
    render(<App />)
    await screen.findByText(/No listings match/)
    await expectNoA11yViolations()
  })

  it('past-the-end page with a warning', async () => {
    mockSearch(() =>
      respond(
        200,
        page({
          results: [],
          pagination: pagination({ page: 5, totalResults: 3, totalPages: 1 }),
          warnings: ['Page 5 is past the end.'],
        }),
      ),
    )
    render(<App />)
    await screen.findByText('This page is empty.')
    await expectNoA11yViolations()
  })

  it('validation-error state', async () => {
    mockSearch(() => respond(400, validationError))
    render(<App />)
    await screen.findByRole('alert')
    await expectNoA11yViolations()
  })

  it('detail drawer open', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.startsWith('/api/v1/listings/')
        ? respond(200, listing)
        : url.startsWith('/api/v1/meta')
          ? respond(200, { cities: [] })
          : respond(200, page()),
    )
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: '55 Elm Ct' }))
    await screen.findByRole('dialog', { name: '55 Elm Ct' })
    await expectNoA11yViolations()
  })

  it('map view', async () => {
    mockSearch(() => respond(200, page({ results: [listing, listing2] })))
    render(<App />)
    await screen.findByText('55 Elm Ct')
    await userEvent.click(screen.getByRole('button', { name: 'Map' }))
    await screen.findByRole('region', { name: /Map of/ })
    // Leaflet's own controls are third-party markup; audit everything else.
    await expectNoA11yViolations(document, { skip: [] })
  })

  it('with saved searches and live search on', async () => {
    mockSearch(() => respond(200, page()))
    render(<App />)
    await screen.findByText('55 Elm Ct')
    await userEvent.click(screen.getByRole('button', { name: 'Save current' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Search as you type' }))
    await expectNoA11yViolations()
  })

  it('dark theme', async () => {
    mockSearch(() => respond(200, page()))
    render(<App />)
    await screen.findByText('55 Elm Ct')
    await userEvent.click(screen.getByRole('button', { name: 'Dark' }))
    await expectNoA11yViolations()
  })

  it('network-error state', async () => {
    mockSearch(() => Promise.reject(new TypeError('Failed to fetch')))
    render(<App />)
    await screen.findByRole('alert')
    await expectNoA11yViolations()
  })
})

describe('accessibility (beyond axe)', () => {
  beforeEach(() =>
    mockSearch(() =>
      respond(200, page({ pagination: pagination({ totalResults: 15, totalPages: 2, hasNext: true }) })),
    ),
  )

  it('has one h1 and banner, main and navigation landmarks', async () => {
    render(<App />)
    await screen.findByText('55 Elm Ct')
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('banner')).toBeInTheDocument()
    expect(screen.getByRole('main')).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Pagination' })).toBeInTheDocument()
  })

  it('gives every interactive control an accessible name', async () => {
    render(<App />)
    await screen.findByText('55 Elm Ct')
    const controls = [
      ...screen.getAllByRole('textbox'),
      ...screen.getAllByRole('spinbutton'),
      ...screen.getAllByRole('checkbox'),
      ...screen.getAllByRole('button'),
    ]
    for (const el of controls) {
      expect(el, el.outerHTML).toHaveAccessibleName()
    }
  })

  it('lets a keyboard user reach every filter, the status toggles and Search in order', async () => {
    render(<App />)
    await screen.findByText('55 Elm Ct')
    // The header's theme picker comes first...
    for (const name of ['Auto', 'Light', 'Dark']) {
      await userEvent.tab()
      expect(document.activeElement).toBe(screen.getByRole('button', { name }))
    }
    // ...then the search form, top to bottom.
    const order = [/Min price/, /Max price/, /Min bedrooms/, /City/, /Keywords/, /Target budget/]
    for (const label of order) {
      await userEvent.tab()
      expect(document.activeElement).toBe(screen.getByLabelText(label))
    }
    await userEvent.tab()
    expect(document.activeElement).toHaveTextContent('Advanced')
    // Open Advanced from the keyboard; its controls come next in tab order.
    await userEvent.keyboard('{Enter}')
    await userEvent.tab()
    expect(document.activeElement).toBe(screen.getByLabelText('Results per page'))
    await userEvent.tab()
    expect(document.activeElement).toBe(screen.getByLabelText(/Measure recency as of/))
    for (const status of ['active', 'pending', 'sold']) {
      await userEvent.tab()
      expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: status }))
    }
    await userEvent.tab()
    expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Search as you type' }))
    await userEvent.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reset' }))
    await userEvent.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Search' }))
    // ...then the results tools and the first listing.
    await userEvent.tab()
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Sort' }))
    await userEvent.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'List' }))
    await userEvent.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Map' }))
    await userEvent.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '55 Elm Ct' }))
  })

  it('toggles a status with the keyboard', async () => {
    render(<App />)
    await screen.findByText('55 Elm Ct')
    screen.getByRole('checkbox', { name: 'pending' }).focus()
    await userEvent.keyboard(' ')
    expect(screen.getByRole('checkbox', { name: 'pending' })).toBeChecked()
  })

  it('announces results, loading and errors through a polite live region', async () => {
    render(<App />)
    await screen.findByText('55 Elm Ct')
    const region = screen.getByRole('region', { name: 'Results' })
    expect(region).toHaveAttribute('aria-live', 'polite')
    mockSearch(() => respond(400, validationError))
    await userEvent.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() => expect(region).toContainElement(screen.getByRole('alert')))
  })

  it('hides decorative graphics from assistive technology', async () => {
    render(<App />)
    await screen.findByText('55 Elm Ct')
    for (const el of document.querySelectorAll('.logo, .meter, .spinner')) {
      expect(el).toHaveAttribute('aria-hidden', 'true')
    }
  })
})
