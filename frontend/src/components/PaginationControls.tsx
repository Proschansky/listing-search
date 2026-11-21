/**
 * Paging controls for the results table.
 *
 * @module
 */

import type { Pagination } from '../api'
import { cx } from '../lib/cx'
import ui from '../styles/ui.module.scss'
import styles from './PaginationControls.module.scss'

/** Props for {@link PaginationControls}. */
interface Props {
  /** Page metadata straight from the API response. */
  pagination: Pagination
  /**
   * Called with the page the user wants. App performs the fetch.
   *
   * @param page - Target page, starting at 1.
   */
  onPageChange: (page: number) => void
  /** `true` while a request is in flight. Disables every button. */
  disabled?: boolean
}

/**
 * First / Previous / Next / Last buttons with a "showing X–Y of N" summary.
 *
 * @remarks
 * Buttons are enabled from the API's `hasPrevious` / `hasNext` flags rather
 * than redoing the maths here. All of them are disabled while loading, so
 * rapid clicks can't queue up several page requests.
 *
 * @param props - See {@link Props}.
 * @returns The rendered pagination bar.
 */
export function PaginationControls({ pagination, onPageChange, disabled }: Props) {
  const { page, pageSize, totalPages, totalResults, hasPrevious, hasNext } = pagination

  // The 1-based range of results on this page. Math.min handles a partial
  // last page: page 3 of 25 results at 10 per page shows "21–25", not "21–30".
  const first = (page - 1) * pageSize + 1
  const last = Math.min(page * pageSize, totalResults)

  return (
    <nav aria-label="Pagination" className={styles.pagination}>
      <span className={styles.summary}>
        Page {page} of {totalPages} · showing{' '}
        <b>
          {first}–{last}
        </b>{' '}
        of <b>{totalResults}</b>
      </span>
      <div className={styles.buttons}>
        <button
          type="button"
          className={cx(ui.btn, ui.btnSm)}
          onClick={() => onPageChange(1)}
          disabled={disabled || !hasPrevious}
        >
          « First
        </button>
        <button
          type="button"
          className={cx(ui.btn, ui.btnSm)}
          onClick={() => onPageChange(page - 1)}
          disabled={disabled || !hasPrevious}
        >
          ‹ Previous
        </button>
        <button
          type="button"
          className={cx(ui.btn, ui.btnSm)}
          onClick={() => onPageChange(page + 1)}
          disabled={disabled || !hasNext}
        >
          Next ›
        </button>
        <button
          type="button"
          className={cx(ui.btn, ui.btnSm)}
          onClick={() => onPageChange(totalPages)}
          disabled={disabled || !hasNext}
        >
          Last »
        </button>
      </div>
    </nav>
  )
}
