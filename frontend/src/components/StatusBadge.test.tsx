/**
 * Component tests for {@link StatusBadge}.
 *
 * @module
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { COMPONENT_ONLY_SKIP, expectNoA11yViolations } from '../test/axe'
import { StatusBadge } from './StatusBadge'

afterEach(cleanup)

describe('StatusBadge', () => {
  it.each(['active', 'pending', 'sold'] as const)('shows %s with its own colour class', (status) => {
    render(<StatusBadge status={status} />)
    expect(screen.getByText(status)).toHaveClass('badge', `badge-${status}`)
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<StatusBadge status="pending" />)
    await expectNoA11yViolations(container, { skip: COMPONENT_ONLY_SKIP })
  })
})
