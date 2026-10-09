import type { OverviewPeriod, OverviewScope } from '../shared/schemas/overview.js'
import type { DateRange, SessionSummary } from './pipeline/types.js'

// Local calendar dates keep period windows and daily bucketing aligned with the user's calendar.
export function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const ALL_TIME_MONTHS = 6

/** Inclusive lower bound (date key) of the selected period's window. */
export function periodWindowStart(period: OverviewPeriod, now = new Date()): string {
  switch (period) {
    case 'today':
      return localDateKey(now)
    case 'week':
      return localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7))
    case '30days':
      return localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30))
    case 'month':
      return localDateKey(new Date(now.getFullYear(), now.getMonth(), 1))
    case 'all':
      return localDateKey(new Date(now.getFullYear(), now.getMonth() - ALL_TIME_MONTHS, 1))
    case 'lifetime':
      return localDateKey(new Date(1970, 0, 1))
  }
}

/** The scope's window as a DateRange on the aggregation seam, inclusive in local time. */
export function overviewDateRange(scope: OverviewScope, now = new Date()): DateRange {
  const parseDay = (key: string): Date => {
    const [y, m, d] = key.split('-').map(Number)
    return new Date(y, m - 1, d)
  }
  if (scope.range) {
    const end = parseDay(scope.range.until)
    end.setHours(23, 59, 59, 999)
    return { start: parseDay(scope.range.since), end }
  }
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
  return { start: parseDay(periodWindowStart(scope.period, now)), end }
}

/** Detector periods end at the captured instant, or the custom range's final local day. */
export function scopeDateRange(scope: OverviewScope, now: Date): DateRange | null {
  if (scope.range) {
    return {
      start: new Date(`${scope.range.since}T00:00:00`),
      end: new Date(`${scope.range.until}T23:59:59.999`),
    }
  }
  return { start: new Date(`${periodWindowStart(scope.period, now)}T00:00:00`), end: now }
}

export function sessionFirstDateKey(sess: SessionSummary): string {
  const ms = Date.parse(sess.firstTimestamp)
  return Number.isNaN(ms) ? '' : localDateKey(new Date(ms))
}

/** A session is in scope when its first local date is in range and it used the optional provider. */
export function inScope(sess: SessionSummary, scope: OverviewScope, now: Date, provider: string | undefined): boolean {
  if (provider) {
    const matched = sess.turns.some(t => t.assistantCalls.some(c => c.provider === provider))
    if (!matched) return false
  }
  const first = sessionFirstDateKey(sess)
  if (!first) return false
  if (scope.range) return first >= scope.range.since && first <= scope.range.until
  const start = periodWindowStart(scope.period, now)
  const today = localDateKey(now)
  return first >= start && first <= today
}

/** Earliest recorded local day across the session set, or null when empty. */
export function dataStartForSessions(sessions: SessionSummary[]): string | null {
  let earliest: string | null = null
  for (const sess of sessions) {
    const key = sessionFirstDateKey(sess)
    if (key && (earliest === null || key < earliest)) earliest = key
  }
  return earliest
}
