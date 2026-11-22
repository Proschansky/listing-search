/**
 * Top-level component.
 *
 * @remarks
 * Owns the search state, talks to the API, and decides what to show:
 * skeleton, loading, error (with retry), no results, an empty page, or
 * results as a list or a map, plus the detail drawer and saved searches.
 *
 * Data flow:
 *
 * ```text
 *   URL ──(on load)──► query ──► search effect ──► Outcome ──► render
 *    ▲                   ▲  ▲
 *    └──(kept in sync)───┘  └── draft (form) ── Search button / debounced live search
 *
 *   loading = (last outcome's request key ≠ the key of the request wanted now)
 * ```
 *
 * @module
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ApiError,
  EMPTY_QUERY,
  fetchMeta,
  fromSearchParams,
  searchListings,
  toSearchParams,
  type FieldError,
  type ListingResult,
  type SearchQuery,
  type SearchResponse,
  type SortOption,
} from './api'
import { ListingDrawer } from './components/ListingDrawer'
import { MapView } from './components/MapView'
import { PaginationControls } from './components/PaginationControls'
import { ResultsSkeleton } from './components/ResultsSkeleton'
import { ResultsTable } from './components/ResultsTable'
import { SavedSearches } from './components/SavedSearches'
import { SearchForm } from './components/SearchForm'
import { SegmentedControl } from './components/SegmentedControl'
import { SortControl } from './components/SortControl'
import { useDebouncedCallback } from './hooks/useDebouncedCallback'
import { useLocalStorage } from './hooks/useLocalStorage'
import { useTheme, type ThemePreference } from './hooks/useTheme'
import styles from './App.module.scss'
import { cx } from './lib/cx'
import ui from './styles/ui.module.scss'

/**
 * The outcome of the most recent *finished* search, tagged with the request
 * it answers.
 *
 * @remarks
 * A union type makes impossible combinations (such as "succeeded and errored
 * at once") unrepresentable, and TypeScript forces each case to be handled.
 *
 * Loading isn't stored at all: the page is loading whenever the last outcome
 * belongs to a different request than the one currently wanted
 * (`outcome.key !== requestKey`). Deriving it this way means there's no
 * "set loading" step that could be forgotten or race with a response, and
 * the previous results stay on screen (dimmed) until new ones land.
 */
type Outcome =
  | { key: string; kind: 'success'; data: SearchResponse }
  | { key: string; kind: 'error'; message: string; fieldErrors: FieldError[]; retryable: boolean; requestId?: string }

/** How results are displayed. */
type ResultsView = 'list' | 'map'

/** URL parameter holding the open listing's key, so a drawer can be shared as a link. */
const LISTING_PARAM = 'listing'

/** Quiet period before a live search fires, in milliseconds. */
export const LIVE_SEARCH_DELAY_MS = 400

const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const isView = (v: unknown): v is ResultsView => v === 'list' || v === 'map'

/**
 * Restore a search from the page URL, so refreshing or sharing a link works.
 *
 * @returns The search encoded in `window.location.search`, or the defaults.
 */
function initialQuery(): SearchQuery {
  return fromSearchParams(new URLSearchParams(window.location.search))
}

/** @returns The listing key in the URL, if a drawer link was opened. */
function initialListingKey(): string | null {
  return new URLSearchParams(window.location.search).get(LISTING_PARAM)
}

/**
 * Two searches are "the same" if they'd send the same request. Comparing
 * query strings ignores differences that don't matter, like `" 5 "` vs `"5"`.
 */
const sameSearch = (a: SearchQuery, b: SearchQuery) => toSearchParams(a).toString() === toSearchParams(b).toString()

/**
 * The whole search page.
 *
 * @remarks
 * Keeps two copies of the search. `draft` is what's in the form and `query` is
 * what was last submitted. Editing the form doesn't send requests unless
 * "search as you type" is on; otherwise only submitting, sorting or paging does.
 *
 * @returns The rendered page.
 */
export default function App() {
  // Form contents vs. last submitted search (see @remarks above). Passing the
  // function itself to useState means it runs only once, on first render.
  const [query, setQuery] = useState<SearchQuery>(initialQuery)
  const [draft, setDraft] = useState<SearchQuery>(query)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [cities, setCities] = useState<string[]>([])
  // Bumping this re-runs the current search (the "Try again" button).
  const [attempt, setAttempt] = useState(0)
  // The listing whose drawer is open, if any.
  const [selectedKey, setSelectedKey] = useState<string | null>(initialListingKey)

  // Per-browser preferences, remembered across visits.
  const [liveSearch, setLiveSearch] = useLocalStorage('listing-search:live:v1', false, isBool)
  const [view, setView] = useLocalStorage<ResultsView>('listing-search:view:v1', 'list', isView)
  const [theme, setTheme] = useTheme()

  // Effect 1, on first render only: load the city list for the form's
  // suggestions. Failure is ignored on purpose: the suggestions are a
  // convenience, and the city field still works as free text without them.
  useEffect(() => {
    const controller = new AbortController()
    fetchMeta(controller.signal)
      .then((meta) => setCities(meta.cities))
      .catch(() => {
        /* city suggestions are optional; search still works without them */
      })
    // Cleanup: cancel the request if the component unmounts first.
    return () => controller.abort()
  }, [])

  // Effect 2: keep the URL in sync with the submitted search and the open
  // drawer, so any view can be refreshed or shared. replaceState (not
  // pushState) avoids filling browser history with every page click.
  useEffect(() => {
    const params = toSearchParams(query)
    if (selectedKey) params.set(LISTING_PARAM, selectedKey)
    const qs = params.toString()
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname)
  }, [query, selectedKey])

  // Identifies the request the page currently wants. "Try again" bumps
  // `attempt`, which makes a new key for the same query.
  const requestKey = `${toSearchParams(query)}#${attempt}`

  // Effect 3, whenever the wanted request changes: run the search.
  useEffect(() => {
    // Step 1: abort the in-flight request if the query changes again, so a
    // slow earlier response can never overwrite a newer one. Aborting also
    // cancels any retry the API client is waiting to make.
    const controller = new AbortController()

    // Step 2: fetch, then record the outcome against this request's key.
    // (No "loading" step: see the Outcome type.)
    searchListings(query, controller.signal)
      .then((data) => setOutcome({ key: requestKey, kind: 'success', data }))
      .catch((err: unknown) => {
        // Aborted because a newer search started. Not a real error, so ignore it.
        if ((err as Error).name === 'AbortError') return
        if (err instanceof ApiError) {
          // A 400 is the user's input (fix the fields, don't retry). Anything
          // else (network, 5xx, rate limit) is worth a "Try again" button.
          setOutcome({
            key: requestKey,
            kind: 'error',
            message: err.message,
            fieldErrors: err.details,
            retryable: err.status !== 400,
            requestId: err.status >= 500 ? err.requestId : undefined,
          })
        } else {
          // Anything unexpected still gets a visible message, never a blank page.
          setOutcome({
            key: requestKey,
            kind: 'error',
            message: 'Something went wrong.',
            fieldErrors: [],
            retryable: true,
          })
        }
      })

    // Cleanup runs before the next search (or on unmount) and cancels this one.
    return () => controller.abort()
    // requestKey covers query and attempt; listing query too keeps the
    // dependency list honest for the linter and for readers.
  }, [query, requestKey])

  /**
   * Make `next` the submitted search, unless it would send the same request
   * as the current one (ignoring the page). Starts from page 1, because the
   * old page number may not exist in the new result set.
   */
  const runSearch = useCallback(
    (next: SearchQuery) =>
      setQuery((current) => (sameSearch({ ...next, page: current.page }, current) ? current : { ...next, page: 1 })),
    [],
  )

  // "Search as you type": fires once typing pauses, not on every key press.
  const [liveRun, cancelLiveRun] = useDebouncedCallback(runSearch, LIVE_SEARCH_DELAY_MS)

  /** Every form edit: update the draft, and schedule a live search if it's on. */
  const editDraft = (next: SearchQuery) => {
    setDraft(next)
    if (liveSearch) liveRun(next)
  }

  /** Turning live search on searches the form as it stands right away. */
  const toggleLiveSearch = (on: boolean) => {
    setLiveSearch(on)
    if (on) runSearch(draft)
    else cancelLiveRun()
  }

  /** Submit the form. Always starts from page 1, even for the same filters. */
  const submit = () => {
    cancelLiveRun() // a pending live search would just repeat this one
    setQuery({ ...draft, page: 1 })
  }

  /** Clear the form and re-run the default (unfiltered) search. */
  const reset = () => {
    cancelLiveRun()
    setDraft(EMPTY_QUERY)
    setQuery(EMPTY_QUERY)
  }

  /**
   * Move to another page of the submitted search.
   *
   * @remarks
   * Only the page number of the *submitted* query changes, so unsaved edits
   * sitting in the form don't sneak into the request.
   *
   * @param page - The page to show, starting at 1.
   */
  const goToPage = (page: number) => setQuery((q) => ({ ...q, page }))

  /** Change the order. Applies immediately, from page 1, and keeps the form in step. */
  const changeSort = (sort: SortOption) => {
    setDraft((d) => ({ ...d, sort }))
    setQuery((q) => ({ ...q, sort, page: 1 }))
  }

  /** Run a saved search: fill the form with it and submit. */
  const applySaved = (q: SearchQuery) => {
    setDraft(q)
    setQuery({ ...q, page: 1 })
  }

  const openListing = useCallback((l: ListingResult) => setSelectedKey(l.listingKey), [])
  const closeListing = useCallback(() => setSelectedKey(null), [])

  // Loading = the last outcome answers an older request (or there's none yet).
  const loading = outcome?.key !== requestKey
  // Results to display: the last successful results, fresh or (while
  // loading) dimmed. An error is shown only once it's for the current request.
  const data = outcome?.kind === 'success' ? outcome.data : null
  const error = !loading && outcome?.kind === 'error' ? outcome : null
  // Field errors are passed to the form so it can mark the bad inputs.
  const fieldErrors = error?.fieldErrors ?? []
  const total = data?.pagination.totalResults
  // The listing behind an open drawer, if it's on the current page.
  const selectedListing = useMemo(() => data?.results.find((r) => r.listingKey === selectedKey), [data, selectedKey])

  return (
    <>
      <header className={styles.topbar}>
        <div className={styles.topbarInner}>
          <div className={styles.logo} aria-hidden="true">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 10.5 12 3l9 7.5" />
              <path d="M5 9.5V21h14V9.5" />
            </svg>
          </div>
          <div className={styles.brand}>
            <h1>Listing Search</h1>
            <p>Deduplicated MLS listings, ranked by budget fit and recency</p>
          </div>
          <SegmentedControl<ThemePreference>
            label="Colour theme"
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'system', label: 'Auto' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </div>
      </header>

      <main className={styles.main}>
        <div className={styles.layout}>
          <div>
            <SearchForm
              value={draft}
              onChange={editDraft}
              onSubmit={submit}
              onReset={reset}
              cities={cities}
              fieldErrors={fieldErrors}
              busy={loading}
              liveSearch={liveSearch}
              onLiveSearchChange={toggleLiveSearch}
            />

            {/* aria-live tells screen readers to announce changes in this area,
                such as "Loading…" or a new error. aria-busy asks them to wait
                until loading finishes (and lets tests wait for the same). */}
            <section aria-live="polite" aria-busy={loading} aria-label="Results">
              <div className={styles.resultsHead}>
                <h2>
                  Results
                  {total !== undefined && (
                    <>
                      {' '}
                      <span className={ui.count}>· {total.toLocaleString()} found</span>
                    </>
                  )}
                </h2>
                <div className={styles.resultsTools}>
                  {/* Loading state. */}
                  {loading && (
                    <p className={styles.status}>
                      <span className={styles.spinner} aria-hidden="true" />
                      Loading…
                    </p>
                  )}
                  <SortControl value={query.sort} onChange={changeSort} />
                  <SegmentedControl<ResultsView>
                    label="Results view"
                    value={view}
                    onChange={setView}
                    options={[
                      { value: 'list', label: 'List' },
                      { value: 'map', label: 'Map' },
                    ]}
                  />
                </div>
              </div>

              {/* First load: skeleton cards instead of an empty page. */}
              {loading && !data && <ResultsSkeleton />}

              {/* Error state: the summary message, each field problem, and a
                  retry button when retrying could help. */}
              {error && (
                <div role="alert" className={cx(ui.alert, ui.error)}>
                  <strong>{error.message}</strong>
                  {error.fieldErrors.length > 0 && (
                    <ul>
                      {error.fieldErrors.map((e) => (
                        <li key={e.field + e.message}>
                          <code>{e.field}</code>: {e.message}
                        </li>
                      ))}
                    </ul>
                  )}
                  {error.requestId && (
                    <p className={styles.requestId}>
                      Reference: <code>{error.requestId}</code>
                    </p>
                  )}
                  {error.retryable && (
                    <button type="button" className={cx(ui.btn, ui.btnSm)} onClick={() => setAttempt((n) => n + 1)}>
                      Try again
                    </button>
                  )}
                </div>
              )}

              {/* Results area: shown on success, and dimmed ("stale") while loading. */}
              {data && (
                <div className={loading ? styles.stale : undefined}>
                  {/* Warnings from the API, such as an unknown city or a page past the end. */}
                  {data.warnings.map((w) => (
                    <p key={w} className={cx(ui.alert, ui.warning)}>
                      {w}
                    </p>
                  ))}

                  {/* Three different cases:
                      1. nothing matched at all          -> "no listings" message
                      2. matches exist, but not this page -> offer a jump to the last page
                      3. normal                          -> list or map, plus paging controls */}
                  {data.pagination.totalResults === 0 ? (
                    <div className={cx(ui.card, ui.empty)}>
                      <span className={styles.emptyIcon} aria-hidden="true">
                        ⌕
                      </span>
                      <p>No listings match these filters. Try widening the price range or removing a keyword.</p>
                    </div>
                  ) : data.results.length === 0 ? (
                    <div className={cx(ui.card, ui.empty)}>
                      <p>This page is empty.</p>
                      <button type="button" className={ui.btn} onClick={() => goToPage(data.pagination.totalPages)}>
                        Go to last page ({data.pagination.totalPages})
                      </button>
                    </div>
                  ) : (
                    <>
                      {view === 'map' ? (
                        <MapView results={data.results} onSelect={openListing} />
                      ) : (
                        /* rankOffset makes the rank continue across pages (11, 12, … on page 2). */
                        <ResultsTable
                          results={data.results}
                          rankOffset={(data.pagination.page - 1) * data.pagination.pageSize}
                          onSelect={openListing}
                          selectedKey={selectedKey}
                        />
                      )}
                      <PaginationControls pagination={data.pagination} onPageChange={goToPage} disabled={loading} />
                    </>
                  )}
                </div>
              )}
            </section>
          </div>

          <aside className={styles.layoutSide} aria-label="Sidebar">
            <SavedSearches current={query} onApply={applySaved} />
          </aside>
        </div>
      </main>

      {selectedKey && (
        <ListingDrawer
          key={selectedKey}
          listingKey={selectedKey}
          initial={selectedListing}
          context={{ targetBudget: query.targetBudget, asOf: query.asOf }}
          onClose={closeListing}
        />
      )}
    </>
  )
}
