/**
 * Helpers for dollar amounts typed into the search form, and the range the
 * price sliders cover.
 *
 * @module
 */

/**
 * Price bands the sliders move through: up to each `upTo`, one step is
 * `step` dollars.
 *
 * @remarks
 * Homes cost anywhere from a few hundred thousand dollars to tens of
 * millions. Even steps across that whole span would squeeze every ordinary
 * price into the first few pixels, so steps grow with the price: $25,000
 * near $500,000, $1,000,000 near $30,000,000. Amounts the slider can't land
 * on, or above its top, can always be typed.
 */
const BANDS = [
  { upTo: 1_000_000, step: 25_000 },
  { upTo: 2_000_000, step: 50_000 },
  { upTo: 5_000_000, step: 100_000 },
  { upTo: 10_000_000, step: 250_000 },
  { upTo: 25_000_000, step: 500_000 },
  { upTo: 50_000_000, step: 1_000_000 },
]

/** Every price a slider can land on, from $0 up, in order. */
export const PRICE_STOPS: readonly number[] = (() => {
  const stops = [0]
  for (const { upTo, step } of BANDS) {
    while (stops[stops.length - 1] < upTo) stops.push(stops[stops.length - 1] + step)
  }
  return stops
})()

/** Index of the last stop, where a slider ends. */
export const LAST_STOP = PRICE_STOPS.length - 1

/** Digits only: the one shape the boxes reformat and the sliders follow. */
export const WHOLE_NUMBER = /^\d+$/
const money = new Intl.NumberFormat('en-US')

/**
 * Remove the characters people type or paste around a price: commas,
 * dollar signs and spaces. Anything else is left for the API to judge.
 *
 * @param typed - What's in the box, for example `"$650,000"`.
 * @returns The cleaned text, for example `"650000"`.
 */
export function cleanPrice(typed: string): string {
  return typed.replace(/[\s$,]/g, '')
}

/**
 * Add thousands separators to a whole number. Other text comes back as is,
 * so an invalid entry stays visible next to its error.
 *
 * @param raw - A query value such as `"650000"`.
 * @returns `"650,000"`, or `raw` unchanged.
 */
export function formatPrice(raw: string): string {
  return WHOLE_NUMBER.test(raw) ? money.format(Number(raw)) : raw
}

/**
 * Which slider stop shows a query value: the highest stop at or below it.
 *
 * @param raw - The query value.
 * @param empty - The stop to use when the value is blank or unreadable.
 * @returns An index into {@link PRICE_STOPS}.
 */
export function stopFor(raw: string, empty: number): number {
  const price = amountOf(raw)
  if (price === undefined) return empty
  let i = 0
  while (i < LAST_STOP && PRICE_STOPS[i + 1] <= price) i++
  return i
}

/**
 * A query value as a dollar amount, if it is one.
 *
 * @remarks
 * Reads text the way the API does (Python's `float()` in
 * `backend/app/validation.py`), so the sliders and the API agree on what
 * counts as a price:
 * - decimals ("500000.50"), exponents ("1e6") and underscores between
 *   digits ("1_000_000");
 * - digits from any script, such as Arabic-Indic "٥٠٠٠٠٠";
 * - a sign, with the result checked after conversion, so "-0" is $0 and
 *   "-5" isn't a price;
 * - but not hex ("0x10"), which JavaScript's `Number()` would accept.
 *
 * The sliders use this to keep one end of a range from crossing the exact
 * amount at the other end.
 *
 * @param raw - The query value.
 * @returns The amount, or `undefined` for blank, negative or unreadable text.
 */
export function amountOf(raw: string): number | undefined {
  const text = raw.trim().replace(/\p{Nd}/gu, asciiDigit)
  if (!PYTHON_FLOAT.test(text)) return undefined
  const n = Number(text.replace(/_/g, ''))
  if (!Number.isFinite(n) || n < 0) return undefined
  return n === 0 ? 0 : n // turn -0 into 0
}

/**
 * The ASCII digit for a decimal digit from any script.
 *
 * @remarks
 * Unicode keeps each script's digits as ten consecutive code points, 0 to 9
 * (a few blocks hold several such runs back to back). So a digit's value is
 * its distance from the start of its run, modulo 10.
 *
 * @param digit - One character in Unicode category Nd.
 * @returns "0" to "9".
 */
function asciiDigit(digit: string): string {
  const code = digit.codePointAt(0)!
  let start = code
  while (/\p{Nd}/u.test(String.fromCodePoint(start - 1))) start--
  return String((code - start) % 10)
}

/** Digits, optionally with single underscores between them. */
const DIGITS = String.raw`\d(?:_?\d)*`

/** A number as Python's `float()` reads it: sign, digits, fraction, exponent. */
const PYTHON_FLOAT = new RegExp(`^[+-]?(?:${DIGITS}(?:\\.(?:${DIGITS})?)?|\\.${DIGITS})(?:[eE][+-]?${DIGITS})?$`)

/** A price range as query values; `""` means no limit at that end. */
export interface PriceRange {
  min: string
  max: string
}

/**
 * Positions on the two-handle slider.
 *
 * @remarks
 * The ends are kept for "no limit": position 0 is "no minimum", positions 1
 * to `PRICE_STOPS.length` are the price stops ($0 to $50,000,000), and the
 * last position is "no maximum". Giving the unset ends their own positions
 * means a typed amount never sits where "unset" does. A $60,000,000 max sits
 * on the $50,000,000 stop, one step in from "no max", so dragging the handle
 * to the end clears it.
 */
export const NO_MIN = 0
/** See {@link NO_MIN}. */
export const NO_MAX = PRICE_STOPS.length + 1

/**
 * Where a range handle sits for a query value.
 *
 * @param raw - The query value.
 * @param end - Which end this is; blank or unreadable values go to its open end.
 * @returns A position from {@link NO_MIN} to {@link NO_MAX}.
 */
export function rangePosition(raw: string, end: 'min' | 'max'): number {
  if (amountOf(raw) === undefined) return end === 'min' ? NO_MIN : NO_MAX
  return stopFor(raw, 0) + 1
}

/**
 * The price at a range position. The open ends count as the nearest stop.
 *
 * @param position - A range position.
 * @returns A dollar amount from {@link PRICE_STOPS}.
 */
function priceAt(position: number): number {
  return PRICE_STOPS[Math.min(Math.max(position - 1, 0), LAST_STOP)]
}

/**
 * The range after one handle of the two-handle slider moves.
 *
 * @remarks
 * The handle's own end ("no minimum" for the low handle, "no maximum" for
 * the high one) is read from the position the user asked for, before any
 * limit is applied, so a step in from the end never turns into "no limit".
 *
 * How the handles meet depends on how they're moved:
 * - With the keyboard (no `anchor`), a handle stops at the other end's exact
 *   amount. Arrow keys move one handle, and it shouldn't jump past the other.
 * - With a pointer drag, `anchor` is the other end's value when the drag
 *   started, and the dragged handle may pass it; min and max then swap, so
 *   the range stays valid. This keeps two handles that sit on the same spot
 *   draggable in both directions, even though only the top one can be
 *   grabbed.
 *
 * @param handle - Which handle moved.
 * @param position - The range position it moved to.
 * @param range - The range before the move.
 * @param anchor - During a pointer drag, the other end's value at the start.
 * @returns The new range.
 */
export function moveHandle(handle: 'low' | 'high', position: number, range: PriceRange, anchor?: string): PriceRange {
  // The value at this position, as a minimum or as a maximum.
  const price = priceAt(position)
  const asMin = position === NO_MIN ? '' : String(price)
  const asMax = position === NO_MAX ? '' : String(price)

  // Pointer drag: the dragged end may cross the anchor, swapping the ends.
  if (anchor !== undefined) {
    const at = position === NO_MIN ? -Infinity : position === NO_MAX ? Infinity : price
    if (handle === 'low') {
      const limit = amountOf(anchor) ?? Infinity
      return at > limit ? { min: anchor, max: asMax } : { min: asMin, max: anchor }
    }
    const limit = amountOf(anchor) ?? -Infinity
    return at < limit ? { min: asMin, max: anchor } : { min: anchor, max: asMax }
  }

  // Keyboard: stop at the other end's exact amount.
  if (handle === 'low') {
    if (asMin === '') return { min: '', max: range.max }
    const cap = amountOf(range.max)
    return { min: String(cap === undefined ? price : Math.min(price, cap)), max: range.max }
  }
  if (asMax === '') return { min: range.min, max: '' }
  const floor = amountOf(range.min)
  return { min: range.min, max: String(floor === undefined ? price : Math.max(price, floor)) }
}
