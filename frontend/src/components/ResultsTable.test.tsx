/**
 * Component tests for {@link ResultsTable}.
 *
 * @module
 */

import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { listing, listing2 } from '../test/fixtures'
import { COMPONENT_ONLY_SKIP, expectNoA11yViolations } from '../test/axe'
import { ResultsTable } from './ResultsTable'

afterEach(cleanup)

/** All rendered listing cards, in order. */
const cards = () =>
  within(screen.getByRole('list', { name: 'Search results' }))
    .getAllByRole('listitem')
    .filter((el) => el.classList.contains('listing'))

describe('ResultsTable', () => {
  it('renders one card per result, in the order given', () => {
    render(<ResultsTable results={[listing, listing2]} rankOffset={0} />)
    const items = cards()
    expect(items).toHaveLength(2)
    expect(within(items[0]).getByRole('heading', { name: '55 Elm Ct' })).toBeInTheDocument()
    expect(within(items[1]).getByRole('heading', { name: '12 Oak Ave' })).toBeInTheDocument()
  })

  it('renders nothing but an empty list for no results', () => {
    render(<ResultsTable results={[]} rankOffset={0} />)
    expect(screen.getByRole('list', { name: 'Search results' })).toBeEmptyDOMElement()
  })

  it('numbers ranks from the offset so they continue across pages', () => {
    render(<ResultsTable results={[listing, listing2]} rankOffset={10} />)
    expect(screen.getByLabelText('Rank 11')).toHaveTextContent('11')
    expect(screen.getByLabelText('Rank 12')).toHaveTextContent('12')
  })

  it('shows location, formatted price, specs and description', () => {
    render(<ResultsTable results={[listing2]} rankOffset={0} />)
    const card = cards()[0]
    expect(within(card).getByText('Reston, VA 20190')).toBeInTheDocument()
    expect(within(card).getByText('$615,000')).toBeInTheDocument()
    expect(within(card).getByText('4')).toBeInTheDocument()
    expect(within(card).getByText('3.5')).toBeInTheDocument()
    expect(within(card).getByText('2,450')).toBeInTheDocument()
    expect(within(card).getByText('Corner lot with pool.')).toBeInTheDocument()
  })

  it('formats the listed date without shifting it across time zones', () => {
    render(<ResultsTable results={[listing]} rankOffset={0} />)
    expect(screen.getByText('Listed Aug 15, 2026')).toBeInTheDocument()
  })

  it('falls back to the raw string for an unparseable date', () => {
    render(<ResultsTable results={[{ ...listing, listedDate: 'unknown' }]} rankOffset={0} />)
    expect(screen.getByText('Listed unknown')).toBeInTheDocument()
  })

  it.each([
    ['active', 'badge-active'],
    ['pending', 'badge-pending'],
    ['sold', 'badge-sold'],
  ] as const)('shows a %s status badge', (status, cls) => {
    render(<ResultsTable results={[{ ...listing, status }]} rankOffset={0} />)
    expect(screen.getByText(status)).toHaveClass('badge', cls)
  })

  it('shows the score to three places with its budget and recency parts', () => {
    render(<ResultsTable results={[listing]} rankOffset={0} />)
    expect(screen.getByText('0.731')).toBeInTheDocument()
    expect(screen.getByText(/budget 1\.00 · recency 0\.10/)).toBeInTheDocument()
  })

  it('explains the score on hover', () => {
    render(<ResultsTable results={[listing, listing2]} rankOffset={0} />)
    const [first, second] = cards()
    expect(first.querySelector('.score')).toHaveAttribute('title', 'Budget fit 1.00 · Recency 0.10 (98 days on market)')
    expect(second.querySelector('.score')).toHaveAttribute(
      'title',
      'No target budget: ranked by recency only · Recency 0.40 (143 days on market)',
    )
  })

  it('omits the budget part when the search had no target budget', () => {
    render(<ResultsTable results={[listing2]} rankOffset={0} />)
    const small = cards()[0].querySelector('.score small')!
    expect(small).toHaveTextContent('recency 0.40')
    expect(small).not.toHaveTextContent('budget')
  })

  it.each([
    [0.5, '50%'],
    [1.4, '100%'],
    [-0.2, '0%'],
  ])('sizes the score meter for %s as %s, clamped to 0–100%%', (score, width) => {
    render(<ResultsTable results={[{ ...listing, relevanceScore: score }]} rankOffset={0} />)
    expect(document.querySelector<HTMLElement>('.meter > i')!.style.width).toBe(width)
  })

  it('lists every source feed with its own details on hover', () => {
    render(<ResultsTable results={[listing2]} rankOffset={0} />)
    const sources = cards()[0].querySelectorAll('.source')
    expect(sources).toHaveLength(2)
    expect(sources[0]).toHaveTextContent('MLS_A A9')
    expect(sources[0]).toHaveAttribute('title', '12 Oak Avenue · $615,000 · listed 2026-07-01')
    expect(sources[1]).toHaveAttribute('title', '12 Oak Ave · $610,000 · listed 2026-06-28')
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<ResultsTable results={[listing, listing2]} rankOffset={0} />)
    await expectNoA11yViolations(container, { skip: COMPONENT_ONLY_SKIP })
  })
})
