/**
 * Component tests for {@link ResultsSkeleton}.
 *
 * @module
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { COMPONENT_ONLY_SKIP, expectNoA11yViolations } from '../test/axe'
import { ResultsSkeleton } from './ResultsSkeleton'

afterEach(cleanup)

describe('ResultsSkeleton', () => {
  it('draws three placeholder cards by default', () => {
    render(<ResultsSkeleton />)
    expect(screen.getByTestId('results-skeleton').querySelectorAll('li')).toHaveLength(3)
  })

  it('draws the requested number of cards', () => {
    render(<ResultsSkeleton count={5} />)
    expect(screen.getByTestId('results-skeleton').querySelectorAll('li')).toHaveLength(5)
  })

  it('is hidden from assistive technology', () => {
    render(<ResultsSkeleton />)
    expect(screen.getByTestId('results-skeleton')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<ResultsSkeleton />)
    await expectNoA11yViolations(container, { skip: COMPONENT_ONLY_SKIP })
  })
})
