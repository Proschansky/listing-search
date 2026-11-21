/**
 * The coloured "● Active / Pending / Sold" pill.
 *
 * @module
 */

import type { Status } from '../api'
import { cx } from '../lib/cx'
import ui from '../styles/ui.module.scss'

/**
 * One colour class per status.
 *
 * @remarks
 * Written out (rather than built as `ui['badge-' + status]`) so a status
 * without a matching style is a type error, not a silently unstyled badge.
 */
const STATUS_CLASS: Record<Status, string> = {
  active: ui.badgeActive,
  pending: ui.badgePending,
  sold: ui.badgeSold,
}

/**
 * A listing's market status as a coloured pill.
 *
 * @param props.status - The listing's status.
 * @returns The badge.
 */
export function StatusBadge({ status }: { status: Status }) {
  return <span className={cx(ui.badge, STATUS_CLASS[status])}>{status}</span>
}
