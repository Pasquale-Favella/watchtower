import { formatConverted } from '@/shared/lib/models'

import type { OverviewPayload } from '../../../../shared/schemas/overview.js'

/** Overview helpers shared by its components and the background orb. */

/** Short day label for a `YYYY-MM-DD` key ("Jul 3") — chart axes/tooltips. */
export function formatChartDate(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Date(year, (month ?? 1) - 1, day ?? 1).toLocaleString('en-US', { month: 'short', day: 'numeric' })
}

/** Chart money label: the converted amount without its cents. */
export function formatChartValue(n: number): string {
  return formatConverted(n).replace(/\.\d+$/, '')
}

/** Week-over-week spend delta from the daily series (last 7 vs prior 7).
 * Null when there isn't enough history — callers then hide the badge
 * instead of inventing a trend. */
export function spendTrend(daily: OverviewPayload['daily']): number | null {
  if (daily.length < 14) return null
  const last = daily.slice(-7).reduce((s, d) => s + d.costUSD, 0)
  const prev = daily.slice(-14, -7).reduce((s, d) => s + d.costUSD, 0)
  if (prev <= 0) return last > 0 ? 1 : null
  return (last - prev) / prev
}
