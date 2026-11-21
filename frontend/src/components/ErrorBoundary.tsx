/**
 * Last line of defence against rendering crashes.
 *
 * @module
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { cx } from '../lib/cx'
import ui from '../styles/ui.module.scss'
import styles from './ErrorBoundary.module.scss'

/** Props for {@link ErrorBoundary}. */
interface Props {
  children: ReactNode
  /**
   * Called with every caught error. Defaults to `console.error`; in
   * production this is where an error-monitoring service (Sentry, Datadog
   * RUM, …) would be called.
   */
  onError?: (error: Error, info: ErrorInfo) => void
}

/** Whether a crash has been caught, and what it was. */
interface State {
  error: Error | null
}

/**
 * Catch errors thrown while rendering anything inside it and show a
 * recoverable fallback instead of a blank white page.
 *
 * @remarks
 * Without a boundary, one unexpected `undefined` deep in a component unmounts
 * the whole React tree. React only supports this as a *class* component
 * (`getDerivedStateFromError` / `componentDidCatch` have no hook equivalent).
 *
 * Boundaries catch errors during rendering and lifecycle methods. They don't
 * catch errors in event handlers or promises; those are handled where they
 * happen (see the request state in `App`).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  /** Switch to the fallback on the next render. */
  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  /** Report the error (with the component stack) once it's been caught. */
  componentDidCatch(error: Error, info: ErrorInfo) {
    ;(this.props.onError ?? ((e, i) => console.error('Unhandled UI error', e, i.componentStack)))(error, info)
  }

  /** Clear the error and render the children again. */
  private reset = () => this.setState({ error: null })

  render() {
    if (!this.state.error) return this.props.children
    return (
      <main className={styles.crash}>
        <div role="alert" className={cx(ui.card, styles.crashCard)}>
          <h1>Something went wrong</h1>
          <p>The page hit an unexpected error. Your search is kept in the address bar, so nothing is lost.</p>
          <pre className={styles.crashDetail}>{this.state.error.message}</pre>
          <div className={styles.actions}>
            <button type="button" className={ui.btn} onClick={this.reset}>
              Try again
            </button>
            <button type="button" className={cx(ui.btn, ui.btnPrimary)} onClick={() => window.location.reload()}>
              Reload page
            </button>
          </div>
        </div>
      </main>
    )
  }
}
