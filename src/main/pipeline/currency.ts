// Versione semplificata: watchtower supporta solo USD.
// Manteniamo la stessa API pubblica per compatibilità con i moduli portati dal CLI.

type CurrencyState = {
  code: string
  rate: number
  symbol: string
}

const USD: CurrencyState = { code: 'USD', rate: 1, symbol: '$' }
let active: CurrencyState = USD

export function isValidCurrencyCode(code: string): boolean {
  try {
    new Intl.NumberFormat('en', { style: 'currency', currency: code })
    return true
  } catch {
    return false
  }
}

export function getFractionDigits(code: string): number {
  return new Intl.NumberFormat('en', {
    style: 'currency',
    currency: code,
  }).resolvedOptions().maximumFractionDigits ?? 2
}

export function roundForActiveCurrency(value: number): number {
  const digits = getFractionDigits(active.code)
  const factor = Math.pow(10, digits)
  return Math.round(value * factor) / factor
}

export async function loadCurrency(): Promise<void> {
  active = USD
}

export function getCurrency(): CurrencyState {
  return active
}

export async function switchCurrency(_code: string): Promise<void> {
  // no-op: watchtower supporta solo USD
  active = USD
}

export function getCostColumnHeader(): string {
  return `Cost (${active.code})`
}

export function convertCost(costUSD: number): number {
  return costUSD * active.rate
}

export function formatCost(costUSD: number): string {
  const { symbol } = active
  const cost = costUSD
  if (cost >= 1) return `${symbol}${cost.toFixed(2)}`
  if (cost >= 0.01) return `${symbol}${cost.toFixed(3)}`
  if (cost >= 0.0001) return `${symbol}${cost.toFixed(4)}`
  return `${symbol}${cost.toFixed(2)}`
}
