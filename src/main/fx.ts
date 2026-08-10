import { fetchWithTimeout } from './pipeline/fetch-utils.js'
import type { LedgerStore } from './store/ledger.js'
import type { ActiveCurrency, CurrencyOption } from '../shared/schemas/fx.js'

export type { ActiveCurrency, CurrencyOption } from '../shared/schemas/fx.js'

/**
 * The Frankfurter-backed FX layer (ADR 0009). The main process is the only
 * thing that ever talks to Frankfurter (ECB data, no key): a background job
 * fetches USD-anchored rates on the background-scan cadence and caches them
 * into the store's `currency_rate` side-table (ADR 0009). The renderer only
 * ever reads the cached rate via IPC — it never fetches directly.
 *
 * Stored cost figures stay USD-anchored; conversion happens only at the
 * display/export boundary (`convertCost` / `roundForActiveCurrency` /
 * `formatCost`). If a fetch fails (offline/blocked/rate missing from ECB),
 * the app falls back to the last successfully cached rate, or USD if none
 * has ever been cached — and that fallback must never block any other part
 * of the app, so all fetch paths are fire-and-forget and never throw.
 */

export const FX_CACHE_TTL_MS = 24 * 60 * 60 * 1000

const FRANKFURTER_URL = 'https://api.frankfurter.app/latest?from=USD&to='
// Defensive bounds on any fetched FX rate. Outside this band the rate is
// either a parser bug or a tampered Frankfurter response, and we refuse to
// multiply it into displayed costs (mirrors the reference app's guards).
const MIN_VALID_FX_RATE = 0.0001
const MAX_VALID_FX_RATE = 1_000_000

const USD_CURRENCY: ActiveCurrency = { code: 'USD', symbol: '$', rate: 1 }

const SYMBOL_OVERRIDES: Record<string, string> = {
  CNY: '¥',
  RON: 'lei',
}

/** The canonical ISO 4217 currency set the runtime ships with (162 codes in
 * this ICU). This is the authoritative membership list: Intl.NumberFormat
 * alone ACCEPTS any three-letter string (ZZZ, ABC, …), so it can't tell a
 * real currency from a fake one — membership here can. Used by the selector
 * and by every validation point, so a bogus code can never be persisted or
 * fetched against. */
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
  // Fallback for runtimes without Intl.supportedValuesOf: Intl.NumberFormat
  // throws only on structurally invalid codes there.
  try {
    new Intl.NumberFormat('en', { style: 'currency', currency: code })
    return true
  } catch {
    return false
  }
}

function resolveSymbol(code: string): string {
  if (SYMBOL_OVERRIDES[code]) return SYMBOL_OVERRIDES[code]
  const parts = new Intl.NumberFormat('en', {
    style: 'currency',
    currency: code,
    currencyDisplay: 'symbol',
  }).formatToParts(0)
  return parts.find(p => p.type === 'currency')?.value ?? code
}

export function getFractionDigits(code: string): number {
  return new Intl.NumberFormat('en', {
    style: 'currency',
    currency: code,
  }).resolvedOptions().maximumFractionDigits ?? 2
}

function isValidRate(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= MIN_VALID_FX_RATE
    && value <= MAX_VALID_FX_RATE
}

/** Every ISO 4217 currency code the runtime supports (162 in this Node/ICU),
 * each with its display symbol — the full selector list, not a reduced set.
 * Frankfurter/ECB only publishes a ~30-currency subset; codes outside it
 * simply fall back per the graceful-degrade rule until a fetch succeeds. */
export function listCurrencies(): CurrencyOption[] {
  const codes = SUPPORTED_CURRENCY_CODES.size > 0
    ? [...SUPPORTED_CURRENCY_CODES]
    : Intl.supportedValuesOf('currency')
  return codes
    .filter(isValidCurrencyCode)
    .map(code => ({ code, symbol: resolveSymbol(code) }))
    .sort((a, b) => a.code.localeCompare(b.code))
}

/** The persisted display-currency code (always valid; USD default). */
function displayCurrencyCode(store: LedgerStore): string {
  const code = store.getDisplayCurrency()
  return isValidCurrencyCode(code) ? code : 'USD'
}

/** The active display currency: the persisted code plus its cached rate.
 * Falls back to the last successfully cached rate whenever one exists (even
 * if stale — a stale rate beats no rate), or to the USD-equivalent rate 1
 * when nothing has ever been cached. Never fetches; this is the renderer's
 * single read path. */
export function getActiveCurrency(store: LedgerStore): ActiveCurrency {
  const code = displayCurrencyCode(store)
  if (code === 'USD') return { ...USD_CURRENCY }
  const cached = store.getCurrencyRate(code)
  return {
    code,
    symbol: cached?.symbol ?? resolveSymbol(code),
    rate: cached?.rate ?? 1,
    updatedAt: cached?.updatedAt,
  }
}

export function isRateStale(updatedAt: string | undefined, now = Date.now()): boolean {
  if (!updatedAt) return true
  const t = Date.parse(updatedAt)
  if (!Number.isFinite(t)) return true
  return now - t > FX_CACHE_TTL_MS
}

interface RefreshFxOptions {
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
  /** Injectable clock for staleness tests. */
  now?: () => number
}

/** Fetches the USD→code rate from Frankfurter and caches it into the FX
 * side-table when the cached rate is missing or older than the 24h TTL.
 * Never throws: every failure (offline, blocked, non-2xx, invalid rate)
 * silently keeps the last successfully cached rate, or the USD fallback.
 * Returns the resulting active currency for the caller. */
export async function refreshFxRate(
  store: LedgerStore,
  code: string,
  options: RefreshFxOptions = {},
): Promise<ActiveCurrency> {
  const safe = isValidCurrencyCode(code) ? code : 'USD'
  if (safe === 'USD') return { ...USD_CURRENCY }

  const cached = store.getCurrencyRate(safe)
  const now = options.now?.() ?? Date.now()
  if (cached && !isRateStale(cached.updatedAt, now)) {
    return { code: safe, symbol: cached.symbol, rate: cached.rate, updatedAt: cached.updatedAt }
  }

  const fetchImpl = options.fetchImpl ?? fetch
  try {
    const response = await fetchWithTimeout(`${FRANKFURTER_URL}${safe}`, {}, undefined, fetchImpl)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json() as { rates?: Record<string, unknown> }
    const rate = data.rates?.[safe]
    if (!isValidRate(rate)) throw new Error(`Invalid rate returned for ${safe}`)
    store.setCurrencyRate({ code: safe, symbol: resolveSymbol(safe), rate, updatedAt: new Date(now).toISOString() })
  } catch {
    // Offline / blocked / malformed — keep the last cached rate (or USD).
  }

  const latest = store.getCurrencyRate(safe)
  return {
    code: safe,
    symbol: latest?.symbol ?? resolveSymbol(safe),
    rate: latest?.rate ?? 1,
    updatedAt: latest?.updatedAt,
  }
}

// --- Display/export-boundary conversion. Costs in the store are always USD;
// these are the only places FX is applied. ---

export function convertCost(costUSD: number, currency: ActiveCurrency): number {
  // Unrounded — see the reference app: rounding here would clamp zero-fraction
  // currencies (JPY/KRW/CLP) before aggregation. roundForActiveCurrency /
  // formatCost round at the display boundary instead.
  return costUSD * currency.rate
}

export function roundForActiveCurrency(value: number, currency: ActiveCurrency): number {
  const digits = getFractionDigits(currency.code)
  const factor = Math.pow(10, digits)
  return Math.round(value * factor) / factor
}

/** Format a USD figure in the active display currency (used by exports and
 * any main-process money rendering). Zero-fraction currencies (JPY, KRW,
 * CLP) drop the decimals; small sub-cent costs keep up to 4 places so they
 * don't collapse to $0.00. */
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
