/**
 * Component tests for {@link ListingDrawer}, with `fetch` mocked.
 *
 * @module
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listing, listing2, respond } from '../test/fixtures'
import { COMPONENT_ONLY_SKIP, expectNoA11yViolations } from '../test/axe'
import { ListingDrawer } from './ListingDrawer'

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn(() => respond(200, listing))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const noContext = { targetBudget: '', asOf: '' }

/** The headline price at the top of the drawer (the sources table repeats prices). */
const headlinePrice = () => document.querySelector('.drawer-price .price')

describe('ListingDrawer', () => {
  it('is a modal dialog named by the listing address', async () => {
    render(<ListingDrawer listingKey={listing.listingKey} initial={listing} context={noContext} onClose={() => {}} />)
    const dialog = screen.getByRole('dialog', { name: '55 Elm Ct' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  })

  it('shows the copy from the results immediately, then the fresh one', async () => {
    fetchMock.mockReturnValue(respond(200, { ...listing, price: 480000 }))
    render(<ListingDrawer listingKey={listing.listingKey} initial={listing} context={noContext} onClose={() => {}} />)
    expect(headlinePrice()).toHaveTextContent('$470,000')
    await waitFor(() => expect(headlinePrice()).toHaveTextContent('$480,000'))
  })

  it('fetches the listing with the search context so the score matches', async () => {
    render(
      <ListingDrawer
        listingKey="12 oak/ave"
        context={{ targetBudget: '500000', asOf: '2026-09-01' }}
        onClose={() => {}}
      />,
    )
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/v1/listings/12%20oak%2Fave?targetBudget=500000&asOf=2026-09-01',
        expect.anything(),
      ),
    )
  })

  it('shows a loading state when opened from a link with no data yet', async () => {
    render(<ListingDrawer listingKey={listing.listingKey} context={noContext} onClose={() => {}} />)
    expect(screen.getByRole('dialog', { name: 'Loading listing…' })).toHaveAttribute('aria-busy', 'true')
    expect(await screen.findByRole('dialog', { name: '55 Elm Ct' })).toHaveAttribute('aria-busy', 'false')
  })

  it('says a listing is gone on 404', async () => {
    fetchMock.mockReturnValue(respond(404, { error: { code: 'NOT_FOUND', message: 'nope', details: [] } }))
    render(<ListingDrawer listingKey="gone" context={noContext} onClose={() => {}} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('This listing is no longer available.')
    expect(screen.getByRole('dialog', { name: 'Listing unavailable' })).toBeInTheDocument()
  })

  it('says loading failed for other errors', async () => {
    fetchMock.mockReturnValue(respond(400, { error: { code: 'X', message: 'bad', details: [] } }))
    render(<ListingDrawer listingKey="x" context={noContext} onClose={() => {}} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load this listing.')
  })

  it('keeps showing the results copy if the refresh fails', async () => {
    fetchMock.mockReturnValue(Promise.reject(new TypeError('offline')))
    render(<ListingDrawer listingKey={listing.listingKey} initial={listing} context={noContext} onClose={() => {}} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3)) // first try + 2 retries
    expect(headlinePrice()).toHaveTextContent('$470,000')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows facts, the score breakdown and every source feed', async () => {
    fetchMock.mockReturnValue(respond(200, listing2))
    render(<ListingDrawer listingKey={listing2.listingKey} initial={listing2} context={noContext} onClose={() => {}} />)
    expect(screen.getByText('Price / sq ft').nextElementSibling).toHaveTextContent('$251')
    expect(screen.getByText('Days on market').nextElementSibling).toHaveTextContent('143')
    expect(screen.getByRole('rowheader', { name: 'Budget fit' }).nextElementSibling).toHaveTextContent(
      'No target budget set',
    )
    expect(screen.getByRole('cell', { name: '12 Oak Avenue' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: '$610,000' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /OpenStreetMap/ })).toHaveAttribute(
      'href',
      expect.stringContaining('mlat=38.9586'),
    )
  })

  it('handles a zero-size listing without dividing by zero', () => {
    render(
      <ListingDrawer
        listingKey="z"
        initial={{ ...listing, sqft: 0, description: '' }}
        context={noContext}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText('Price / sq ft').nextElementSibling).toHaveTextContent('—')
  })

  it('moves focus to the close button on open and back to the opener on close', async () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const { unmount } = render(
      <ListingDrawer listingKey="k" initial={listing} context={noContext} onClose={() => {}} />,
    )
    expect(screen.getByRole('button', { name: 'Close details' })).toHaveFocus()
    unmount()
    expect(opener).toHaveFocus()
    opener.remove()
  })

  it.each([
    ['the close button', async () => userEvent.click(screen.getByRole('button', { name: 'Close details' }))],
    ['Escape', async () => userEvent.keyboard('{Escape}')],
    ['the backdrop', async () => userEvent.click(screen.getByTestId('drawer-backdrop'))],
  ])('closes via %s', async (_name, act) => {
    const onClose = vi.fn()
    render(<ListingDrawer listingKey="k" initial={listing} context={noContext} onClose={onClose} />)
    await act()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('traps Tab and Shift+Tab inside the dialog', async () => {
    render(<ListingDrawer listingKey="k" initial={listing} context={noContext} onClose={() => {}} />)
    const close = screen.getByRole('button', { name: 'Close details' })
    const link = screen.getByRole('link', { name: /OpenStreetMap/ })
    expect(close).toHaveFocus()
    await userEvent.tab({ shift: true })
    expect(link).toHaveFocus() // wrapped from first to last
    await userEvent.tab()
    expect(close).toHaveFocus() // wrapped from last to first
  })

  it('has no accessibility violations', async () => {
    const { container } = render(
      <ListingDrawer listingKey="k" initial={listing2} context={noContext} onClose={() => {}} />,
    )
    await expectNoA11yViolations(container, { skip: COMPONENT_ONLY_SKIP })
  })

  describe('photos', () => {
    const photos = ['https://photos.example.com/1.jpg', 'https://photos.example.com/2.jpg']
    const withPhotos = { ...listing, photos }

    it('shows a labelled, keyboard-scrollable row of photos with alt text', async () => {
      fetchMock.mockReturnValue(respond(200, withPhotos))
      render(<ListingDrawer listingKey="k" initial={withPhotos} context={noContext} onClose={() => {}} />)
      const region = screen.getByRole('region', { name: 'Photos (2)' })
      expect(region).toHaveAttribute('tabindex', '0')
      const imgs = screen.getAllByRole('img')
      expect(imgs.map((img) => img.getAttribute('alt'))).toEqual(['55 Elm Ct, view 1 of 2', '55 Elm Ct, view 2 of 2'])
      expect(imgs.map((img) => img.getAttribute('src'))).toEqual(photos)
      // The first photo is visible at once; the rest load as they scroll in.
      expect(imgs.map((img) => img.getAttribute('loading'))).toEqual(['eager', 'lazy'])
      await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    })

    it('shows no photo row when the listing has none', async () => {
      render(<ListingDrawer listingKey="k" initial={listing} context={noContext} onClose={() => {}} />)
      expect(screen.queryByRole('region', { name: /Photos/ })).not.toBeInTheDocument()
      await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    })

    it('has no accessibility violations with photos', async () => {
      fetchMock.mockReturnValue(respond(200, withPhotos))
      const { container } = render(
        <ListingDrawer listingKey="k" initial={withPhotos} context={noContext} onClose={() => {}} />,
      )
      await expectNoA11yViolations(container, { skip: COMPONENT_ONLY_SKIP })
    })
  })

  it('has no accessibility violations while loading or failed', async () => {
    fetchMock.mockReturnValue(respond(404, { error: { code: 'NOT_FOUND', message: 'x', details: [] } }))
    const { container } = render(<ListingDrawer listingKey="gone" context={noContext} onClose={() => {}} />)
    await expectNoA11yViolations(container, { skip: COMPONENT_ONLY_SKIP })
    await screen.findByRole('alert')
    await expectNoA11yViolations(container, { skip: COMPONENT_ONLY_SKIP })
  })
})
