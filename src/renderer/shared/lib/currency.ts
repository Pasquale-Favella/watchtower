import type { ActiveCurrency } from '../../../shared/schemas/fx.js'

export type { ActiveCurrency } from '../../../shared/schemas/fx.js'

/** Format a raw USD amount using the supplied display-currency snapshot. */
export function formatUsd(n: number, currency: ActiveCurrency): string {
  return formatConverted(n * currency.rate, currency)
}

/** Format an amount already converted to the supplied display currency. */
export function formatConverted(n: number, currency: ActiveCurrency): string {
  const finite = Number.isFinite(n) ? n : 0
  return `${currency.symbol}${finite.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
