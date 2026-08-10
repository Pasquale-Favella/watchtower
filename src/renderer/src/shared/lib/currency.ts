/**
 * Renderer-side display currency (ADR 0009). Single source of truth for how
 * every section formats money: AppShell loads the active currency from the
 * main process (which reads only the CACHED rate from the store's FX
 * side-table — the renderer never calls Frankfurter directly) and calls
 * `setActiveCurrency`; every `formatUsd`/`formatConverted` call site then
 * converts for free. Defaults to USD so the first render is correct.
 */

import type { ActiveCurrency } from '../../../../shared/schemas/fx.js'

export type { ActiveCurrency } from '../../../../shared/schemas/fx.js'

let activeCurrency: ActiveCurrency = { code: 'USD', symbol: '$', rate: 1 }

export function setActiveCurrency(currency: ActiveCurrency): void {
  activeCurrency = currency
}

export function getActiveCurrency(): ActiveCurrency {
  return activeCurrency
}

/** Raw-USD input: multiplies by the active FX rate, then prefixes the symbol. */
export function formatUsd(n: number): string {
  return formatConverted(n * activeCurrency.rate)
}

/** Already-converted input: only prefixes the active symbol and formats the
 * magnitude — never re-applies the rate. */
export function formatConverted(n: number): string {
  const finite = Number.isFinite(n) ? n : 0
  return `${activeCurrency.symbol}${finite.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
