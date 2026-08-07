import type { CompareFormatFn } from '../../../../shared/schemas/compare.js'
import { formatCompact, formatUsd } from '@/shared/lib/models'

/** Format a comparison value per the metric's format function (ticket 27),
 * using the `fmtMetric` rules: `—` for null, USD for cost, whole percents,
 * two-decimal ratios, compact tokens, and comma integers for counts. */
export function compareValue(value: number | null, fn: CompareFormatFn): string {
  if (value === null) return '—'
  switch (fn) {
    case 'cost':
      return formatUsd(value)
    case 'percent':
      return `${value.toFixed(0)}%`
    case 'decimal':
      return value.toFixed(2)
    case 'compact':
      return formatCompact(value)
    case 'number':
      return Math.round(value).toLocaleString('en-US')
  }
}
