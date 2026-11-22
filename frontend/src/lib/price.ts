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
 * Accepts decimals ("500000.50") as well as whole numbers, because the API
 * does. The sliders use this to keep one end of a range from crossing the
 * exact amount at the other end.
 *
 * @param raw - The query value.
 * @returns The amount, or `undefined` for blank, negative or unreadable text.
 */
export function amountOf(raw: string): number | undefined {
  if (raw.trim() === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}
