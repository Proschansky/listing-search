/**
 * Component tests for {@link SortControl}.
 *
 * @module
 */

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SORT_LABELS } from '../api'
import { COMPONENT_ONLY_SKIP, expectNoA11yViolations } from '../test/axe'
import { SortControl } from './SortControl'

afterEach(cleanup)

describe('SortControl', () => {
  it('lists every sort option with its label, current one selected', () => {
    render(<SortControl value="newest" onChange={() => {}} />)
    const select = screen.getByRole('combobox', { name: 'Sort' }) as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.text)).toEqual(Object.values(SORT_LABELS))
    expect(select).toHaveValue('newest')
  })

  it('reports the chosen option', async () => {
    const onChange = vi.fn()
    render(<SortControl value="relevance" onChange={onChange} />)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Sort' }), 'price_asc')
    expect(onChange).toHaveBeenCalledWith('price_asc')
  })

  it('can be disabled', () => {
    render(<SortControl value="relevance" onChange={() => {}} disabled />)
    expect(screen.getByRole('combobox')).toBeDisabled()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<SortControl value="relevance" onChange={() => {}} />)
    await expectNoA11yViolations(container, { skip: COMPONENT_ONLY_SKIP })
  })
})
