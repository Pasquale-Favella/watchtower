import type { PullRequestRow } from '../../../../shared/schemas/pull-requests.js'

/** "Jul 10" — short month + day, no year. Invalid/empty input renders as an em dash. */
export function formatDayShort(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** A PR's active window: one day collapses to a single label, otherwise the two
 * endpoints joined with a hyphen (never an en/em dash, per repo copy rules). */
export function spanLabel(firstStarted: string, lastEnded: string): string {
  const start = formatDayShort(firstStarted)
  const end = formatDayShort(lastEnded)
  if (start === '—' && end === '—') return '—'
  return start === end ? start : `${start} - ${end}`
}

export function sessionWord(n: number): string {
  return n === 1 ? 'session' : 'sessions'
}

/** The section summary's numbers for the current payload: attributed spend
 * reconciled to the visible rows (exactly the sum of the cards a person can
 * inspect below, rounded the same way) and the PR count. */
export function summarizePullRequests(rows: PullRequestRow[]): { attributedCost: number; count: number } {
  return {
    attributedCost: rows.reduce((sum, row) => sum + Number(row.cost.toFixed(2)), 0),
    count: rows.length,
  }
}
