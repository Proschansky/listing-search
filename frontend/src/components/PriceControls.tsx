/**
 * Price inputs for the search form: a text box that shows commas, a slider
 * for one price (the target budget) and a two-handle slider for a range
 * (min and max price).
 *
 * @remarks
 * Prices run to six and seven figures, so the browser's number input, with
 * its arrows that step by $1, is the wrong tool. The text box takes typed or
 * pasted amounts ("650,000", "$650000"). The sliders are for rough choices
 * and cover $0 to $50,000,000 in steps that grow with the price (see
 * `PRICE_STOPS` in `lib/price.ts`). Both edit the same query string, so they
 * always agree.
 *
 * None of this validates. A value the box can't read as a whole number (say
 * "-5" or "abc") is passed to the API unchanged, and the API's error shows
 * next to the field, as with every other input.
 *
 * @module
 */

import { useRef, useState, type CSSProperties, type InputHTMLAttributes } from 'react'
import { cx } from '../lib/cx'
import {
  LAST_STOP,
  NO_MAX,
  PRICE_STOPS,
  amountOf,
  cleanPrice,
  formatPrice,
  moveHandle,
  rangePosition,
  stopFor,
} from '../lib/price'
import styles from './PriceControls.module.scss'

/** Props for {@link PriceInput}. */
type PriceInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  /** The query value, digits only when valid (`"650000"`). */
  value: string
  /** Called with the cleaned text on every edit. */
  onChange: (value: string) => void
}

/**
 * A text box for a dollar amount.
 *
 * @remarks
 * It shows commas only when it isn't focused. Adding them while someone types
 * would move the cursor around under them.
 *
 * @param props - See {@link PriceInputProps}; other props go to the `<input>`.
 * @returns The input.
 */
export function PriceInput({ value, onChange, onFocus, onBlur, ...rest }: PriceInputProps) {
  const [editing, setEditing] = useState(false)
  return (
    <input
      {...rest}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      value={editing ? value : formatPrice(value)}
      onChange={(e) => onChange(cleanPrice(e.target.value))}
      onFocus={(e) => {
        setEditing(true)
        onFocus?.(e)
      }}
      onBlur={(e) => {
        setEditing(false)
        onBlur?.(e)
      }}
    />
  )
}

/** Dollars for screen readers: "$650,000", or "$500,000.50" with cents. */
const spoken = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  trailingZeroDisplay: 'stripIfInteger',
})

/**
 * How a screen reader reads a slider's position.
 *
 * @remarks
 * Any amount the API accepts is read out, decimals included. Saying "No max"
 * for $500,000.50 would tell a screen-reader user a filter is off when it's on.
 *
 * @param raw - The query value.
 * @param blank - What to say when the value is blank, such as "No min".
 * @returns For example `"$650,000"`.
 */
function valueText(raw: string, blank: string): string {
  const amount = amountOf(raw)
  return amount === undefined ? blank : spoken.format(amount)
}

/** Props for {@link PriceSlider}. */
interface PriceSliderProps {
  /** Accessible name. Keep it different from the text box's label. */
  label: string
  /** The query value. */
  value: string
  /** Called with the new value; `""` at the far left (no value). */
  onChange: (value: string) => void
  /** Read out when the value is blank. */
  blankText: string
}

/**
 * The attributes every price slider shares. The input's value is a position
 * on the slider, not dollars; `aria-valuetext` tells screen readers the
 * amount.
 *
 * @param position - The current position.
 * @param last - The highest position.
 * @param raw - The query value, read out as dollars.
 * @param blank - Read out when the value is blank.
 * @returns Props for a range `<input>`.
 */
function rangeProps(position: number, last: number, raw: string, blank: string) {
  return {
    type: 'range',
    min: 0,
    max: last,
    step: 1,
    value: position,
    'aria-valuetext': valueText(raw, blank),
  } as const
}

/**
 * A one-handle price slider. All the way left means "not set".
 *
 * @param props - See {@link PriceSliderProps}.
 * @returns The slider.
 */
export function PriceSlider({ label, value, onChange, blankText }: PriceSliderProps) {
  const at = stopFor(value, 0)
  return (
    <div className={styles.track} style={fill(0, at, LAST_STOP)}>
      <input
        {...rangeProps(at, LAST_STOP, value, blankText)}
        className={styles.range}
        aria-label={label}
        onChange={(e) => {
          const i = Number(e.target.value)
          onChange(i === 0 ? '' : String(PRICE_STOPS[i]))
        }}
      />
    </div>
  )
}

/** Props for {@link PriceRangeSlider}. */
interface PriceRangeSliderProps {
  /** The minimum price query value. */
  min: string
  /** The maximum price query value. */
  max: string
  /** Called with both values whenever either handle moves. */
  onChange: (range: { min: string; max: string }) => void
}

/**
 * A two-handle slider for a price range.
 *
 * @remarks
 * It's two native range inputs laid over one track, so each handle keeps the
 * browser's keyboard support and is its own labelled control. The left handle
 * all the way left means "no minimum"; the right handle all the way right
 * means "no maximum". Those end positions are only ever "unset" (see
 * `NO_MIN` in `lib/price.ts`). {@link moveHandle} decides the new range: keyboard
 * steps stop at the other handle, while a mouse or touch drag may pass it.
 *
 * @param props - See {@link PriceRangeSliderProps}.
 * @returns The slider.
 */
export function PriceRangeSlider({ min, max, onChange }: PriceRangeSliderProps) {
  const lo = rangePosition(min, 'min')
  const hi = rangePosition(max, 'max')
  // The other end's value when a pointer drag started (see moveHandle).
  const drag = useRef<string | undefined>(undefined)

  /**
   * Remember the other end while a pointer is down on a handle.
   *
   * @param other - The other end's current value.
   */
  const startDrag = (other: string) => {
    drag.current = other
    const end = () => {
      drag.current = undefined
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  return (
    <div className={cx(styles.track, styles.dual)} style={fill(lo, hi, NO_MAX)}>
      <input
        {...rangeProps(lo, NO_MAX, min, 'No min')}
        className={styles.range}
        aria-label="Lowest price"
        onPointerDown={() => startDrag(max)}
        onChange={(e) => onChange(moveHandle('low', Number(e.target.value), { min, max }, drag.current))}
      />
      <input
        {...rangeProps(hi, NO_MAX, max, 'No max')}
        className={styles.range}
        aria-label="Highest price"
        onPointerDown={() => startDrag(min)}
        onChange={(e) => onChange(moveHandle('high', Number(e.target.value), { min, max }, drag.current))}
      />
    </div>
  )
}

/**
 * CSS variables that colour the track between two positions.
 *
 * @param from - Position where the filled part starts.
 * @param to - Position where it ends.
 * @param last - The slider's highest position.
 * @returns Inline style with `--from` and `--to` as percentages.
 */
function fill(from: number, to: number, last: number): CSSProperties {
  return { '--from': `${(from / last) * 100}%`, '--to': `${(to / last) * 100}%` } as CSSProperties
}
