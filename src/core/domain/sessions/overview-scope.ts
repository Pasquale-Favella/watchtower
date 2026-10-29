import { eachDayOfInterval, endOfDay, startOfDay, startOfMonth, subDays, subMonths } from 'date-fns'

import type { OverviewPeriod, OverviewScope } from '../../../shared/schemas/overview.js'
import type { DateRange, SessionSummary } from '../observations/types.js'

// Local calendar dates keep period windows and daily bucketing aligned with the user's calendar.
export function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const ALL_TIME_MONTHS = 6

/** Inclusive lower bound (date key) of the selected period's window. */
export function periodWindowStart(period: OverviewPeriod, now = new Date()): string {
  return localDateKey(periodStartDate(period, now))
}

function periodStartDate(period: OverviewPeriod, now: Date): Date {
  switch (period) {
    case 'today':
      return startOfDay(now)
    case 'week':
      return startOfDay(subDays(now, 7))
    case '30days':
      return startOfDay(subDays(now, 30))
    case 'month':
      return startOfMonth(now)
    case 'all':
      return subMonths(startOfMonth(now), ALL_TIME_MONTHS)
    case 'lifetime':
      return new Date(1970, 0, 1)
  }
}

function parseLocalDateKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day)
}

/** The scope's window as a DateRange on the aggregation seam, inclusive in local time. */
export function overviewDateRange(scope: OverviewScope, now = new Date()): DateRange {
  if (scope.range) {
    return { start: parseLocalDateKey(scope.range.since), end: endOfDay(parseLocalDateKey(scope.range.until)) }
  }
  return { start: periodStartDate(scope.period, now), end: endOfDay(now) }
}

/** Calculations always have a window; lifetime reads must retain the unfiltered SQL path. */
export function overviewQueryRanges(
  scope: OverviewScope,
  now: Date,
): { range: DateRange; readRange: DateRange | undefined } {
  const range = overviewDateRange(scope, now)
  if (scope.period === 'lifetime' && scope.range === undefined) return { range, readRange: undefined }
  return { range, readRange: range }
}

/** Local calendar keys for zero-filled charts, including both endpoints. */
export function localDateKeys(fromKey: string, toKey: string): string[] {
  if (fromKey > toKey) return []
  const start = parseLocalDateKey(fromKey)
  const end = parseLocalDateKey(toKey)
  if (!(start <= end)) return []
  return eachDayOfInterval({ start, end }).map(localDateKey)
}

/** Detector periods end at the captured instant, or the custom range's final local day. */
export function scopeDateRange(scope: OverviewScope, now: Date): DateRange | null {
  if (scope.range) {
    return {
      start: startOfDay(new Date(`${scope.range.since}T00:00:00`)),
      end: endOfDay(new Date(`${scope.range.until}T00:00:00`)),
    }
  }
  return { start: periodStartDate(scope.period, now), end: now }
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
