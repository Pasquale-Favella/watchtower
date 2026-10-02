import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import type { SchemaError } from 'effect/Schema'
import type { SqlError } from 'effect/unstable/sql/SqlError'

import type { ActiveCurrency, CurrencyOption } from '../shared/schemas/fx.js'
import type { CurrencyRate } from '../shared/schemas/ledger.js'
import { HttpFetch, retryTransientFetch } from './pipeline/fetch-utils.js'
import type { LedgerStore } from './store/ledger.js'
import { LedgerConfig } from './store/ledger-repository.js'

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
 * has ever been cached. Repository failures remain typed failures; storage
 * corruption is never converted into a successful fallback.
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
  return (
    new Intl.NumberFormat('en', {
      style: 'currency',
      currency: code,
    }).resolvedOptions().maximumFractionDigits ?? 2
  )
}

function isValidRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_VALID_FX_RATE && value <= MAX_VALID_FX_RATE
}

/** Every ISO 4217 currency code the runtime supports (162 in this Node/ICU),
 * each with its display symbol — the full selector list, not a reduced set.
 * Frankfurter/ECB only publishes a ~30-currency subset; codes outside it
 * simply fall back per the graceful-degrade rule until a fetch succeeds. */
export function listCurrencies(): CurrencyOption[] {
  const codes = SUPPORTED_CURRENCY_CODES.size > 0 ? [...SUPPORTED_CURRENCY_CODES] : Intl.supportedValuesOf('currency')
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

/** Write-side display-code sanitization (uppercase a 3-letter code, else
 * `USD`) — the rule the now-deleted `LedgerStore.setDisplayCurrency` used to
 * own, so the write stays byte-identical across the live port and the
 * temporary standalone adapter. */
function sanitizeDisplayCurrencyCode(code: string): string {
  return /^[A-Za-z]{3}$/.test(code) ? code.toUpperCase() : 'USD'
}

/** The one place the "cached rate, else the USD-equivalent rate 1" rule is
 * spelled out. Every `ActiveCurrency` the two read paths build goes through
 * it: the sync `getActiveCurrency`, the refresh core's fresh-cache arm, and
 * its fallback arm. The `??` chain is the "a stale rate beats no rate"
 * degrade — `CurrencyRate`'s fields are all required, so for a present cache
 * the fallbacks never fire. */
function activeFromCachedRate(code: string, cached: CurrencyRate | null | undefined): ActiveCurrency {
  return {
    code,
    symbol: cached?.symbol ?? resolveSymbol(code),
    rate: cached?.rate ?? 1,
    updatedAt: cached?.updatedAt,
  }
}

/** The active display currency: the persisted code plus its cached rate.
 * Falls back to the last successfully cached rate whenever one exists (even
 * if stale — a stale rate beats no rate), or to the USD-equivalent rate 1
 * when nothing has ever been cached. Never fetches; this is the renderer's
 * single read path.
 *
 * Temporary synchronous adapter for dispatch, cadence and export callers.
 * Remove it when those application workflows read through the composed FX
 * port. Their IPC result remains an ordinary serializable value. */
export function getActiveCurrency(store: LedgerStore): ActiveCurrency {
  const code = displayCurrencyCode(store)
  if (code === 'USD') return { ...USD_CURRENCY }
  return activeFromCachedRate(code, store.getCurrencyRate(code))
}

export function isRateStale(updatedAt: string | undefined, now = Date.now()): boolean {
  if (!updatedAt) return true
  const t = Date.parse(updatedAt)
  if (!Number.isFinite(t)) return true
  return now - t > FX_CACHE_TTL_MS
}

export interface RefreshFxRateEffectOptions {
  /** Injectable clock for staleness tests; defaults to the Effect Clock. */
  now?: () => number
  /** Fetch timeout override; defaults to the shared HTTP ceiling. */
  timeoutMs?: number
}

/**
 * Temporary runner seam for `layerWithRepository` callers that still use
 * `LedgerStore.runRepositorySync`. Delete it with that adapter once the
 * remaining standalone and test callers compose `FxRates.layer` directly.
 */
export interface FxRatesRepositoryRunner {
  runRepositorySync<A>(operation: (config: LedgerConfig['Service']) => Effect.Effect<A, SqlError | SchemaError>): A
}

/**
 * Minimal FX persistence port (ADR 0032 §4.2 first half): the four ledger
 * persistence members the FX boundary uses, exposed as a `Context.Service` +
 * layers so the refresh core depends on the port rather than the concrete
 * store (the `HttpFetch.layerWithFetch` / `HarnessProbe.layerWithProbe`
 * fake-ability pattern). Persisted settings stay in the ledger per §5.2.
 */
export class FxRates extends Context.Service<
  FxRates,
  {
    readonly getCurrencyRate: (code: string) => Effect.Effect<CurrencyRate | null, SqlError | SchemaError>
    readonly setCurrencyRate: (rate: CurrencyRate) => Effect.Effect<void, SqlError | SchemaError>
    readonly getDisplayCurrency: () => Effect.Effect<string, SqlError | SchemaError>
    readonly setDisplayCurrency: (code: string) => Effect.Effect<void, SqlError | SchemaError>
  }
>()('watchtower/fx/FxRates') {
  /** Live FX adapter over the composed ledger config port. Service methods
   * stay as Effects so SQL and row-decoding failures reach callers unchanged. */
  static readonly layer: Layer.Layer<FxRates, never, LedgerConfig> = Layer.effect(
    FxRates,
    Effect.gen(function* () {
      const config = yield* LedgerConfig
      return FxRates.of({
        getCurrencyRate: code => config.getCurrencyRate(code),
        setCurrencyRate: rate => config.setCurrencyRate(rate),
        getDisplayCurrency: () => config.getDisplayCurrency(),
        setDisplayCurrency: code => config.setDisplayCurrency(sanitizeDisplayCurrencyCode(code)),
      })
    }),
  )

  static readonly layerWithRates = (rates: FxRates['Service']): Layer.Layer<FxRates> =>
    Layer.succeed(FxRates, FxRates.of(rates))

  /**
   * Temporary standalone adapter for callers that still own a LedgerStore.
   * Production composition uses `FxRates.layer` with `LedgerConfig`.
   * Remove this adapter and its runner seam once all test/standalone callers
   * compose the canonical port layer.
   */
  static readonly layerWithRepository = (runner: FxRatesRepositoryRunner): Layer.Layer<FxRates> => {
    const run = <A>(operation: (config: LedgerConfig['Service']) => Effect.Effect<A, SqlError | SchemaError>) =>
      Effect.sync(() => runner.runRepositorySync(operation))

    return FxRates.layerWithRates({
      getCurrencyRate: code => run(repository => repository.getCurrencyRate(code)),
      setCurrencyRate: rate => run(repository => repository.setCurrencyRate(rate)),
      getDisplayCurrency: () => run(repository => repository.getDisplayCurrency()),
      setDisplayCurrency: code => run(repository => repository.setDisplayCurrency(sanitizeDisplayCurrencyCode(code))),
    })
  }
}

/** Port-based USD→code refresh core (ADR 0032 slice 2).
 *
 * Falls back to the last cached rate (or USD rate 1) on
 * offline/blocked/non-2xx/invalid-rate. SQL and schema failures propagate.
 * The network enters through the
 * `HttpFetch` service and persistence through the `FxRates` port — timeout
 * via the Effect Clock (TestClock-controllable) and fiber interruption aborts
 * the underlying fetch, replacing the manual `signal` plumbing. Staleness
 * reads the production clock via `Clock.currentTimeMillis` (TestClock-governed;
 * `options.now` still overrides for existing tests). Pure helpers stay plain
 * functions; the display boundary is not Effect-ified.
 */
export const refreshFxRateWithRates = Effect.fnUntraced(function* (
  code: string,
  options: RefreshFxRateEffectOptions = {},
): Effect.fn.Return<ActiveCurrency, SqlError | SchemaError, HttpFetch | FxRates> {
  const safe = isValidCurrencyCode(code) ? code : 'USD'
  if (safe === 'USD') return { ...USD_CURRENCY }

  const rates = yield* FxRates
  const cached = yield* rates.getCurrencyRate(safe)
  const now = options.now ? yield* Effect.sync(options.now) : yield* Clock.currentTimeMillis
  if (cached && !isRateStale(cached.updatedAt, now)) return activeFromCachedRate(safe, cached)
  const fallback = (): ActiveCurrency => activeFromCachedRate(safe, cached)

  const http = yield* HttpFetch
  return yield* Effect.gen(function* () {
    // Bounded transient retry (F15/A1) on the fetch only — the rate is either
    // persisted or not, never half-written. Without it, one blip on this
    // refresh left the previous rate in place for the full `FX_CACHE_TTL_MS`
    // (24h), so every currency figure in every Section read wrong for a day.
    // An abort (scan cancelled mid-flight) is never retried, and the
    // `fallback()` arm below is still exactly the same "a stale rate beats no
    // rate" degrade — it just runs after the retries are spent.
    const response = yield* http.fetch(`${FRANKFURTER_URL}${safe}`, {}, options.timeoutMs).pipe(retryTransientFetch)
    if (!response.ok) return fallback()
    const data = yield* Effect.tryPromise({
      try: () => response.json() as Promise<{ rates?: Record<string, unknown> }>,
      catch: cause => cause,
    }).pipe(Effect.orElseSucceed(() => null))
    const rate = data?.rates?.[safe]
    if (!isValidRate(rate)) return fallback()
    yield* rates.setCurrencyRate({
      code: safe,
      symbol: resolveSymbol(safe),
      rate,
      updatedAt: new Date(now).toISOString(),
    })
    const latest = yield* rates.getCurrencyRate(safe)
    return activeFromCachedRate(safe, latest)
  }).pipe(Effect.catchTag('HttpFetchError', () => Effect.succeed(fallback())))
})

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
