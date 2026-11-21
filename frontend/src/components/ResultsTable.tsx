/**
 * Ranked listing cards for the current page.
 *
 * @module
 */

import type { ListingResult } from '../api'
import { cx } from '../lib/cx'
import { formatDate, usd } from '../lib/format'
import ui from '../styles/ui.module.scss'
import styles from './ResultsTable.module.scss'
import { StatusBadge } from './StatusBadge'

/**
 * Build the hover text for a result's score cell.
 *
 * @param r - The result whose score to explain.
 * @returns A one-line explanation, e.g.
 *   `"Budget fit 1.00 · Recency 0.10 (98 days on market)"`.
 */
function scoreTitle(r: ListingResult): string {
  const { budget, recency, daysOnMarket } = r.scoreBreakdown
  const parts = [
    // budget is null when the search had no target budget.
    budget === null ? 'No target budget: ranked by recency only' : `Budget fit ${budget.toFixed(2)}`,
    `Recency ${recency.toFixed(2)} (${daysOnMarket} days on market)`,
  ]
  return parts.join(' · ')
}

/** Props for {@link ResultsTable}. */
interface Props {
  /** The listings on this page, already ranked by the API. */
  results: ListingResult[]
  /**
   * How many results came before this page, so the rank keeps counting
   * across pages (11, 12, … on page 2).
   */
  rankOffset: number
  /** Open the detail drawer for a listing. */
  onSelect?: (listing: ListingResult) => void
  /** Key of the listing whose drawer is open, highlighted in the list. */
  selectedKey?: string | null
}

/**
 * Render one page of results as a ranked list of listing cards.
 *
 * @remarks
 * Purely presentational: it receives data as props, formats it, and renders
 * it. No state, no fetching.
 *
 * Clicking a card's address (or anywhere on the card) calls `onSelect`,
 * which opens the detail drawer.
 *
 * Cards are keyed by `listingKey`, which is unique and stable, so React tracks
 * them correctly between renders. Using the array index would break when the
 * order changes.
 *
 * @param props - See {@link Props}.
 * @returns The rendered list.
 */
export function ResultsTable({ results, rankOffset, onSelect, selectedKey }: Props) {
  return (
    <ol className={styles.listings} aria-label="Search results">
      {results.map((r, i) => (
        <li
          key={r.listingKey}
          className={cx(ui.card, styles.listing, r.listingKey === selectedKey && styles.selected)}
          style={{ animationDelay: `${i * 30}ms` }}
        >
          <div className={styles.rank} aria-label={`Rank ${rankOffset + i + 1}`}>
            {rankOffset + i + 1}
          </div>

          {/* Address, location, specs, description and source feeds. */}
          <div className={styles.listingMain}>
            <div className={styles.listingTitle}>
              {/* The address is the card's one real control: a button that opens
                  the detail drawer. A stretched ::after (see CSS) makes the whole
                  card clickable without nesting interactive elements. */}
              <h3 className={styles.address}>
                {onSelect ? (
                  <button type="button" className={styles.cardLink} onClick={() => onSelect(r)} aria-haspopup="dialog">
                    {r.address}
                  </button>
                ) : (
                  r.address
                )}
              </h3>
              <StatusBadge status={r.status} />
            </div>
            <div className={ui.location}>
              {r.city}, {r.state} {r.zip}
            </div>
            <ul className={styles.specs}>
              <li>
                <b>{r.bedrooms}</b> bd
              </li>
              <li>
                <b>{r.bathrooms}</b> ba
              </li>
              <li>
                <b>{r.sqft.toLocaleString()}</b> sq ft
              </li>
            </ul>
            <p className={styles.description}>{r.description}</p>

            {/* Every feed this home appeared in. Hovering shows that feed's own
                address spelling, price and date, which can differ between feeds. */}
            <div className={styles.sources}>
              {r.sources.map((s) => (
                <span
                  key={s.source + s.id}
                  className={styles.source}
                  title={`${s.address} · ${usd.format(s.price)} · listed ${s.listedDate}`}
                >
                  {s.source} <code>{s.id}</code>
                </span>
              ))}
            </div>
          </div>

          {/* Price, listing date and the explainable relevance score. */}
          <div className={styles.listingSide}>
            <div className={ui.price}>{usd.format(r.price)}</div>
            <div className={styles.listed}>Listed {formatDate(r.listedDate)}</div>
            <div className={styles.score} title={scoreTitle(r)}>
              <div className={styles.scoreTop}>
                Score <strong>{r.relevanceScore.toFixed(3)}</strong>
              </div>
              <div className={styles.meter} aria-hidden="true">
                <i style={{ width: `${Math.max(0, Math.min(1, r.relevanceScore)) * 100}%` }} />
              </div>
              <small>
                {r.scoreBreakdown.budget !== null && <>budget {r.scoreBreakdown.budget.toFixed(2)} · </>}
                recency {r.scoreBreakdown.recency.toFixed(2)}
              </small>
            </div>
          </div>
        </li>
      ))}
    </ol>
  )
}
