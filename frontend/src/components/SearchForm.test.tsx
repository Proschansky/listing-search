/**
 * Component tests for {@link SearchForm}.
 *
 * @remarks
 * The form is controlled, so most tests render it through a tiny stateful
 * harness that feeds `onChange` back into `value`, the way App does.
 *
 * @module
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_QUERY, type SearchQuery } from '../api'
import { PRICE_STOPS } from '../lib/price'
import { COMPONENT_ONLY_SKIP, expectNoA11yViolations } from '../test/axe'
import { SearchForm } from './SearchForm'

afterEach(cleanup)

type Props = ComponentProps<typeof SearchForm>

/**
 * Render the form with real state, reporting every change to `onChange`.
 *
 * @param overrides - Props to override.
 * @returns The spies passed in.
 */
function renderForm(overrides: Partial<Props> = {}) {
  const spies = { onChange: vi.fn(), onSubmit: vi.fn(), onReset: vi.fn() }
  function Harness() {
    const [value, setValue] = useState<SearchQuery>(overrides.value ?? EMPTY_QUERY)
    return (
      <SearchForm
        cities={[]}
        fieldErrors={[]}
        busy={false}
        {...overrides}
        value={value}
        onChange={(q) => {
          spies.onChange(q)
          setValue(q)
        }}
        onSubmit={overrides.onSubmit ?? spies.onSubmit}
        onReset={overrides.onReset ?? spies.onReset}
      />
    )
  }
  const result = render(<Harness />)
  return { ...spies, ...result }
}

/** The most recent query passed to onChange. */
const lastChange = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.at(-1)![0] as SearchQuery

describe('SearchForm', () => {
  it.each([
    [/Min price/, 'minPrice', '400000'],
    [/Max price/, 'maxPrice', '650000'],
    [/Min bedrooms/, 'minBedrooms', '3'],
    [/City/, 'city', 'Reston'],
    [/Keywords/, 'keyword', 'pool, garage'],
    [/Target budget/, 'targetBudget', '470000'],
  ] as const)('typing in %s updates %s', async (label, field, text) => {
    const { onChange } = renderForm()
    await userEvent.type(screen.getByLabelText(label), text)
    expect(lastChange(onChange)[field]).toBe(text)
  })

  it('takes prices with commas and a dollar sign, and shows commas afterwards', async () => {
    const { onChange } = renderForm()
    const box = screen.getByLabelText(/Max price/)
    await userEvent.type(box, '$1,250,000')
    expect(lastChange(onChange).maxPrice).toBe('1250000')
    await userEvent.tab()
    expect(box).toHaveValue('1,250,000')
  })

  it('sets the price range and the target budget from the sliders', () => {
    const { onChange } = renderForm({ value: { ...EMPTY_QUERY, city: 'Vienna' } })
    const at = (price: number) => String(PRICE_STOPS.indexOf(price))
    fireEvent.change(screen.getByRole('slider', { name: 'Lowest price' }), { target: { value: at(400_000) } })
    fireEvent.change(screen.getByRole('slider', { name: 'Highest price' }), { target: { value: at(2_000_000) } })
    fireEvent.change(screen.getByRole('slider', { name: 'Budget' }), { target: { value: at(750_000) } })
    expect(lastChange(onChange)).toMatchObject({
      city: 'Vienna',
      minPrice: '400000',
      maxPrice: '2000000',
      targetBudget: '750000',
    })
    // The boxes follow the sliders.
    expect(screen.getByLabelText(/Min price/)).toHaveValue('400,000')
  })

  it('keeps other fields when one changes', async () => {
    const { onChange } = renderForm({ value: { ...EMPTY_QUERY, city: 'Vienna' } })
    await userEvent.type(screen.getByLabelText(/Keywords/), 'pool')
    expect(lastChange(onChange)).toMatchObject({ city: 'Vienna', keyword: 'pool' })
  })

  it('updates the page size under Advanced', async () => {
    const { onChange } = renderForm()
    await userEvent.click(screen.getByText('Advanced'))
    await userEvent.selectOptions(screen.getByLabelText('Results per page'), '50')
    expect(lastChange(onChange).pageSize).toBe('50')
  })

  it('has no as-of date input, and keeps an asOf it was given', async () => {
    const { onChange } = renderForm({ value: { ...EMPTY_QUERY, asOf: '2026-09-01' } })
    await userEvent.click(screen.getByText('Advanced'))
    expect(screen.queryByLabelText(/as of/i)).toBeNull()
    await userEvent.type(screen.getByLabelText(/City/), 'R')
    expect(lastChange(onChange).asOf).toBe('2026-09-01')
  })

  it('offers 5, 10, 20 and 50 results per page', () => {
    renderForm()
    const options = Array.from((screen.getByLabelText('Results per page') as HTMLSelectElement).options).map(
      (o) => o.value,
    )
    expect(options).toEqual(['5', '10', '20', '50'])
  })

  it('suggests the cities it is given', () => {
    renderForm({ cities: ['Reston', 'Vienna'] })
    const input = screen.getByLabelText(/City/)
    const list = document.getElementById(input.getAttribute('list')!)!
    expect(Array.from(list.querySelectorAll('option')).map((o) => o.value)).toEqual(['Reston', 'Vienna'])
  })

  it('reflects the selected statuses as checked toggles', () => {
    renderForm({ value: { ...EMPTY_QUERY, statuses: ['active', 'sold'] } })
    expect(screen.getByRole('checkbox', { name: 'active' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'pending' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'sold' })).toBeChecked()
  })

  it('adds and removes statuses', async () => {
    const { onChange } = renderForm()
    await userEvent.click(screen.getByRole('checkbox', { name: 'pending' }))
    expect(lastChange(onChange).statuses).toEqual(['active', 'pending'])
    await userEvent.click(screen.getByRole('checkbox', { name: 'active' }))
    expect(lastChange(onChange).statuses).toEqual(['pending'])
  })

  it('will not untick the last remaining status', async () => {
    const { onChange } = renderForm()
    await userEvent.click(screen.getByRole('checkbox', { name: 'active' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('checkbox', { name: 'active' })).toBeChecked()
  })

  it('submits via the button and via Enter, without reloading the page', async () => {
    const { onSubmit } = renderForm()
    await userEvent.click(screen.getByRole('button', { name: 'Search' }))
    await userEvent.type(screen.getByLabelText(/City/), 'Vienna{Enter}')
    expect(onSubmit).toHaveBeenCalledTimes(2)
  })

  it('prevents the native form submission', () => {
    renderForm()
    const event = new Event('submit', { bubbles: true, cancelable: true })
    screen.getByRole('form', { name: 'Search listings' }).dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('calls onReset from the Reset button', async () => {
    const { onReset, onSubmit } = renderForm()
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(onReset).toHaveBeenCalledOnce()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('disables both buttons while busy', () => {
    renderForm({ busy: true })
    expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled()
  })

  it('turns off native validation so the API owns the rules', () => {
    renderForm()
    expect(screen.getByRole('form')).toHaveAttribute('novalidate')
  })

  it('marks a field invalid and links its error message', () => {
    renderForm({ fieldErrors: [{ field: 'minPrice', message: 'must be ≥ 0' }] })
    const input = screen.getByLabelText(/Min price/)
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription('must be ≥ 0')
    expect(input.closest('label')).toHaveClass('invalid')
    expect(screen.getByLabelText(/Max price/)).toHaveAttribute('aria-invalid', 'false')
  })

  it('shows page-size and status errors', () => {
    renderForm({
      fieldErrors: [
        { field: 'pageSize', message: 'must be at most 100' },
        { field: 'status', message: 'unknown status' },
      ],
    })
    expect(screen.getByText('must be at most 100')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Status' })).toHaveClass('invalid')
  })

  it('has no accessibility violations', async () => {
    const { container } = renderForm({ cities: ['Vienna'] })
    await userEvent.click(screen.getByText('Advanced'))
    await expectNoA11yViolations(container, { skip: COMPONENT_ONLY_SKIP })
  })

  it('has no accessibility violations when showing field errors', async () => {
    const { container } = renderForm({
      fieldErrors: [
        { field: 'minPrice', message: 'must be ≥ 0' },
        { field: 'pageSize', message: 'must be at most 100' },
      ],
    })
    await expectNoA11yViolations(container, { skip: COMPONENT_ONLY_SKIP })
  })
})
