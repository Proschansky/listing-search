/**
 * Component tests for {@link SegmentedControl}.
 *
 * @module
 */

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COMPONENT_ONLY_SKIP, expectNoA11yViolations } from '../test/axe'
import { SegmentedControl } from './SegmentedControl'

afterEach(cleanup)

const options = [
  { value: 'list', label: 'List' },
  { value: 'map', label: 'Map' },
] as const

describe('SegmentedControl', () => {
  it('is a labelled group with the current option pressed', () => {
    render(<SegmentedControl label="Results view" options={[...options]} value="map" onChange={() => {}} />)
    expect(screen.getByRole('group', { name: 'Results view' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Map' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('reports the clicked option', async () => {
    const onChange = vi.fn()
    render(<SegmentedControl label="Results view" options={[...options]} value="list" onChange={onChange} />)
    await userEvent.click(screen.getByRole('button', { name: 'Map' }))
    expect(onChange).toHaveBeenCalledWith('map')
  })

  it('has no accessibility violations', async () => {
    const { container } = render(
      <SegmentedControl label="Results view" options={[...options]} value="list" onChange={() => {}} />,
    )
    await expectNoA11yViolations(container, { skip: COMPONENT_ONLY_SKIP })
  })
})
