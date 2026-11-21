/**
 * Join CSS class names, skipping empty ones.
 *
 * @remarks
 * CSS Modules give each class a scoped name, so a component often combines
 * several: a shared primitive, a local class and a state class. This keeps
 * those lines readable:
 *
 * ```tsx
 * <li className={cx(ui.card, styles.listing, isSelected && styles.selected)} />
 * ```
 *
 * @module
 */

/** Anything `cx` accepts: class names, or falsy values to skip. */
export type ClassValue = string | false | null | undefined

/**
 * @param classes - Class names; `false`, `null`, `undefined` and `''` are dropped.
 * @returns The remaining names joined by spaces.
 *
 * @example
 * ```ts
 * cx('btn', isPrimary && 'btn-primary', undefined) // => "btn btn-primary" or "btn"
 * ```
 */
export function cx(...classes: ClassValue[]): string {
  return classes.filter(Boolean).join(' ')
}
