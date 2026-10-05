import type { ActiveCurrency, CurrencyOption } from '../shared/schemas/fx.js'
import type { CurrencyRate } from '../shared/schemas/ledger.js'

export const USD_CURRENCY: Readonly<ActiveCurrency> = { code: 'USD', symbol: '$', rate: 1 }

const SYMBOL_OVERRIDES: Record<string, string> = { CNY: '¥', RON: 'lei' }

const SUPPORTED_CURRENCY_CODES: ReadonlySet<string> = (() => {
  try {
    return new Set(Intl.supportedValuesOf('currency'))
  } catch {
    return new Set()
  }
})()

export function isValidCurrencyCode(code: string): boolean {
  if (typeof code !== 'string' || !/^[A-Z]{3}$/.test(code)) return false
  if (SUPPORTED_CURRENCY_CODES.size > 0) return SUPPORTED_CURRENCY_CODES.has(code)
  try {
    new Intl.NumberFormat('en', { style: 'currency', currency: code })
    return true
  } catch {
    return false
  }
}

export function resolveSymbol(code: string): string {
  if (SYMBOL_OVERRIDES[code]) return SYMBOL_OVERRIDES[code]
  const parts = new Intl.NumberFormat('en', {
    style: 'currency',
    currency: code,
    currencyDisplay: 'symbol',
  }).formatToParts(0)
  return parts.find(p => p.type === 'currency')?.value ?? code
}

export function getFractionDigits(code: string): number {
  return (
    new Intl.NumberFormat('en', {
      style: 'currency',
      currency: code,
    }).resolvedOptions().maximumFractionDigits ?? 2
  )
}

export function listCurrencies(): CurrencyOption[] {
  const codes = SUPPORTED_CURRENCY_CODES.size > 0 ? [...SUPPORTED_CURRENCY_CODES] : Intl.supportedValuesOf('currency')
  return codes
    .filter(isValidCurrencyCode)
    .map(code => ({ code, symbol: resolveSymbol(code) }))
    .sort((a, b) => a.code.localeCompare(b.code))
}

/** Cached rates remain usable when stale; a missing rate uses the existing rate-one fallback. */
export function activeFromCachedRate(code: string, cached: CurrencyRate | null | undefined): ActiveCurrency {
  return {
    code,
    symbol: cached?.symbol ?? resolveSymbol(code),
    rate: cached?.rate ?? 1,
    updatedAt: cached?.updatedAt,
  }
}

export function convertCost(costUSD: number, currency: ActiveCurrency): number {
  return costUSD * currency.rate
}

export function roundForActiveCurrency(value: number, currency: ActiveCurrency): number {
  const digits = getFractionDigits(currency.code)
  const factor = Math.pow(10, digits)
  return Math.round(value * factor) / factor
}

export function formatCost(costUSD: number, currency: ActiveCurrency): string {
  const { symbol, code } = currency
  const cost = costUSD * currency.rate
  const digits = getFractionDigits(code)

  if (digits === 0) return `${symbol}${Math.round(cost)}`
  if (cost >= 1) return `${symbol}${cost.toFixed(2)}`
  if (cost >= 0.01) return `${symbol}${cost.toFixed(3)}`
  if (cost >= 0.0001) return `${symbol}${cost.toFixed(4)}`
  return `${symbol}${cost.toFixed(2)}`
}
