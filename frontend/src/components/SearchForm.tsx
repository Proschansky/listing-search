/**
 * The search form.
 *
 * @module
 */

import type { FormEvent } from 'react'
import type { FieldError, SearchQuery, Status } from '../api'
import { cx } from '../lib/cx'
import ui from '../styles/ui.module.scss'
import { PriceInput, PriceRangeSlider, PriceSlider } from './PriceControls'
import styles from './SearchForm.module.scss'

/** Props for {@link SearchForm}. */
interface Props {
  /** Current form contents (App's `draft`). */
  value: SearchQuery
  /** Called with the whole updated query on every edit. */
  onChange: (q: SearchQuery) => void
  /** Called when the user submits the form. */
  onSubmit: () => void
  /** Called when the user clicks Reset. */
  onReset: () => void
  /** Suggestions for the city input. */
  cities: string[]
  /** Validation errors from the last request, shown next to their fields. */
  fieldErrors: FieldError[]
  /** `true` while a request is in flight. Disables the buttons. */
  busy: boolean
  /**
   * Whether "search as you type" is on. When it is, App re-runs the search
   * shortly after the user stops typing (debounced), so pressing Search is
   * optional. Omit both live-search props to hide the toggle.
   */
  liveSearch?: boolean
  /** Turn "search as you type" on or off. */
  onLiveSearchChange?: (on: boolean) => void
}

/** Status checkboxes, in display order. */
const STATUSES: Status[] = ['active', 'pending', 'sold']

/** Fields rendered as plain text inputs by the `field` helper. */
type TextField = 'minBedrooms' | 'city' | 'keyword'

/** Fields that hold a dollar amount, edited with {@link PriceInput}. */
type PriceField = 'minPrice' | 'maxPrice' | 'targetBudget'

/**
 * Inputs for every filter, the target budget, status and page size.
 *
 * `asOf` (the date recency is counted to) has no input here. Shoppers never
 * need it; tests and demos set it in the URL (`?asOf=2026-09-05`), and App
 * keeps passing it to the API.
 *
 * @remarks
 * A *controlled* component: it holds no state of its own. It renders whatever
 * `value` it's given and reports every edit through `onChange`. App owns the
 * state, which keeps a single source of truth.
 *
 * The browser's built-in validation is turned off (`noValidate`). The API is
 * the single source of truth for validation and returns field-level messages,
 * which native browser checks would hide. Native `step` rules would also block
 * valid prices such as $399,500.
 *
 * @param props - See {@link Props}.
 * @returns The rendered form.
 */
export function SearchForm({
  value,
  onChange,
  onSubmit,
  onReset,
  cities,
  fieldErrors,
  busy,
  liveSearch,
  onLiveSearchChange,
}: Props) {
  /**
   * Look up the API's error message for a field.
   *
   * @param field - Parameter name, for example `"minPrice"`.
   * @returns The message, or `undefined` if the field is valid.
   */
  const errorFor = (field: string) => fieldErrors.find((e) => e.field === field)?.message

  /**
   * Make a change handler for one field.
   *
   * @remarks
   * Copies the current query and replaces just that field, never mutating
   * state in place.
   *
   * @param field - The field this handler updates.
   * @returns An `onChange` handler for an input or select.
   */
  const set = (field: TextField | 'pageSize') => (e: { target: { value: string } }) =>
    onChange({ ...value, [field]: e.target.value })

  /**
   * Tick or untick one status checkbox.
   *
   * @remarks
   * The last remaining status can't be unticked: an empty set would match
   * nothing.
   *
   * @param status - The status that was clicked.
   */
  const toggleStatus = (status: Status) => {
    const has = value.statuses.includes(status)
    if (has && value.statuses.length === 1) return
    onChange({
      ...value,
      statuses: has ? value.statuses.filter((s) => s !== status) : [...value.statuses, status],
    })
  }

  /**
   * Handle form submission.
   *
   * @param e - The submit event. Its default full-page submission is
   *   cancelled, because searching happens via fetch.
   */
  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    onSubmit()
  }

  /**
   * Render one labelled input together with its error message, if any.
   *
   * @remarks
   * Sets `aria-invalid` and `aria-describedby`, so screen readers announce the
   * error along with the field, as well as showing the red border.
   *
   * @param name - Which query field the input edits.
   * @param label - Visible label text.
   * @param props - Extra attributes passed to the `<input>`, such as `type`.
   * @returns The label, input and optional error message.
   */
  const field = (name: TextField, label: string, props: Record<string, unknown> = {}) => {
    const error = errorFor(name)
    return (
      <label className={cx(styles.field, error && styles.invalid)}>
        <span>{label}</span>
        <input
          name={name}
          value={value[name]}
          onChange={set(name)}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${name}-error` : undefined}
          {...props}
        />
        {error && (
          <small id={`${name}-error`} className={styles.fieldError}>
            {error}
          </small>
        )}
      </label>
    )
  }

  /**
   * Render a labelled dollar-amount box with its error message, if any.
   *
   * @remarks
   * Same wiring as {@link field}, with {@link PriceInput} in place of a plain
   * input so the amount shows commas.
   *
   * @param name - Which query field the box edits.
   * @param label - Visible label text.
   * @param placeholder - Hint shown when the box is empty.
   * @returns The label, input and optional error message.
   */
  const priceField = (name: PriceField, label: string, placeholder?: string) => {
    const error = errorFor(name)
    return (
      <label className={cx(styles.field, error && styles.invalid)}>
        <span>{label}</span>
        <PriceInput
          name={name}
          value={value[name]}
          onChange={(v) => onChange({ ...value, [name]: v })}
          placeholder={placeholder}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${name}-error` : undefined}
        />
        {error && (
          <small id={`${name}-error`} className={styles.fieldError}>
            {error}
          </small>
        )}
      </label>
    )
  }
  return (
    <form className={cx(ui.card, styles.form)} onSubmit={handleSubmit} aria-label="Search listings" noValidate>
      {/* Main filters. Prices first, since they matter most to most buyers.
          Every value is sent as a string and validated by the API. */}
      <div className={styles.grid}>
        {/* Price range: two boxes for exact amounts and one two-handle
            slider under them for rough ones. */}
        <div className={styles.priceGroup}>
          {priceField('minPrice', 'Min price ($)', 'No min')}
          {priceField('maxPrice', 'Max price ($)', 'No max')}
          <div className={styles.slider}>
            <PriceRangeSlider
              min={value.minPrice}
              max={value.maxPrice}
              onChange={({ min, max }) => onChange({ ...value, minPrice: min, maxPrice: max })}
            />
          </div>
        </div>
        <div className={styles.priceField}>
          {priceField('targetBudget', 'Target budget ($)', 'Ranks by fit')}
          <PriceSlider
            label="Budget"
            blankText="No target"
            value={value.targetBudget}
            onChange={(v) => onChange({ ...value, targetBudget: v })}
          />
        </div>
        {field('minBedrooms', 'Min bedrooms', { type: 'number', min: 0, step: 1 })}
        {/* list="city-options" connects this input to the <datalist> below,
            giving type-ahead suggestions while still allowing any text. */}
        {field('city', 'City', { list: 'city-options', placeholder: 'Any city' })}
        {/* Keywords get the full width, like a search bar. */}
        <div className={styles.wide}>
          {field('keyword', 'Keywords', { placeholder: 'e.g. pool, garage, near Metro' })}
        </div>
      </div>
      <datalist id="city-options">
        {cities.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </datalist>

      {/* Less common settings, collapsed by default to keep the form simple. */}
      <details className={styles.advanced}>
        <summary>Advanced</summary>
        <div className={styles.grid}>
          <label className={cx(styles.field, errorFor('pageSize') && styles.invalid)}>
            <span>Results per page</span>
            {/* A fixed set of sizes. The API still validates pageSize, since
                a hand-edited URL could send anything. */}
            <select name="pageSize" value={value.pageSize} onChange={set('pageSize')}>
              {['5', '10', '20', '50'].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
            {errorFor('pageSize') && <small className={styles.fieldError}>{errorFor('pageSize')}</small>}
          </label>
        </div>
      </details>

      <div className={styles.formFooter}>
        <div className={styles.formFooterLeft}>
          {/* Status toggles (active / pending / sold): real checkboxes, styled
            as pills. The checkbox stays focusable and screen-reader visible. */}
          <fieldset className={cx(styles.statuses, errorFor('status') && styles.invalid)}>
            <legend>Status</legend>
            {STATUSES.map((s) => (
              <label key={s} className={styles.chipToggle}>
                <input type="checkbox" checked={value.statuses.includes(s)} onChange={() => toggleStatus(s)} />
                <span>{s}</span>
              </label>
            ))}
          </fieldset>

          {/* "Search as you type": a switch-styled checkbox. */}
          {onLiveSearchChange && (
            <label className={styles.switch}>
              <input
                type="checkbox"
                checked={Boolean(liveSearch)}
                onChange={(e) => onLiveSearchChange(e.target.checked)}
              />
              <span>Search as you type</span>
            </label>
          )}
        </div>

        {/* Buttons are disabled while a request is running to prevent double-submits. */}
        <div className={styles.actions}>
          <button type="button" className={ui.btn} onClick={onReset} disabled={busy}>
            Reset
          </button>
          <button type="submit" className={cx(ui.btn, ui.btnPrimary)} disabled={busy}>
            Search
          </button>
        </div>
      </div>
    </form>
  )
}
