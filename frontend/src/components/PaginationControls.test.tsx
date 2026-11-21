/**
 * Component tests for {@link PaginationControls}.
 *
 * @module
 */

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pagination } from '../test/fixtures'
import { COMPONENT_ONLY_SKIP, expectNoA11yViolations } from '../test/axe'
import { PaginationControls } from './PaginationControls'

afterEach(cleanup)

/** The four buttons, by visible name. */
const buttons = () => ({
  first: screen.getByRole('button', { name: /First/ }),
  prev: screen.getByRole('button', { name: /Previous/ }),
  next: screen.getByRole('button', { name: /Next/ }),
  last: screen.getByRole('button', { name: /Last/ }),
})

/** A middle page of a 5-page result set. */
const middle = pagination({ page: 3, pageSize: 10, totalResults: 45, totalPages: 5, hasPrevious: true, hasNext: true })

describe('PaginationControls', () => {
  it('summarises the page and the range shown', () => {
    render(<PaginationControls pagination={middle} onPageChange={() => {}} />)
    expect(screen.getByRole('navigation', { name: 'Pagination' })).toHaveTextContent(
      'Page 3 of 5 · showing 21–30 of 45',
    )
  })

  it('caps the range on a partial last page', () => {
    render(
      <PaginationControls
        pagination={pagination({ page: 3, totalResults: 25, totalPages: 3, hasPrevious: true })}
        onPageChange={() => {}}
      />,
    )
    expect(screen.getByRole('navigation')).toHaveTextContent('showing 21–25 of 25')
  })

  it('disables First and Previous on the first page', () => {
    render(
      <PaginationControls
        pagination={pagination({ totalResults: 20, totalPages: 2, hasNext: true })}
        onPageChange={() => {}}
      />,
    )
    const b = buttons()
    expect(b.first).toBeDisabled()
    expect(b.prev).toBeDisabled()
    expect(b.next).toBeEnabled()
    expect(b.last).toBeEnabled()
  })

  it('disables Next and Last on the last page', () => {
    render(
      <PaginationControls
        pagination={pagination({ page: 2, totalResults: 20, totalPages: 2, hasPrevious: true })}
        onPageChange={() => {}}
      />,
    )
    const b = buttons()
    expect(b.first).toBeEnabled()
    expect(b.prev).toBeEnabled()
    expect(b.next).toBeDisabled()
    expect(b.last).toBeDisabled()
  })

  it('disables every button while loading', () => {
    render(<PaginationControls pagination={middle} onPageChange={() => {}} disabled />)
    Object.values(buttons()).forEach((b) => expect(b).toBeDisabled())
  })

  it.each([
    ['first', 1],
    ['prev', 2],
    ['next', 4],
    ['last', 5],
  ] as const)('%s button requests page %i', async (name, expected) => {
    const onPageChange = vi.fn()
    render(<PaginationControls pagination={middle} onPageChange={onPageChange} />)
    await userEvent.click(buttons()[name])
    expect(onPageChange).toHaveBeenCalledExactlyOnceWith(expected)
  })

  it('does not call back when a disabled button is clicked', async () => {
    const onPageChange = vi.fn()
    render(<PaginationControls pagination={middle} onPageChange={onPageChange} disabled />)
    await userEvent.click(buttons().next)
    expect(onPageChange).not.toHaveBeenCalled()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<PaginationControls pagination={middle} onPageChange={() => {}} />)
    await expectNoA11yViolations(container, { skip: COMPONENT_ONLY_SKIP })
  })
})
