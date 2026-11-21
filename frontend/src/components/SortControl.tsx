/**
 * Result-order picker.
 *
 * @module
 */

import { SORT_LABELS, type SortOption } from '../api'
import styles from './SortControl.module.scss'

/** Props for {@link SortControl}. */
interface Props {
  value: SortOption
  /** Called with the newly chosen order. App re-runs the search from page 1. */
  onChange: (sort: SortOption) => void
  disabled?: boolean
}

/**
 * A labelled `<select>` of every {@link SortOption}.
 *
 * @remarks
 * A native select (rather than a custom dropdown) gives keyboard, screen
 * reader and mobile support for free.
 *
 * @param props - See {@link Props}.
 * @returns The sort control.
 */
export function SortControl({ value, onChange, disabled }: Props) {
  return (
    <label className={styles.inlineField}>
      <span>Sort</span>
      <select value={value} onChange={(e) => onChange(e.target.value as SortOption)} disabled={disabled}>
        {(Object.keys(SORT_LABELS) as SortOption[]).map((option) => (
          <option key={option} value={option}>
            {SORT_LABELS[option]}
          </option>
        ))}
      </select>
    </label>
  )
}
