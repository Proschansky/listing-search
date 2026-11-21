/**
 * Tests for the `main.tsx` entry point.
 *
 * @remarks
 * `react-dom/client` is mocked so the test checks the wiring (mount into
 * `#root`, wrapped in StrictMode) without running the whole app.
 *
 * @module
 */

import { StrictMode, type ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'

// vi.mock is hoisted above imports, so its spies must be hoisted too.
const { renderSpy, createRoot } = vi.hoisted(() => {
  const spy = vi.fn()
  return { renderSpy: spy, createRoot: vi.fn(() => ({ render: spy })) }
})
vi.mock('react-dom/client', () => ({ createRoot }))

afterEach(() => {
  document.body.innerHTML = ''
  vi.resetModules()
})

describe('main', () => {
  it('mounts <App /> inside an ErrorBoundary inside StrictMode into #root', async () => {
    document.body.innerHTML = '<div id="root"></div>'
    await import('./main')
    expect(createRoot).toHaveBeenCalledWith(document.getElementById('root'))
    const tree = renderSpy.mock.calls[0][0] as ReactElement<{ children: ReactElement<{ children: ReactElement }> }>
    expect(tree.type).toBe(StrictMode)
    expect(tree.props.children.type).toBe(ErrorBoundary)
    expect(tree.props.children.props.children.type).toBe(App)
  })
})
