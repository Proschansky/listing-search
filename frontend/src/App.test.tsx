/**
 * Component tests for {@link App}, with `fetch` mocked out.
 *
 * @remarks
 * Covers each UI state the brief asks for: results, no results, validation
 * errors shown next to their fields, a network failure, and paging. Also
 * covers URL sync, reset, warnings, the past-the-end page, stale-while-loading
 * and cancelling superseded requests.
 *
 * @module
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { emptyPage, listing, listing2, page, pagination, respond, validationError } from './test/fixtures'

/** The mocked global `fetch`, reset before each test. */
let fetchMock: ReturnType<typeof vi.fn>

/**
 * Answer `/api/meta` with a fixed city list, and every search request with `search`.
 *
 * @param search - Produces the response for `/api/listings` calls.
 */
function mockSearch(search: (url: string, init?: RequestInit) => Promise<Response>) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) =>
    url.startsWith('/api/v1/meta')
      ? respond(200, { cities: ['Vienna'], statuses: [], maxPageSize: 100 })
      : search(url, init),
  )
}

/** URLs of every search request sent so far. */
const searchUrls = () => fetchMock.mock.calls.map(([u]) => u as string).filter((u) => u.startsWith('/api/v1/listings'))

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  mockSearch(() => respond(200, page()))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('App', () => {
  it('renders ranked results with address, price, bedrooms and score', async () => {
    render(<App />)
    expect(await screen.findByText('55 Elm Ct')).toBeInTheDocument()
    expect(screen.getByText('$470,000')).toBeInTheDocument()
    expect(screen.getByText('0.731')).toBeInTheDocument()
    expect(screen.getByText(/Page 1 of 1/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Results · 1 found/ })).toBeInTheDocument()
  })

  it('shows a loading indicator until the first response arrives', async () => {
    render(<App />)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    await screen.findByText('55 Elm Ct')
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
  })

  it('shows the no-results state', async () => {
    mockSearch(() => respond(200, emptyPage()))
    render(<App />)
    expect(await screen.findByText(/No listings match/)).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Pagination' })).not.toBeInTheDocument()
  })

  it('offers a jump to the last page when the page is past the end', async () => {
    mockSearch((url) =>
      respond(
        200,
        url.includes('page=9')
          ? page({
              results: [],
              pagination: pagination({ page: 9, totalResults: 15, totalPages: 2 }),
              warnings: ['Page 9 is past the last page (2).'],
            })
          : page(),
      ),
    )
    window.history.replaceState(null, '', '/?page=9')
    render(<App />)
    expect(await screen.findByText('This page is empty.')).toBeInTheDocument()
    expect(screen.getByText('Page 9 is past the last page (2).')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Go to last page (2)' }))
    await waitFor(() => expect(searchUrls().at(-1)).toContain('page=2'))
  })

  it('shows API warnings above the results', async () => {
    mockSearch(() => respond(200, page({ warnings: ['Unknown city "Atlantis".'] })))
    render(<App />)
    expect(await screen.findByText('Unknown city "Atlantis".')).toHaveClass('warning')
  })

  it('shows validation errors from the API next to the field', async () => {
    render(<App />)
    await screen.findByText('55 Elm Ct')
    mockSearch(() => respond(400, validationError))
    await userEvent.type(screen.getByLabelText(/Min price/), '6')
    await userEvent.type(screen.getByLabelText(/Max price/), '5')
    await userEvent.click(screen.getByRole('button', { name: 'Search' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('invalid')
    expect(alert).toHaveTextContent('minPrice: must not be greater than maxPrice (6 > 5)')
    expect(screen.getByLabelText(/Min price/)).toHaveAttribute('aria-invalid', 'true')
    expect(screen.queryByText('55 Elm Ct')).not.toBeInTheDocument()
    const lastCall = searchUrls().at(-1)!
    expect(lastCall).toContain('minPrice=6')
    expect(lastCall).toContain('maxPrice=5')
  })

  it('shows a network error when the backend is down', async () => {
    mockSearch(() => Promise.reject(new TypeError('Failed to fetch')))
    render(<App />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not reach/)
  })

  it('shows a generic message for an unexpected failure', async () => {
    // A response whose `ok` getter throws makes the client reject with a plain
    // Error rather than an ApiError, which is the "anything unexpected" branch.
    mockSearch(() =>
      Promise.resolve({
        json: () => Promise.resolve({}),
        get ok(): boolean {
          throw new Error('kaboom')
        },
      } as unknown as Response),
    )
    render(<App />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.')
  })

  it('still works when the city list fails to load', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.startsWith('/api/v1/meta') ? Promise.reject(new TypeError('down')) : respond(200, page()),
    )
    render(<App />)
    expect(await screen.findByText('55 Elm Ct')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('requests the next page when Next is clicked', async () => {
    mockSearch(() => respond(200, page({ pagination: pagination({ totalResults: 15, totalPages: 2, hasNext: true }) })))
    render(<App />)
    await screen.findByText('55 Elm Ct')
    await userEvent.click(screen.getByRole('button', { name: /Next/ }))
    await waitFor(() => expect(searchUrls().some((u) => u.includes('page=2'))).toBe(true))
  })

  it('continues rank numbers on later pages', async () => {
    mockSearch(() =>
      respond(200, page({ pagination: pagination({ page: 2, totalResults: 11, totalPages: 2, hasPrevious: true }) })),
    )
    window.history.replaceState(null, '', '/?page=2')
    render(<App />)
    expect(await screen.findByLabelText('Rank 11')).toBeInTheDocument()
  })

  it('dims the previous results while the next page loads', async () => {
    let release!: () => void
    mockSearch((url) =>
      url.includes('page=2')
        ? new Promise((resolve) => {
            release = () => resolve(new Response(JSON.stringify(page({ results: [listing2] })), { status: 200 }))
          })
        : respond(200, page({ pagination: pagination({ totalResults: 15, totalPages: 2, hasNext: true }) })),
    )
    render(<App />)
    await screen.findByText('55 Elm Ct')
    await userEvent.click(screen.getByRole('button', { name: /Next/ }))
    expect(screen.getByText('55 Elm Ct').closest('.stale')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled()
    release()
    expect(await screen.findByText('12 Oak Ave')).toBeInTheDocument()
    expect(document.querySelector('.stale')).toBeNull()
  })

  it('restores the search from the URL on load', async () => {
    window.history.replaceState(null, '', '/?city=Vienna&status=active,pending&page=2')
    render(<App />)
    await screen.findByText('55 Elm Ct')
    expect(screen.getByLabelText(/City/)).toHaveValue('Vienna')
    expect(screen.getByRole('checkbox', { name: 'pending' })).toBeChecked()
    expect(searchUrls()[0]).toContain('city=Vienna')
    expect(searchUrls()[0]).toContain('page=2')
  })

  it('keeps the URL in sync with the submitted search', async () => {
    render(<App />)
    await screen.findByText('55 Elm Ct')
    await userEvent.type(screen.getByLabelText(/Keywords/), 'pool')
    expect(window.location.search).not.toContain('keyword')
    await userEvent.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() => expect(window.location.search).toContain('keyword=pool'))
  })

  it('starts a new search from page 1', async () => {
    window.history.replaceState(null, '', '/?page=3')
    render(<App />)
    await screen.findByText('55 Elm Ct')
    await userEvent.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() => expect(searchUrls().at(-1)).not.toContain('page='))
  })

  it('Reset clears the form and re-runs the default search', async () => {
    window.history.replaceState(null, '', '/?city=Vienna')
    render(<App />)
    await screen.findByText('55 Elm Ct')
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }))
    await waitFor(() => expect(searchUrls().at(-1)).toBe('/api/v1/listings?pageSize=10'))
    expect(screen.getByLabelText(/City/)).toHaveValue('')
    expect(window.location.search).toBe('?pageSize=10')
  })

  it('aborts a superseded search so a slow old response cannot win', async () => {
    const signals: AbortSignal[] = []
    mockSearch((_url, init) => {
      signals.push(init!.signal!)
      return respond(200, page({ pagination: pagination({ totalResults: 15, totalPages: 2, hasNext: true }) }))
    })
    render(<App />)
    await screen.findByText('55 Elm Ct')
    await userEvent.click(screen.getByRole('button', { name: /Next/ }))
    await waitFor(() => expect(signals.length).toBeGreaterThanOrEqual(2))
    // Every search but the latest has been aborted.
    expect(signals.slice(0, -1).every((s) => s.aborted)).toBe(true)
    expect(signals.at(-1)!.aborted).toBe(false)
  })
})

describe('App: enterprise features', () => {
  it('shows skeleton cards on first load, then the results', async () => {
    render(<App />)
    expect(screen.getByTestId('results-skeleton')).toBeInTheDocument()
    await screen.findByText('55 Elm Ct')
    expect(screen.queryByTestId('results-skeleton')).not.toBeInTheDocument()
  })

  it('does not show the skeleton again while paging (results dim instead)', async () => {
    mockSearch((url) =>
      url.includes('page=2')
        ? new Promise(() => {})
        : respond(200, page({ pagination: pagination({ totalResults: 15, totalPages: 2, hasNext: true }) })),
    )
    render(<App />)
    await screen.findByText('55 Elm Ct')
    await userEvent.click(screen.getByRole('button', { name: /Next/ }))
    expect(screen.queryByTestId('results-skeleton')).not.toBeInTheDocument()
  })

  it('changing the sort re-runs the search from page 1 and updates the URL', async () => {
    window.history.replaceState(null, '', '/?page=2')
    render(<App />)
    await screen.findByText('55 Elm Ct')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Sort' }), 'price_asc')
    await waitFor(() => expect(searchUrls().at(-1)).toBe('/api/v1/listings?pageSize=10&sort=price_asc'))
    expect(window.location.search).toContain('sort=price_asc')
  })

  it('offers "Try again" after a network error and recovers', async () => {
    mockSearch(() => Promise.reject(new TypeError('Failed to fetch')))
    render(<App />)
    await screen.findByRole('alert')
    mockSearch(() => respond(200, page()))
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('55 Elm Ct')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not offer "Try again" for validation errors', async () => {
    mockSearch(() => respond(400, validationError))
    render(<App />)
    await screen.findByRole('alert')
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
  })

  it('shows the request ID for a server error so it can be reported', async () => {
    mockSearch(() =>
      respond(500, {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Something went wrong on our side.',
          details: [],
          requestId: 'req-42',
        },
      }),
    )
    render(<App />)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Reference: req-42')
  })

  it('switches between list and map views and remembers the choice', async () => {
    render(<App />)
    await screen.findByText('55 Elm Ct')
    await userEvent.click(screen.getByRole('button', { name: 'Map' }))
    expect(screen.getByRole('region', { name: 'Map of 1 listings' })).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Search results' })).not.toBeInTheDocument()
    expect(localStorage.getItem('listing-search:view:v1')).toBe('"map"')
    await userEvent.click(screen.getByRole('button', { name: 'List' }))
    expect(screen.getByRole('list', { name: 'Search results' })).toBeInTheDocument()
  })

  it('opens the detail drawer from a card, puts it in the URL, and closes it', async () => {
    mockSearch((url) => (url.startsWith('/api/v1/listings/') ? respond(200, listing) : respond(200, page())))
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: '55 Elm Ct' }))
    expect(screen.getByRole('dialog', { name: '55 Elm Ct' })).toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get('listing')).toBe('55-elm-ct-vienna-va')
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => (u as string).startsWith('/api/v1/listings/55-elm-ct'))).toBe(true),
    )
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(window.location.search).not.toContain('listing=')
  })

  it('opens the drawer straight from a shared link', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.startsWith('/api/v1/listings/')
        ? respond(200, listing2)
        : url.startsWith('/api/v1/meta')
          ? respond(200, { cities: [] })
          : respond(200, page()),
    )
    window.history.replaceState(null, '', `/?listing=${listing2.listingKey}`)
    render(<App />)
    expect(await screen.findByRole('dialog', { name: '12 Oak Ave' })).toBeInTheDocument()
  })

  it('searches as you type, debounced, when the toggle is on', async () => {
    render(<App />)
    await screen.findByText('55 Elm Ct')
    await userEvent.click(screen.getByRole('checkbox', { name: 'Search as you type' }))
    const before = searchUrls().length
    await userEvent.type(screen.getByLabelText(/City/), 'Vienna')
    // One search for the whole word, not one per letter.
    // Typing six letters key by key plus the 400 ms debounce can take a few
    // seconds on a busy machine, so allow 5 s before calling it a failure.
    await waitFor(() => expect(searchUrls().at(-1)).toContain('city=Vienna'), { timeout: 5000 })
    expect(searchUrls().length - before).toBe(1)
    expect(localStorage.getItem('listing-search:live:v1')).toBe('true')
  })

  it('does not search while typing when the toggle is off', async () => {
    render(<App />)
    await screen.findByText('55 Elm Ct')
    const before = searchUrls().length
    await userEvent.type(screen.getByLabelText(/City/), 'Vienna')
    await new Promise((r) => setTimeout(r, 600))
    expect(searchUrls().length).toBe(before)
  })

  it('saves the current search and applies it later', async () => {
    window.history.replaceState(null, '', '/?city=Vienna')
    render(<App />)
    await screen.findByText('55 Elm Ct')
    await userEvent.click(screen.getByRole('button', { name: 'Save current' }))
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }))
    await waitFor(() => expect(screen.getByLabelText(/City/)).toHaveValue(''))
    await userEvent.click(screen.getByRole('button', { name: 'Vienna' }))
    await waitFor(() => expect(searchUrls().at(-1)).toContain('city=Vienna'))
    expect(screen.getByLabelText(/City/)).toHaveValue('Vienna')
  })

  it('applies the chosen theme to the page', async () => {
    render(<App />)
    await screen.findByText('55 Elm Ct')
    await userEvent.click(screen.getByRole('button', { name: 'Dark' }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    await userEvent.click(screen.getByRole('button', { name: 'Auto' }))
    expect(document.documentElement).not.toHaveAttribute('data-theme')
  })
})
