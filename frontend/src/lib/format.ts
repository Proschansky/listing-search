/**
 * Display formatting shared by every component that shows a listing.
 *
 * @remarks
 * Kept in one module so the list, the map tooltips and the detail drawer can
 * never disagree on how a price or date looks.
 *
 * @module
 */

/**
 * Shared currency formatter: `450000` becomes `"$450,000"`.
 *
 * @remarks
 * Created once at module level because constructing an `Intl` formatter is
 * relatively expensive.
 */
export const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

/**
 * Format an ISO `YYYY-MM-DD` date as, for example, `"Mar 4, 2026"`.
 *
 * @remarks
 * Parsed as UTC and formatted in UTC, so the day never shifts with the
 * viewer's time zone (a plain `new Date("2026-03-04")` shown in New York
 * would read March 3).
 *
 * @param iso - The date string from the API.
 * @returns A short human-readable date, or the input unchanged if unparseable.
 */
export function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}
