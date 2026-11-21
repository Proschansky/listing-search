/**
 * Component tests for {@link SavedSearches}. The data rules are tested in
 * `lib/savedSearches.test.ts`.
 *
 * @module
 */

import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_QUERY, type SearchQuery } from '../api'
import { COMPONENT_ONLY_SKIP, expectNoA11yViolations } from '../test/axe'
import { MAX_SAVED, SAVED_KEY, type SavedSearch } from '../lib/savedSearches'
import { SavedSearches } from './SavedSearches'

afterEach(cleanup)

const vienna: SearchQuery = { ...EMPTY_QUERY, city: 'Vienna', minBedrooms: '3', page: 4 }

/** What's in storage right now. */
const stored = (): SavedSearch[] => JSON.parse(localStorage.getItem(SAVED_KEY) ?? '[]')

describe('SavedSearches', () => {
  it('starts empty, with a hint', () => {
    render(<SavedSearches current={EMPTY_QUERY} onApply={() => {}} />)
    expect(screen.getByText(/Nothing saved yet/)).toBeInTheDocument()
  })

  it('suggests the auto-generated name as the placeholder', () => {
    render(<SavedSearches current={vienna} onApply={() => {}} />)
    expect(screen.getByLabelText('Name for this search')).toHaveAttribute('placeholder', 'Vienna · 3+ bd')
  })

  it('saves the current search under a typed name, without its page number', async () => {
    render(<SavedSearches current={vienna} onApply={() => {}} />)
    await userEvent.type(screen.getByLabelText('Name for this search'), 'Family homes')
    await userEvent.click(screen.getByRole('button', { name: 'Save current' }))
    expect(screen.getByRole('button', { name: 'Family homes' })).toBeInTheDocument()
    expect(stored()[0]).toMatchObject({ name: 'Family homes', params: 'minBedrooms=3&city=Vienna&pageSize=10' })
    expect(screen.getByLabelText('Name for this search')).toHaveValue('')
  })

  it('uses the generated name when none is typed', async () => {
    render(<SavedSearches current={vienna} onApply={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'Save current' }))
    expect(screen.getByRole('button', { name: 'Vienna · 3+ bd' })).toBeInTheDocument()
  })

  it('replaces an identical earlier save instead of duplicating it', async () => {
    render(<SavedSearches current={vienna} onApply={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'Save current' }))
    await userEvent.type(screen.getByLabelText('Name for this search'), 'Renamed')
    await userEvent.click(screen.getByRole('button', { name: 'Save current' }))
    expect(stored().map((s) => s.name)).toEqual(['Renamed'])
  })

  it(`keeps at most ${MAX_SAVED}, dropping the oldest`, async () => {
    const { rerender } = render(<SavedSearches current={EMPTY_QUERY} onApply={() => {}} />)
    for (let i = 0; i <= MAX_SAVED; i++) {
      rerender(<SavedSearches current={{ ...EMPTY_QUERY, city: `City ${i}` }} onApply={() => {}} />)
      await userEvent.click(screen.getByRole('button', { name: 'Save current' }))
    }
    expect(stored()).toHaveLength(MAX_SAVED)
    expect(stored()[0].name).toBe(`City ${MAX_SAVED}`)
    expect(stored().some((s) => s.name === 'City 0')).toBe(false)
  })

  it('applies a saved search as a full query', async () => {
    localStorage.setItem(
      SAVED_KEY,
      JSON.stringify([{ id: '1', name: 'Pools', params: 'keyword=pool&status=active,sold', createdAt: '' }]),
    )
    const onApply = vi.fn()
    render(<SavedSearches current={EMPTY_QUERY} onApply={onApply} />)
    await userEvent.click(screen.getByRole('button', { name: 'Pools' }))
    expect(onApply).toHaveBeenCalledWith({ ...EMPTY_QUERY, keyword: 'pool', statuses: ['active', 'sold'] })
  })

  it('deletes a saved search', async () => {
    localStorage.setItem(SAVED_KEY, JSON.stringify([{ id: '1', name: 'Pools', params: 'keyword=pool', createdAt: '' }]))
    render(<SavedSearches current={EMPTY_QUERY} onApply={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'Delete saved search Pools' }))
    expect(screen.queryByRole('button', { name: 'Pools' })).not.toBeInTheDocument()
    expect(stored()).toEqual([])
  })

  it('ignores corrupt storage', () => {
    localStorage.setItem(SAVED_KEY, '[{"nope":1}]')
    render(<SavedSearches current={EMPTY_QUERY} onApply={() => {}} />)
    expect(screen.getByText(/Nothing saved yet/)).toBeInTheDocument()
  })

  it('has no accessibility violations, empty or with saves', async () => {
    const { container } = render(<SavedSearches current={vienna} onApply={() => {}} />)
    await expectNoA11yViolations(container, { skip: COMPONENT_ONLY_SKIP })
    await userEvent.click(within(container).getByRole('button', { name: 'Save current' }))
    await expectNoA11yViolations(container, { skip: COMPONENT_ONLY_SKIP })
  })
})
