/* oxlint-disable jsx-a11y/prefer-tag-over-role -- role="dialog" is deliberate; see the note on the dialog element below. */
/**
 * Slide-over panel with everything known about one listing.
 *
 * @module
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ApiError, fetchListing, type ListingResult, type SearchQuery } from '../api'
import { cx } from '../lib/cx'
import { formatDate, usd } from '../lib/format'
import ui from '../styles/ui.module.scss'
import styles from './ListingDrawer.module.scss'
import { StatusBadge } from './StatusBadge'

/** Props for {@link ListingDrawer}. */
interface Props {
  /** Key of the listing to show. */
  listingKey: string
  /**
   * The listing as it appeared in the results, if it did. Shown instantly
   * while the fresh copy loads; absent when the drawer was opened from a
   * shared link to a listing that isn't on the current page.
   */
  initial?: ListingResult
  /** Budget and date of the current search, so the score matches the list. */
  context: Pick<SearchQuery, 'targetBudget' | 'asOf'>
  /** Close the drawer (Escape, the close button, or a click on the backdrop). */
  onClose: () => void
}

/** What the drawer is showing: the data, or why it can't. */
type DetailState = { kind: 'ready'; listing: ListingResult } | { kind: 'loading' } | { kind: 'error'; message: string }

/** Elements that can take keyboard focus, for the focus trap. */
const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * A modal dialog showing one listing's full details, score breakdown and
 * every source feed record.
 *
 * @remarks
 * Accessibility follows the WAI-ARIA dialog pattern:
 * - `role="dialog"` + `aria-modal` + `aria-labelledby` (the address heading).
 * - Focus moves into the dialog on open, is trapped inside while it's open
 *   (Tab and Shift+Tab wrap around), and returns to whatever was focused
 *   before (usually the listing the user clicked) on close.
 * - Escape closes it.
 *
 * Data: shows `initial` immediately, then fetches the listing from
 * `GET /api/v1/listings/{key}` so a deep link works and data is never stale.
 *
 * @param props - See {@link Props}.
 * @returns The drawer and its backdrop.
 */
export function ListingDrawer({ listingKey, initial, context, onClose }: Props) {
  const [state, setState] = useState<DetailState>(initial ? { kind: 'ready', listing: initial } : { kind: 'loading' })
  const panelRef = useRef<HTMLDivElement>(null)

  // Fetch the fresh copy. Re-runs if a different listing is opened.
  const { targetBudget, asOf } = context
  useEffect(() => {
    const controller = new AbortController()
    fetchListing(listingKey, { targetBudget, asOf }, controller.signal)
      .then((listing) => setState({ kind: 'ready', listing }))
      .catch((err: unknown) => {
        if ((err as Error).name === 'AbortError') return
        // Keep showing the copy from the results if we have one; only a
        // drawer with nothing to show reports the failure.
        setState((prev) =>
          prev.kind === 'ready'
            ? prev
            : {
                kind: 'error',
                message:
                  err instanceof ApiError && err.status === 404
                    ? 'This listing is no longer available.'
                    : 'Could not load this listing.',
              },
        )
      })
    return () => controller.abort()
  }, [listingKey, targetBudget, asOf])

  // Focus management: move focus in on open, give it back on close.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    panelRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    return () => previouslyFocused?.focus?.()
  }, [])

  /** Escape closes; Tab / Shift+Tab wrap around inside the dialog. */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key !== 'Tab') return
    const focusable = Array.from(panelRef.current!.querySelectorAll<HTMLElement>(FOCUSABLE))
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const listing = state.kind === 'ready' ? state.listing : undefined

  return (
    <div className={styles.drawerRoot}>
      {/* The backdrop is a mouse convenience; keyboard users close with
          Escape or the Close button, so it needs no key handler or role. */}
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div className={styles.drawerBackdrop} onClick={onClose} data-testid="drawer-backdrop" />
      {/* A div with role="dialog" rather than <dialog>: the native element's
          showModal() isn't implemented in jsdom, so its behaviour couldn't be
          unit-tested. The focus trap and Escape handling below provide what
          showModal() would, and are covered by tests. The keydown handler on
          the dialog container is what implements that keyboard support. */}
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={panelRef}
        className={styles.drawer}
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
        aria-busy={state.kind === 'loading'}
        onKeyDown={onKeyDown}
      >
        <div className={styles.drawerHead}>
          <h2 id="drawer-title">
            {listing ? listing.address : state.kind === 'error' ? 'Listing unavailable' : 'Loading listing…'}
          </h2>
          <button type="button" className={ui.iconBtn} aria-label="Close details" onClick={onClose} data-autofocus>
            ×
          </button>
        </div>

        {state.kind === 'loading' && (
          <div className={cx(styles.drawerBody, styles.loading)} aria-hidden="true">
            <div className={cx(ui.sk, ui.skLineLg)} style={{ width: '40%' }} />
            <div className={cx(ui.sk, ui.skLine)} style={{ width: '70%' }} />
            <div className={cx(ui.sk, ui.skBlock)} />
          </div>
        )}

        {state.kind === 'error' && (
          <div className={styles.drawerBody}>
            <p role="alert" className={cx(ui.alert, ui.error)}>
              {state.message}
            </p>
          </div>
        )}

        {listing && (
          <div className={styles.drawerBody}>
            <div className={styles.drawerPrice}>
              <span className={cx(ui.price, styles.headlinePrice)}>{usd.format(listing.price)}</span>
              <StatusBadge status={listing.status} />
            </div>
            <p className={cx(ui.location, styles.location)}>
              {listing.city}, {listing.state} {listing.zip}
            </p>

            <dl className={styles.facts}>
              <div>
                <dt>Bedrooms</dt>
                <dd>{listing.bedrooms}</dd>
              </div>
              <div>
                <dt>Bathrooms</dt>
                <dd>{listing.bathrooms}</dd>
              </div>
              <div>
                <dt>Square feet</dt>
                <dd>{listing.sqft.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Price / sq ft</dt>
                <dd>{listing.sqft > 0 ? usd.format(listing.price / listing.sqft) : '—'}</dd>
              </div>
              <div>
                <dt>Listed</dt>
                <dd>{formatDate(listing.listedDate)}</dd>
              </div>
              <div>
                <dt>Days on market</dt>
                <dd>{listing.scoreBreakdown.daysOnMarket}</dd>
              </div>
            </dl>

            {listing.description && <p className={styles.description}>{listing.description}</p>}

            <h3>Why it ranked here</h3>
            <table className={styles.miniTable}>
              <tbody>
                <tr>
                  <th scope="row">Relevance score</th>
                  <td>{listing.relevanceScore.toFixed(3)}</td>
                </tr>
                <tr>
                  <th scope="row">Budget fit</th>
                  <td>
                    {listing.scoreBreakdown.budget === null
                      ? 'No target budget set'
                      : listing.scoreBreakdown.budget.toFixed(2)}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Recency</th>
                  <td>{listing.scoreBreakdown.recency.toFixed(2)}</td>
                </tr>
              </tbody>
            </table>

            <h3>
              Source feeds <span className={ui.count}>({listing.sources.length})</span>
            </h3>
            {/* The table can be wider than the drawer (long addresses, wider
                fonts on some systems), so it scrolls sideways. A scrollable
                area must be reachable by keyboard, so the wrapper is a
                focusable, labelled region that arrow keys can scroll. */}
            {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- WCAG requires scrollable regions to be keyboard-focusable */}
            <section className={styles.tableScroll} tabIndex={0} aria-label="Source feeds table">
              <table className={styles.miniTable}>
                <thead>
                  <tr>
                    <th scope="col">Feed</th>
                    <th scope="col">Address as listed</th>
                    <th scope="col" className={styles.num}>
                      Price
                    </th>
                    <th scope="col">Listed</th>
                  </tr>
                </thead>
                <tbody>
                  {listing.sources.map((s) => (
                    <tr key={s.source + s.id}>
                      <td>
                        {s.source} <code>{s.id}</code>
                      </td>
                      <td>{s.address}</td>
                      <td className={styles.num}>{usd.format(s.price)}</td>
                      <td>{formatDate(s.listedDate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <a
              className={cx(ui.btn, ui.btnSm, styles.mapLink)}
              href={`https://www.openstreetmap.org/?mlat=${listing.latitude}&mlon=${listing.longitude}#map=17/${listing.latitude}/${listing.longitude}`}
              target="_blank"
              rel="noreferrer"
            >
              Open in OpenStreetMap ↗
            </a>
          </div>
        )}
      </div>
    </div>
  )
}
