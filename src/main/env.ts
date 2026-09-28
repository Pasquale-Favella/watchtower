import * as Config from 'effect/Config'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { homedir } from 'os'
import { join } from 'path'

/**
 * Env-only Config service (ADR 0032 §5.2, Wave 3 first seam + Wave 4 TTL seam).
 *
 * Startup-immutable snapshot of `process.env` for the gateway + pricing-TTL
 * seams: the live layer resolves `AI_GATEWAY_API_KEY` / `VERCEL_OIDC_TOKEN`
 * and `WATCHTOWER_PRICING_TTL_HOURS` once per layer provisioning via Effect
 * `Config` and stores the result as plain values. Effects read `yield* Env`
 * — they never touch `process.env` directly, so tests substitute the fake
 * layer with no env mutation and the Effect Clock (`TestClock`) governs
 * timeouts downstream without interference.
 *
 * Persisted settings stay in `LedgerRepository` — this service is env-only by
 * design (locked §5.2). No unified `AppConfig`, no `@effect/platform`,
 * no Zod, no renderer/IPC involvement.
 *
 * Extension (cache-dir seam, this slice): `WATCHTOWER_CACHE_DIR` sync readers
 * stay sync via the startup snapshot below — `initAppPaths` captures it once
 * at boot and `resolveCacheDir` is the single reader. The fake
 * `layerWithValues` already accepts the full shape so callers/tests pick up
 * new keys with no signature churn; `layerWithGatewayKey` stays as the
 * single-key shortcut for the gateway seam (defaults the TTL to `Infinity`).
 *
 * Extension (cursor-suppress + codex-home seams): `WATCHTOWER_SUPPRESS_CACHE_WRITES`
 * and `CODEX_HOME` travel as `Env` fields with pure resolvers below. The sync
 * discovery paths stay sync — `writeCachedResults` and `createCodexProvider`
 * accept an optional threaded value and fall back to the legacy `process.env`
 * read, so behavior is byte-identical until the call-site roots thread `Env`
 * through (later slice; the `process.env` fallbacks delete only when every
 * reader is snapshot-initialized AND the env-mutating tests migrate).
 */
export function resolveGatewayKey(primaryRaw: string | undefined, fallbackRaw: string | undefined): string | null {
  const raw = primaryRaw ?? fallbackRaw
  const trimmed = raw?.trim()
  return trimmed ? trimmed : null
}

const MS_PER_HOUR: number = 60 * 60 * 1000

/**
 * Pure TTL parser preserving `getPricingCacheTtlMs` semantics exactly:
 * absent/unparseable/non-positive → `Infinity` (disables expiry).
 */
export function resolvePricingCacheTtlMs(raw: string | undefined): number {
  if (!raw) return Infinity
  const hours = Number(raw)
  if (!Number.isFinite(hours) || hours <= 0) return Infinity
  return hours * MS_PER_HOUR
}

/**
 * Pure suppression-flag parser preserving `writeCachedResults` semantics
 * exactly: any set (non-empty) value suppresses, absent/empty does not.
 * No trim — even whitespace is truthy at the legacy `if (process.env[...])`
 * check, so `Boolean` is the exact parity mapping.
 */
export function resolveCursorCacheSuppressWrites(raw: string | undefined): boolean {
  return Boolean(raw)
}

/**
 * Pure provider-home resolver preserving `createCodexProvider` semantics
 * exactly (single-provider exemplar for the Wave-9 rollout): explicit override
 * wins, then the `CODEX_HOME` value, then the homedir default. `??` parity —
 * empty strings are used verbatim, never skipped.
 */
export function resolveCodexHome(envRaw: string | undefined, override?: string): string {
  return override ?? envRaw ?? join(homedir(), '.codex')
}

// ── Cache-dir startup snapshot (§5.2 env-only Config, cache-dir seam) ──
//
// The five sync cache-dir readers (session-cache, codex-cache,
// cache-refresh-lock, models pricing cache, antigravity) sit on sync parse
// paths that Effect Config cannot reach without wide ripples, so the cache
// dir travels as a startup-immutable snapshot rather than an `Env` service
// field: `initAppPaths` captures it once at boot (db-worker entry from
// `init.cacheDir`) and `resolveCacheDir` is the single sync reader.
//
// Precedence: (1) explicitly initialized snapshot, (2)
// `process.env['WATCHTOWER_CACHE_DIR']` fallback — kept so every existing
// env-mutating test stays green with zero edits, (3) the homedir default.
// Write-once at boot in production; re-init overwrites deterministically so
// tests can re-init per case like `Env.layerWithValues` fakes.
//
// Named removal condition: the `process.env` fallback inside
// `resolveCacheDir` deletes when all readers are snapshot-initialized in
// every isolate AND the env-mutating tests migrate to `initAppPaths`
// (later slice).
let appPathsSnapshot: { cacheDir: string } | null = null

export function initAppPaths({ cacheDir }: { cacheDir: string }): void {
  appPathsSnapshot = { cacheDir }
}

export function resolveCacheDir(): string {
  return appPathsSnapshot?.cacheDir ?? process.env['WATCHTOWER_CACHE_DIR'] ?? join(homedir(), '.cache', 'watchtower')
}

function readOptionalEnv(name: string): Effect.Effect<string | undefined, never> {
  return Config.option(Config.String(name)).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  )
}

/** One live `Config` read piped through its pure resolver, so each new
 * single-variable `Env` field is a single declaration line instead of a
 * copy-pasted 3-line `Effect.gen`. Multi-variable seams (the gateway key) keep
 * their own explicit read. */
function readEnvFieldLive<A>(name: string, resolve: (raw: string | undefined) => A): Effect.Effect<A, never> {
  return Effect.gen(function* () {
    const raw = yield* readOptionalEnv(name)
    return resolve(raw)
  })
}

const readGatewayKeyLive: Effect.Effect<string | null, never> = Effect.gen(function* () {
  const primary = yield* readOptionalEnv('AI_GATEWAY_API_KEY')
  const fallback = yield* readOptionalEnv('VERCEL_OIDC_TOKEN')
  return resolveGatewayKey(primary, fallback)
})

const readPricingCacheTtlMsLive = readEnvFieldLive('WATCHTOWER_PRICING_TTL_HOURS', resolvePricingCacheTtlMs)

const readCursorCacheSuppressWritesLive = readEnvFieldLive(
  'WATCHTOWER_SUPPRESS_CACHE_WRITES',
  resolveCursorCacheSuppressWrites,
)

const readCodexHomeLive = readEnvFieldLive('CODEX_HOME', resolveCodexHome)

export class Env extends Context.Service<
  Env,
  {
    readonly vercelGatewayApiKey: string | null
    readonly pricingCacheTtlMs: number
    readonly cursorCacheSuppressWrites: boolean
    readonly codexHome: string
  }
>()('watchtower/env/Env') {
  static readonly layer: Layer.Layer<Env> = Layer.effect(
    Env,
    Effect.gen(function* () {
      const vercelGatewayApiKey = yield* readGatewayKeyLive
      const pricingCacheTtlMs = yield* readPricingCacheTtlMsLive
      const cursorCacheSuppressWrites = yield* readCursorCacheSuppressWritesLive
      const codexHome = yield* readCodexHomeLive
      return Env.of({ vercelGatewayApiKey, pricingCacheTtlMs, cursorCacheSuppressWrites, codexHome })
    }),
  )

  static readonly layerWithValues = (values: Env['Service']): Layer.Layer<Env> => Layer.succeed(Env, Env.of(values))

  static readonly layerWithGatewayKey = (vercelGatewayApiKey: string | null): Layer.Layer<Env> =>
    Env.layerWithValues({
      vercelGatewayApiKey,
      pricingCacheTtlMs: Infinity,
      cursorCacheSuppressWrites: false,
      codexHome: resolveCodexHome(undefined),
    })
}
