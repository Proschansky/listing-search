/**
 * Placeholder cards shown while the first page of results loads.
 *
 * @module
 */

import { cx } from '../lib/cx'
import ui from '../styles/ui.module.scss'
import styles from './ResultsSkeleton.module.scss'
// The real cards' layout, so placeholders have exactly their shape.
import list from './ResultsTable.module.scss'

/** Props for {@link ResultsSkeleton}. */
interface Props {
  /** How many placeholder cards to draw. */
  count?: number
}

/**
 * Grey, gently pulsing shapes in the layout of real listing cards.
 *
 * @remarks
 * A skeleton feels faster than a spinner because the page already has its
 * final shape, and nothing jumps around when the data arrives. It's purely
 * decorative, so it's hidden from screen readers (`aria-hidden`); the
 * "Loading…" status text next to the results heading is what they announce.
 *
 * @param props - See {@link Props}.
 * @returns The placeholder list.
 */
export function ResultsSkeleton({ count = 3 }: Props) {
  return (
    <ol className={list.listings} aria-hidden="true" data-testid="results-skeleton">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className={cx(ui.card, list.listing, styles.skeleton)}>
          <div className={cx(list.rank, ui.sk)} />
          <div className={cx(list.listingMain, styles.lines)}>
            <div className={cx(ui.sk, ui.skLine)} style={{ width: '45%' }} />
            <div className={cx(ui.sk, ui.skLineSm)} style={{ width: '30%' }} />
            <div className={cx(ui.sk, ui.skLineSm)} style={{ width: '60%' }} />
          </div>
          <div className={list.listingSide}>
            <div className={cx(ui.sk, ui.skLineLg)} style={{ width: '7rem' }} />
            <div className={cx(ui.sk, ui.skLineSm)} style={{ width: '5rem' }} />
          </div>
        </li>
      ))}
    </ol>
  )
}
