/**
 * Component tests for {@link ErrorBoundary}.
 *
 * @module
 */

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COMPONENT_ONLY_SKIP, expectNoA11yViolations } from '../test/axe'
import { ErrorBoundary } from './ErrorBoundary'

/** Throws while `shouldThrow.current` is true, so a test can "fix" it and retry. */
const shouldThrow = { current: true }
function Bomb() {
  if (shouldThrow.current) throw new Error('kaboom')
  return <p>recovered</p>
}

beforeEach(() => {
  shouldThrow.current = true
  // React logs caught render errors to console.error; keep test output clean.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ErrorBoundary', () => {
  it('renders its children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>fine</p>
      </ErrorBoundary>,
    )
    expect(screen.getByText('fine')).toBeInTheDocument()
  })

  it('shows a recoverable fallback with the error message instead of a blank page', () => {
    render(
      <ErrorBoundary onError={() => {}}>
        <Bomb />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong')
    expect(screen.getByText('kaboom')).toBeInTheDocument()
  })

  it('reports the error and component stack to onError', () => {
    const onError = vi.fn()
    render(
      <ErrorBoundary onError={onError}>
        <Bomb />
      </ErrorBoundary>,
    )
    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error)
    expect(onError.mock.calls[0][1]).toHaveProperty('componentStack')
  })

  it('logs to the console by default', () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    )
    expect(console.error).toHaveBeenCalledWith('Unhandled UI error', expect.any(Error), expect.anything())
  })

  it('"Try again" re-renders the children', async () => {
    render(
      <ErrorBoundary onError={() => {}}>
        <Bomb />
      </ErrorBoundary>,
    )
    shouldThrow.current = false
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByText('recovered')).toBeInTheDocument()
  })

  it('"Reload page" reloads the window', async () => {
    const reload = vi.fn()
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload })
    render(
      <ErrorBoundary onError={() => {}}>
        <Bomb />
      </ErrorBoundary>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Reload page' }))
    expect(reload).toHaveBeenCalledOnce()
  })

  it('has no accessibility violations in its fallback', async () => {
    const { container } = render(
      <ErrorBoundary onError={() => {}}>
        <Bomb />
      </ErrorBoundary>,
    )
    await expectNoA11yViolations(container, { skip: COMPONENT_ONLY_SKIP })
  })
})
