import * as Config from 'effect/Config'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { homedir } from 'os'
import { join } from 'path'

/**
 * Two config seams with two different consumers, one file (ADR 0032).
 *
 * 1. `Env` — the **Effect**-only Config service (Wave 3 gateway seam + Wave 4
 *    TTL seam). The live layer resolves `AI_GATEWAY_API_KEY` /
 *    `VERCEL_OIDC_TOKEN` and `WATCHTOWER_PRICING_TTL_HOURS` once per layer
 *    provisioning via Effect `Config` and stores the result as plain values.
 *    Effects read `yield* Env` — they never touch `process.env` directly, so
 *    tests substitute the fake layer with no env mutation and the Effect Clock
 *    (`TestClock`) governs timeouts downstream without interference.
 *    `Env` is for values an Effect consumer can ACTUALLY read. A field no
 *    Effect consumer reads is dead weight here, not a config value.
 *
 * 2. `appPaths()` — the **sync** startup snapshot for the ~25 provider-home /
 *    platform-path `process.env` readers. Those readers sit on sync discovery /
 *    parse paths (`createCodexProvider`, `getAgentTracesDbPath`,
 *    `getRegistryPath`, …) that Effect `Config` cannot reach without wrapping
 *    each in an Effect, so they read a module-global snapshot instead:
 *    `initAppPaths` captures it once at boot (db-worker entry from
 *    `init.cacheDir`; the main isolate from the same `join(dataDir, 'cache')`
 *    it hands the worker) and `appPaths()` is the single sync reader.
 *
 * Persisted settings stay in `LedgerRepository` — this file is env-only by
 * design (locked §5.2). No unified `AppConfig`, no `@effect/platform`, no Zod,
 * no renderer/IPC involvement.
 *
 * ── SEAM CONVENTION (binding for the provider-seam slices) ──
 *
 * Every provider-home / platform-path seam takes **ONE optional trailing
 * `paths: AppPaths` parameter** — not one parameter per env var — reads only
 * its own field out of it, and keeps `override`-wins precedence:
 *
 * ```ts
 * function getAgentTracesDbPath(override?: string, paths?: AppPaths) {
 *   const appData = (paths ?? appPaths()).platform.appData ?? join(home, 'AppData', 'Roaming')
 * }
 * ```
 *
 * - ONE trailing param, always last, so there is no arg-order asymmetry: Wave
 *   8's `createCodexProvider(codexDir?, envCodexHome?)` grew a per-var param in
 *   position 2, which reads as a second "override" at the call site. `paths`
 *   never competes with an override for that slot.
 * - The seam keeps its OWN `??` fallback chain on top of `paths`. The snapshot
 *   REPORTS; it never DECIDES. A field the seam does not understand must not
 *   change what the seam does when it is `null`.
 * - Sync callers that cannot thread the parameter (provider registries deep in
 *   discovery) call `appPaths()` directly. Same lookup, resolved at the call
 *   site instead of at the root.
 * - The `process.env` fallbacks inside the resolvers below stay until every
 *   reader in every isolate is snapshot-initialized AND the env-mutating tests
 *   migrate to `initAppPaths` (named removal condition on the snapshot block).
 *   They are what keeps existing env-mutating tests green with zero edits.
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

/**
 * Platform-standard env roots as the readers actually use them. `null` means
 * "unset" — never "empty": every platform reader in `src/main/pipeline`
 * reaches these with `??` (`copilot.ts:317`, `crush.ts:37`, `crush.ts:41`,
 * `ibm-bob.ts:22`, `ibm-bob.ts:28`, `open-design.ts:88`, `goose.ts:60`,
 * `kilo-code.ts:16`, `opencode.ts:42`, `zerostack.ts:54`), where an empty
 * string is a real value used verbatim. Only `undefined` maps to `null`.
 *
 * Known reader-side asymmetries — the snapshot reports, so each reader keeps
 * its own normalization and MUST keep it when it migrates to `paths.platform`:
 * - `XDG_CONFIG_HOME`: `copilot.ts:352` does `if (xdg && (isAbsolute(xdg)…))`
 *   — empty AND relative values are rejected; `ibm-bob.ts:28` does `??` and
 *   would `join('', 'IBM Bob', …)` into a relative path. Same env var, two
 *   behaviors; the snapshot must not pick one.
 * - `APPDATA` / `LOCALAPPDATA`: `claude.ts:133-137` does `?.trim() || <default>`
 *   (empty/whitespace → homedir default) where the `??` readers use it as-is.
 */
export interface PlatformPaths {
  readonly appData: string | null
  readonly localAppData: string | null
  readonly xdgConfigHome: string | null
  readonly xdgDataHome: string | null
}

/** The full sync config snapshot every provider-home / platform-path seam reads. */
export interface AppPaths {
  readonly cacheDir: string
  readonly codexHome: string
  readonly suppressCacheWrites: boolean
  readonly platform: PlatformPaths
}

/** The one injectable reader the pure platform resolver takes: `process.env`
 *  in production, a literal map in tests. */
export type EnvReader = (name: string) => string | undefined

/**
 * Pure platform-roots resolver. `?? null` and nothing else: an empty string
 * survives verbatim (see the `PlatformPaths` doc for the reader evidence), and
 * each field is its own `read` call so an injected reader only has to answer
 * for the names it knows.
 */
export function resolvePlatformPaths(read: EnvReader): PlatformPaths {
  return {
    appData: read('APPDATA') ?? null,
    localAppData: read('LOCALAPPDATA') ?? null,
    xdgConfigHome: read('XDG_CONFIG_HOME') ?? null,
    xdgDataHome: read('XDG_DATA_HOME') ?? null,
  }
}

// ── App-paths startup snapshot (§5.2 env-only Config, sync discovery seams) ──
//
// The ~25 sync provider-home / platform-path readers (session-cache,
// codex-cache, cache-refresh-lock, models pricing cache, antigravity, and the
// per-provider `create*Provider` / `get*Dir` paths) sit on sync discovery paths
// Effect Config cannot reach, so their values travel as a startup-immutable
// snapshot rather than `Env` service fields: `initAppPaths` captures them once
// at boot and `appPaths()` reads the whole record.
//
// `appPaths()` is the SEAM the per-provider readers migrate onto one slice at a
// time — it is not yet the single sync reader: `resolveCacheDir()` still serves
// the five `cacheDir` callers, and the per-provider `?? process.env` lines are
// untouched until their own slice lands (see the named removal condition
// below). Each migration replaces one `process.env` read with the snapshot
// value it would have read anyway.
//
// Precedence, per field: (1) the explicitly initialized snapshot, (2) the
// `process.env` value the seam would have read anyway — kept so every existing
// env-mutating test stays green with zero edits, (3) the resolver default.
// Every default derives from the SAME pure resolver the fallback path uses
// today; there is no second source of truth.
//
// `initAppPaths` REPLACES the record wholesale (deterministic re-init so tests
// can re-init per case, mirroring `Env.layerWithValues` fakes). It is
// write-once at boot in production: the main isolate initializes from the
// value the reader already resolved (the documented `WATCHTOWER_CACHE_DIR`
// override, else `join(dataDir, 'cache')`), the worker initializes from
// `init.cacheDir`.
//
// Named removal condition: the `process.env` fallbacks below delete when every
// reader in every isolate is snapshot-initialized AND the env-mutating tests
// migrate to `initAppPaths` (later slice).
let appPathsSnapshot: Partial<AppPaths> | null = null

export function initAppPaths(input: { cacheDir: string } & Partial<Omit<AppPaths, 'cacheDir'>>): void {
  appPathsSnapshot = { ...input }
}

const readProcessEnv: EnvReader = name => process.env[name]

export function resolveCacheDir(): string {
  return appPathsSnapshot?.cacheDir ?? process.env['WATCHTOWER_CACHE_DIR'] ?? join(homedir(), '.cache', 'watchtower')
}

/**
 * Reads the startup snapshot. Fields the boot call did not initialize fall back
 * to the same `process.env`-derived value the fallback path uses today, resolved
 * by the same pure resolvers — so an uninitialized isolate behaves
 * byte-identically to the pre-snapshot code.
 */
export function appPaths(): AppPaths {
  return {
    cacheDir: resolveCacheDir(),
    codexHome: appPathsSnapshot?.codexHome ?? resolveCodexHome(process.env['CODEX_HOME']),
    suppressCacheWrites:
      appPathsSnapshot?.suppressCacheWrites ??
      resolveCursorCacheSuppressWrites(process.env['WATCHTOWER_SUPPRESS_CACHE_WRITES']),
    platform: appPathsSnapshot?.platform ?? resolvePlatformPaths(readProcessEnv),
  }
}

function readOptionalEnv(name: string): Effect.Effect<string | undefined, never> {
  return Config.option(Config.String(name)).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  )
}

/** One live `Config` read piped through its pure resolver, so each new
 *  single-variable `Env` field is a single declaration line instead of a
 *  copy-pasted 3-line `Effect.gen`. Multi-variable seams (the gateway key) keep
 *  their own explicit read. */
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

/**
 * Exactly the two Effect-reachable values. `codexHome` /
 * `cursorCacheSuppressWrites` were carried here in Wave 8 and are removed: their
 * only readers are sync discovery paths, so no `yield* Env` consumer existed
 * and the fields were dead weight. They live in `AppPaths` now.
 */
export class Env extends Context.Service<
  Env,
  {
    readonly vercelGatewayApiKey: string | null
    readonly pricingCacheTtlMs: number
  }
>()('watchtower/env/Env') {
  static readonly layer: Layer.Layer<Env> = Layer.effect(
    Env,
    Effect.gen(function* () {
      const vercelGatewayApiKey = yield* readGatewayKeyLive
      const pricingCacheTtlMs = yield* readPricingCacheTtlMsLive
      return Env.of({ vercelGatewayApiKey, pricingCacheTtlMs })
    }),
  )

  static readonly layerWithValues = (values: Env['Service']): Layer.Layer<Env> => Layer.succeed(Env, Env.of(values))

  static readonly layerWithGatewayKey = (vercelGatewayApiKey: string | null): Layer.Layer<Env> =>
    Env.layerWithValues({
      vercelGatewayApiKey,
      pricingCacheTtlMs: Infinity,
    })
}
