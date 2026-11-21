/**
 * Save the current search under a name and re-run it later.
 *
 * @module
 */

import { useState, type FormEvent } from 'react'
import { fromSearchParams, toSearchParams, type SearchQuery } from '../api'
import { useLocalStorage } from '../hooks/useLocalStorage'
import { describeQuery, isSavedList, MAX_SAVED, SAVED_KEY, type SavedSearch } from '../lib/savedSearches'
import { cx } from '../lib/cx'
import ui from '../styles/ui.module.scss'
import styles from './SavedSearches.module.scss'

/** Props for {@link SavedSearches}. */
interface Props {
  /** The submitted search that "Save" stores. */
  current: SearchQuery
  /** Run a saved search. */
  onApply: (q: SearchQuery) => void
}

/**
 * A compact panel listing saved searches, with a form to save the current one.
 *
 * @remarks
 * Saved searches live in this browser only (`localStorage`). A real product
 * would sync them to the user's account through an API; this component's
 * props wouldn't change, only where the list is read from and written to.
 *
 * @param props - See {@link Props}.
 * @returns The saved-searches panel.
 */
export function SavedSearches({ current, onApply }: Props) {
  const [saved, setSaved] = useLocalStorage<SavedSearch[]>(SAVED_KEY, [], isSavedList)
  const [name, setName] = useState('')

  /** Save the current search (newest first), dropping the oldest past the cap. */
  const save = (e: FormEvent) => {
    e.preventDefault()
    // Page number isn't part of a saved search: re-running starts at page 1.
    const params = toSearchParams({ ...current, page: 1 }).toString()
    const entry: SavedSearch = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: name.trim() || describeQuery(current),
      params,
      createdAt: new Date().toISOString(),
    }
    // Saving the same search again replaces it instead of duplicating it.
    setSaved((prev) => [entry, ...prev.filter((s) => s.params !== params)].slice(0, MAX_SAVED))
    setName('')
  }

  const remove = (id: string) => setSaved((prev) => prev.filter((s) => s.id !== id))

  return (
    <section className={cx(ui.card, styles.saved)} aria-labelledby="saved-heading">
      <h2 id="saved-heading">Saved searches</h2>
      <form className={styles.savedForm} onSubmit={save} aria-label="Save current search">
        <label className={ui.srOnly} htmlFor="saved-name">
          Name for this search
        </label>
        <input
          id="saved-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={describeQuery(current)}
          maxLength={80}
        />
        <button type="submit" className={cx(ui.btn, ui.btnSm)}>
          Save current
        </button>
      </form>

      {saved.length === 0 ? (
        <p className={styles.savedEmpty}>Nothing saved yet. Run a search, then save it here.</p>
      ) : (
        <ul className={styles.savedList}>
          {saved.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className={styles.savedApply}
                onClick={() => onApply(fromSearchParams(new URLSearchParams(s.params)))}
              >
                {s.name}
              </button>
              <button
                type="button"
                className={ui.iconBtn}
                aria-label={`Delete saved search ${s.name}`}
                onClick={() => remove(s.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
