/**
 * Entry point: mounts the React app into the `<div id="root">` in `index.html`,
 * inside an error boundary.
 *
 * @remarks
 * `StrictMode` adds development-only checks. React deliberately mounts,
 * unmounts and re-mounts components to expose missing effect cleanup, so in
 * development each initial request is sent twice. App's cleanup aborts the
 * first one, so only one response is ever applied. Production builds don't do
 * this double run.
 *
 * @packageDocumentation
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/global.scss'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary'

// ErrorBoundary wraps the whole app, so even a crash in App itself shows a
// recoverable "Something went wrong" screen instead of a blank page.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
