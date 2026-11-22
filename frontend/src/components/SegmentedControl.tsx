/**
 * A small group of mutually exclusive buttons (List / Map, theme picker).
 *
 * @module
 */

import ui from '../styles/ui.module.scss'
import styles from './SegmentedControl.module.scss'

/** One choice in a {@link SegmentedControl}. */
export interface Segment<T extends string> {
  value: T
  label: string
}

/** Props for {@link SegmentedControl}. */
interface Props<T extends string> {
  /** Accessible name for the whole group, for example "Results view". */
  label: string
  options: Segment<T>[]
  value: T
  onChange: (value: T) => void
}

/**
 * Toggle buttons that behave as one choice.
 *
 * @remarks
 * Each button carries `aria-pressed`, the standard way to expose a toggle
 * button's state. The buttons sit in a `<fieldset>` whose (visually hidden)
 * `<legend>` names the group, so screen readers announce, for example,
 * "Results view, group: List, toggle button, pressed".
 *
 * @typeParam T - The union of option values.
 * @param props - See {@link Props}.
 * @returns The button group.
 */
export function SegmentedControl<T extends string>({ label, options, value, onChange }: Props<T>) {
  return (
    <fieldset className={styles.segmented}>
      <legend className={ui.srOnly}>{label}</legend>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </fieldset>
  )
}
