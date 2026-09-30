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
 *    (pricing-correctness, TTL default.) The Wave 4 TTL parser returned
 *    `Infinity` for absent / unparseable / non-positive input, on the reading
 *    that "unset" meant "the operator opted out of expiry". It meant the
 *    opposite in practice: `Infinity` was the value NOBODY set, so the default
 *    install shipped a pricing cache that could never go stale, and the only
 *    way out was the manual `pricing:refresh` IPC. A machine observed during
 *    that work had a four-day-old cache and no `WATCHTOWER_PRICING_TTL_HOURS`,
 *    so it could not revalidate on its own. The parser now returns a finite
 *    `DEFAULT_PRICING_CACHE_TTL_MS`, and the `Infinity` opt-out is GONE: no
 *    caller in the repo set it and no doc asked for it, so carrying the branch
 *    only left a permanent way for the default install to rot. The cost of
 *    expiry is bounded — `loadPricingEffect` never fails and falls back to the
 *    bundled snapshot (ADR 0010), so an offline machine that loses an expired
 *    cache degrades to shipped prices for that launch instead of throwing.
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
 * Persisted settings stay in the ledger's `LedgerConfig` port — this file is
 * env-only by design (locked: #148 §5.2, restated in `docs/architecture.md`).
 * No unified `AppConfig`, no `@effect/platform`, no Zod, no renderer/IPC
 * involvement.
 *
 * ── SEAM CONVENTION (binding for the provider-seam slices) ──
 *
 * Every provider-home / platform-path seam takes **ONE optional trailing
 * `paths: AppPaths` parameter** — not one parameter per env var — reads only
 * its own field out of it, and keeps `override`-wins precedence. Real migrated
 * seams (`providers/crush.ts:getRegistryPath`, `providers/claude.ts:getDesktopSessionsDirs`):
 *
 * ```ts
 * export function getRegistryPath(paths?: AppPaths): string {
 *   const explicit = overrideFor(paths, 'CRUSH_GLOBAL_DATA')
 *   if (explicit) return explicit
 *   const local = platformFor(paths).localAppData ?? join(homedir(), 'AppData', 'Local')
 *   return join(local, 'crush', 'data')
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
 * The on-disk pricing cache (`<cacheDir>/litellm-pricing.json`) is revalidated
 * at most this often. Overridden by `WATCHTOWER_PRICING_TTL_HOURS` (hours, any
 * positive number); consumed by `loadPricingEffect` in
 * `src/main/pipeline/models.ts` as `Env.pricingCacheTtlMs`.
 *
 * 24 hours, deliberately, and it is the same interval the FX rates already use
 * (ADR 0009 caches them "for 24 hours"), so a launch re-fetches at most once a
 * day no matter how often the app is opened — a normal user's second launch of
 * the morning never touches the network. The other half of the trade is that a
 * vendor price correction has to reach users without a release, and a daily
 * bound is the shortest window that still survives an app opened many times a
 * day. Anything shorter starts paying a network round-trip (or a timeout, on an
 * offline machine) per launch; anything longer means a correction ships as a
 * release or not at all.
 *
 * Previously this was `Infinity` for every input that was not a positive
 * number, which made "unset" and "never expire" the same thing. That conflated
 * an absent value with a deliberate opt-out nobody makes: the result was a
 * cache that was authoritative forever, with the manual `pricing:refresh` IPC
 * as the only recovery. A finite default needs no opt-out branch, so
 * {@link resolvePricingCacheTtlMs} now folds every non-positive, unparseable or
 * absent value into this one number.
 */
export const DEFAULT_PRICING_CACHE_TTL_MS: number = 24 * MS_PER_HOUR

/**
 * Pure TTL parser: one raw string in, milliseconds out. No I/O, no env read, no
 * `Effect` — the live layer is the only thing that touches `Config`, and
 * `Env.layerWithValues` stays the seam tests inject.
 *
 * Anything that is not a positive, finite number of hours — absent, empty,
 * unparseable, zero, negative, `Infinity` spelled out — resolves to
 * {@link DEFAULT_PRICING_CACHE_TTL_MS}. There is deliberately no branch that
 * returns `Infinity`: the old one is what made the default install's cache
 * permanent, and a fresh-offline-machine opt-out is not worth a branch every
 * future reader has to reason about (the fetch path already degrades to the
 * bundled snapshot when the network is gone, so the scenario it protected
 * against does not need protecting).
 */
export function resolvePricingCacheTtlMs(raw: string | undefined): number {
  if (!raw) return DEFAULT_PRICING_CACHE_TTL_MS
  const hours = Number(raw)
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_PRICING_CACHE_TTL_MS
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
 * "unset" — never "empty": the platform readers in `src/main/pipeline` reach
 * these with `??` (`providers/copilot.ts` `getAgentTracesDbPath`,
 * `providers/crush.ts:getRegistryPath`, `providers/opencode.ts:getDataDir`,
 * `providers/ibm-bob.ts`, `providers/open-design.ts`, `providers/goose.ts`,
 * `providers/kilo-code.ts`, `providers/zerostack.ts`), where an empty string is
 * a real value used verbatim. Only `undefined` maps to `null`.
 *
 * Known reader-side asymmetries — the snapshot reports, so each reader keeps
 * its own normalization and MUST keep it when it migrates to `platformFor`:
 * - `XDG_CONFIG_HOME`: `providers/copilot.ts:getJetBrainsCopilotRoot` does
 *   `if (xdg && (isAbsolute(xdg)…))` — empty AND relative values are rejected;
 *   `providers/ibm-bob.ts` does `??` and would `join('', 'IBM Bob', …)` into a
 *   relative path. Same env var, two behaviors; the snapshot must not pick one.
 * - `APPDATA` / `LOCALAPPDATA`: `providers/claude.ts:getDesktopSessionsDirs` does
 *   `?.trim() || <default>` (empty/whitespace → homedir default) where the `??`
 *   readers use it as-is.
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
  readonly overrides: ProviderOverrides
}

/**
 * The single place a provider env var is registered: the exhaustive key list
 * `resolveProviderOverrides` reads, sorted so a new var is added in one place
 * (and the sort is pinned by a test, so the list stays reviewable).
 *
 * A registered key is not a promise that its reader is threaded yet. Several
 * entries here (`CODEWHALE_HOME`, `HERMES_HOME`, `FACTORY_DIR`, `WARP_DB_PATH`,
 * `QWEN_DATA_DIR`, `QUICKWORK_HOME`, `KIMI_CODE_HOME`, the three `LINGTAI_*`)
 * were added because the session-cache env fingerprint names them, and each one
 * still has a live direct `process.env` read in its provider
 * (`providers/codewhale.ts`, `hermes.ts`, `droid.ts`, `warp.ts`, `qwen.ts`,
 * `quickdesk.ts`, `kimicode.ts`, `lingtai-tui.ts`). Those readers migrate one
 * slice at a time, so an unthreaded key is a MIGRATION IN PROGRESS, not a
 * mistake: registering the var is what lets the fingerprint answer from the
 * snapshot instead of from a second inventory.
 *
 * The list is per-provider DISCOVERY overrides, so it carries override-shaped
 * vars only. `APPDATA` / `LOCALAPPDATA` / `XDG_CONFIG_HOME` / `XDG_DATA_HOME`
 * are platform roots, and `WATCHTOWER_CACHE_DIR` / `CODEX_HOME` are answered by
 * a resolved snapshot FIELD — none of them is an override, so none of them
 * belongs here. `ENV_VAR_SOURCES` below is the one table of which of the three
 * answers a given name.
 */
export const PROVIDER_ENV_KEYS = [
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CONFIG_DIRS',
  'CODEWHALE_HOME',
  'COLUMNS',
  'CRUSH_GLOBAL_DATA',
  'FACTORY_DIR',
  'HERMES_HOME',
  'KIMI_CODE_HOME',
  'LINGTAI_HOME',
  'LINGTAI_TUI_GLOBAL_DIR',
  'LINGTAI_TUI_HOME',
  'OPENCODE_DATA_DIR',
  'OPENCODE_DB_PREFIX',
  'QUICKWORK_HOME',
  'QWEN_DATA_DIR',
  'WARP_DB_PATH',
  'WATCHTOWER_COPILOT_DISABLE_OTEL',
  'WATCHTOWER_COPILOT_GLOBAL_STORAGE_DIR',
  'WATCHTOWER_COPILOT_JETBRAINS_DIR',
  'WATCHTOWER_COPILOT_OTEL_DB',
  'WATCHTOWER_COPILOT_SESSION_STATE_DIR',
  'WATCHTOWER_COPILOT_SESSION_STORE_DB',
  'WATCHTOWER_COPILOT_WS_STORAGE_DIR',
  'WATCHTOWER_DESKTOP_SESSIONS_DIR',
  'WATCHTOWER_PROGRESS',
  'WATCHTOWER_VERBOSE',
] as const

/**
 * The per-provider discovery overrides (Wave 9 rollout, step 1 of the seam
 * migration). Keyed by the ENV VAR NAME on purpose: the value's shape is
 * provider-specific (a dir, a path list, a flag) and every seam applies its own
 * chain to it, so a schema per provider would only add a second place to keep
 * in sync. The union is DERIVED from `PROVIDER_ENV_KEYS`, so the two cannot
 * drift: a var is registered in one place and a typo is a compile error at
 * every seam that asks for it.
 *
 * `undefined` means "not set" and only `undefined` may mean that: the readers
 * disagree about empty values on purpose (`??` uses `''` verbatim, `||` and
 * `.trim()` treat it as unset), so the snapshot records the raw string and
 * never decides. That is the same rule as `PlatformPaths`.
 */
export type ProviderEnvKey = (typeof PROVIDER_ENV_KEYS)[number]

/**
 * Every `process.env` read that a `ProviderEnvKey` already covers, so "is the
 * snapshot the single source of truth" stays a checkable claim instead of a
 * comment. Anything listed here must resolve through `overrideFor` /
 * `platformFor` / a snapshot FIELD, never a bare read.
 *
 * An entry is therefore a REGISTERED key whose reader is not threaded YET: the
 * value the seam reads is the ambient one (identical to what the snapshot would
 * report), so the list is the work-order for the seam rollout and not a defect.
 * `tests/env.test.ts` walks it and fails if a listed site is no longer a direct
 * read, so a migrated seam cannot leave a stale entry behind.
 *
 * `providers/opencode-family-sqlite.ts`'s `WATCHTOWER_VERBOSE` read left this
 * list when its notice moved onto the `paths` seam (the last of the
 * `models.ts`-family verbose gates to migrate). `WATCHTOWER_VERBOSE` itself stays
 * a key — the gate is read, so it is threaded; the direct read is what left.
 */
export const REMAINING_DIRECT_ENV_READS: Readonly<Record<string, readonly string[]>> = {
  'providers/codewhale.ts': ['CODEWHALE_HOME'],
  'providers/droid.ts': ['FACTORY_DIR'],
  'providers/hermes.ts': ['HERMES_HOME'],
  'providers/kimicode.ts': ['KIMI_CODE_HOME'],
  'providers/lingtai-tui.ts': ['LINGTAI_HOME', 'LINGTAI_TUI_GLOBAL_DIR', 'LINGTAI_TUI_HOME'],
  'providers/quickdesk.ts': ['QUICKWORK_HOME'],
  'providers/qwen.ts': ['QWEN_DATA_DIR'],
  'providers/warp.ts': ['WARP_DB_PATH'],
}

export type ProviderOverrides = Readonly<Partial<Record<ProviderEnvKey, string>>>

/**
 * Pure overrides resolver: reads exactly `PROVIDER_ENV_KEYS` through the
 * injectable reader and drops the undefined ones. A defined value is kept
 * VERBATIM (including `''`), per the `ProviderEnvKey` doc.
 */
export function resolveProviderOverrides(read: EnvReader): ProviderOverrides {
  const overrides: Record<string, string> = {}
  for (const key of PROVIDER_ENV_KEYS) {
    const value = read(key)
    if (value !== undefined) overrides[key] = value
  }
  return overrides
}

/**
 * The expression every provider seam uses for its own override var:
 * `(paths ?? appPaths()).overrides.KEY` written once so the lookup cannot drift
 * per provider. When no snapshot is threaded this is the identical
 * `process.env` read the seam did before, because `appPaths()` resolves
 * uninitialized fields through the same pure resolvers.
 *
 * A threaded record REPLACES the overrides map rather than merging with the
 * ambient env, so a key it does not carry resolves to `undefined` — the same as
 * `process.env` not setting it. Threading a record is therefore a full
 * statement about that seam's environment, not a partial override of it.
 */
export function overrideFor(paths: AppPaths | undefined, key: ProviderEnvKey): string | undefined {
  return (paths ?? appPaths()).overrides[key]
}

/** Same one-liner for the platform roots (`APPDATA`, `XDG_*`, …). */
export function platformFor(paths: AppPaths | undefined): PlatformPaths {
  return (paths ?? appPaths()).platform
}

/**
 * The two snapshot fields that carry an ALREADY RESOLVED value — the
 * `process.env` fallback plus their own default — as opposed to `overrides` /
 * `platform`, which report the raw string and leave normalization to the seam.
 * A reader of one of these vars reads the field, not the var.
 */
export type SnapshotFieldName = 'cacheDir' | 'codexHome'

/**
 * The env var names each platform root answers, and the `PlatformPaths` field
 * that holds it — the mapping `resolvePlatformPaths` already encodes, named so
 * the inventory's `satisfies` clause can require one row per pair instead of
 * trusting the table to stay in sync with the resolver.
 */
export type PlatformEnvVar = 'APPDATA' | 'LOCALAPPDATA' | 'XDG_CONFIG_HOME' | 'XDG_DATA_HOME'
export type PlatformPathsField = 'appData' | 'localAppData' | 'xdgConfigHome' | 'xdgDataHome'

/**
 * The two env var names whose seam reads a resolved snapshot FIELD. Each maps
 * 1:1 onto a `SnapshotFieldName`; a var here is NOT a `ProviderEnvKey` (an
 * override carries the raw var, not the resolved value), which is exactly why
 * the fingerprint has to ask the inventory instead of looking the name up in
 * `overrides`.
 */
export type FieldEnvVar = 'WATCHTOWER_CACHE_DIR' | 'CODEX_HOME'

/**
 * Which snapshot source answers one env var NAME. The three shapes are not
 * interchangeable, which is the whole reason this inventory exists:
 * - `override` — a per-provider discovery override. `overrides[name]`, raw
 *   string, `undefined` when unset. The name IS the key, so the row carries no
 *   key of its own.
 * - `platform` — one of the four platform roots. `platform[field]`, raw
 *   string, `null` when unset.
 * - `field` — a seam that reads the RESOLVED snapshot field
 *   (`WATCHTOWER_CACHE_DIR` → `cacheDir`, `CODEX_HOME` → `codexHome`). The
 *   value is the answer even when the env var is unset, because the seam's own
 *   `??` chain has already fallen back to a default by the time the fingerprint
 *   could ask.
 */
export type EnvVarSource =
  | { readonly kind: 'override' }
  | { readonly kind: 'platform'; readonly field: PlatformPathsField }
  | { readonly kind: 'field'; readonly field: SnapshotFieldName }

/**
 * The ONE inventory of "which snapshot source answers this env var name", and
 * the type every snapshot-driven var reader is checked against: a name that is
 * not a key here is a COMPILE error at {@link resolveSnapshotEnvVar}, so a typo
 * cannot pass silently as `undefined`. Sorted, so the table stays reviewable
 * (pinned by a test, like `PROVIDER_ENV_KEYS`).
 *
 * The `satisfies` clause is what makes it EXHAUSTIVE at compile time: every
 * `ProviderEnvKey` must have an `override` row, and the two non-override groups
 * must each answer with their own source. So registering a new var in
 * `PROVIDER_ENV_KEYS` without adding its row here does not compile, and the two
 * inventories cannot drift apart quietly.
 *
 * It exists because the env fingerprint has to report what a seam READS, not
 * what the var currently holds: with a threaded record, `overrides` / `platform`
 * / the resolved fields are the only three things a seam can answer from, and
 * each names a different slice of the environment. Before this table the
 * fingerprint kept a second, unlinked inventory of the same var names
 * (`session-cache.PROVIDER_ENV_VARS`) and read `process.env` directly, which is
 * exactly the pairing that lets a threaded record change what a provider parses
 * without invalidating its cached rows.
 */
export const ENV_VAR_SOURCES = {
  APPDATA: { kind: 'platform', field: 'appData' },
  CLAUDE_CONFIG_DIR: { kind: 'override' },
  CLAUDE_CONFIG_DIRS: { kind: 'override' },
  CODEWHALE_HOME: { kind: 'override' },
  CODEX_HOME: { kind: 'field', field: 'codexHome' },
  COLUMNS: { kind: 'override' },
  CRUSH_GLOBAL_DATA: { kind: 'override' },
  FACTORY_DIR: { kind: 'override' },
  HERMES_HOME: { kind: 'override' },
  KIMI_CODE_HOME: { kind: 'override' },
  LINGTAI_HOME: { kind: 'override' },
  LINGTAI_TUI_GLOBAL_DIR: { kind: 'override' },
  LINGTAI_TUI_HOME: { kind: 'override' },
  LOCALAPPDATA: { kind: 'platform', field: 'localAppData' },
  OPENCODE_DATA_DIR: { kind: 'override' },
  OPENCODE_DB_PREFIX: { kind: 'override' },
  QUICKWORK_HOME: { kind: 'override' },
  QWEN_DATA_DIR: { kind: 'override' },
  WARP_DB_PATH: { kind: 'override' },
  WATCHTOWER_CACHE_DIR: { kind: 'field', field: 'cacheDir' },
  WATCHTOWER_COPILOT_DISABLE_OTEL: { kind: 'override' },
  WATCHTOWER_COPILOT_GLOBAL_STORAGE_DIR: { kind: 'override' },
  WATCHTOWER_COPILOT_JETBRAINS_DIR: { kind: 'override' },
  WATCHTOWER_COPILOT_OTEL_DB: { kind: 'override' },
  WATCHTOWER_COPILOT_SESSION_STATE_DIR: { kind: 'override' },
  WATCHTOWER_COPILOT_SESSION_STORE_DB: { kind: 'override' },
  WATCHTOWER_COPILOT_WS_STORAGE_DIR: { kind: 'override' },
  WATCHTOWER_DESKTOP_SESSIONS_DIR: { kind: 'override' },
  WATCHTOWER_PROGRESS: { kind: 'override' },
  WATCHTOWER_VERBOSE: { kind: 'override' },
  XDG_CONFIG_HOME: { kind: 'platform', field: 'xdgConfigHome' },
  XDG_DATA_HOME: { kind: 'platform', field: 'xdgDataHome' },
} as const satisfies Readonly<Record<ProviderEnvKey, EnvVarSource>> &
  Readonly<Record<PlatformEnvVar, { kind: 'platform'; field: PlatformPathsField }>> &
  Readonly<Record<FieldEnvVar, { kind: 'field'; field: SnapshotFieldName }>>

/**
 * Every env var name the snapshot can answer, derived from the inventory — the
 * union a caller has to be inside of. Exported as the iterable form so the
 * coverage tests can walk the inventory without re-deriving its keys.
 */
export type SnapshotEnvVar = keyof typeof ENV_VAR_SOURCES

export const SNAPSHOT_ENV_VARS: readonly SnapshotEnvVar[] = Object.freeze(
  Object.keys(ENV_VAR_SOURCES) as SnapshotEnvVar[],
)

/**
 * The `overrides` lookup every `override` row shares. The one cast WIDENS the
 * overrides map's key type (`ProviderEnvKey`) to the inventory's union (which
 * also carries the platform and field names) so one lookup serves every row; the
 * inventory rows themselves are what keep a name from being mis-typed here,
 * because only a name with an `override` row reaches this function.
 */
function overrideValue(record: AppPaths, name: SnapshotEnvVar): string | undefined {
  return (record.overrides as Readonly<Partial<Record<SnapshotEnvVar, string>>>)[name]
}

/**
 * The expression a snapshot-driven INVENTORY READ uses — the third and last
 * `(paths ?? appPaths())` one-liner beside `overrideFor` / `platformFor`. Pure
 * and injectable like the two `resolve*` resolvers above: pass a record and it
 * answers from that record with no `process.env` at all, pass nothing and it
 * resolves the same ambient value the seam read before.
 *
 * It is the value the SEAM reads, so a `field`-shaped name answers with the
 * resolved field (never `''` for an unset var) while an `override` / `platform`
 * name answers with the raw string or `undefined`. A caller that has to hash the
 * answer — the session-cache env fingerprint — owns that `?? ''` choice
 * itself, because the choice differs per shape and is not this function's to
 * make.
 *
 * `overrideFor` / `platformFor` stay as they are: those are the two expressions
 * the provider seams use, and a seam never needs this one.
 */
export function resolveSnapshotEnvVar(name: SnapshotEnvVar, paths?: AppPaths): string | undefined {
  const record = paths ?? appPaths()
  const source: EnvVarSource | undefined = ENV_VAR_SOURCES[name]
  switch (source?.kind) {
    case 'platform':
      // `null` means "unset" and only `null` may mean that; the caller decides
      // what "unset" hashes as, so the raw `undefined` goes out.
      return record.platform[source.field] ?? undefined
    case 'field':
      return record[source.field]
    default:
      // `override`, and an unregistered name (reachable only through a cast):
      // the override map is the default lookup, so the answer is at worst the
      // same `undefined` an unset var gives — never a throw mid-scan. The
      // inventory-completeness test is what turns a real omission into a
      // failure rather than a quietly mis-hashed cache row.
      return overrideValue(record, name)
  }
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
//
// `platform` and `overrides` are read from the ambient env through their pure
// resolvers rather than threaded from boot: in one process the ambient env at
// read time IS what the reader saw before, so copying it at boot would add a
// second copy to keep in sync for no behavioral difference. The snapshot field
// is what lets a TEST inject a value (`initAppPaths({ overrides })`) instead of
// mutating `process.env`, and it is the slot a future boot-time pin would use.
let appPathsSnapshot: Partial<AppPaths> | null = null

/**
 * Boot-time snapshot init. REPLACES the record wholesale, so a field this call
 * omits falls back to its `process.env` value (that is how a test re-inits with
 * one field and keeps the rest honest).
 *
 * ORDERING CONSTRAINT: module bodies evaluate before any importer's body, so a
 * MODULE-LEVEL singleton that captured `appPaths()` at import time
 * (`providers/codex.ts:codex`) holds the value from BEFORE this call. Every
 * other seam resolves lazily inside the call, so it sees the record. A new
 * pinned field that a module-level singleton reads must therefore either make
 * that singleton lazy or be initialized before the provider registry loads.
 */
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
    overrides: appPathsSnapshot?.overrides ?? resolveProviderOverrides(readProcessEnv),
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
  return readOptionalEnv(name).pipe(Effect.map(resolve))
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
 *
 * `pricingCacheTtlMs` arrives from the live layer through
 * {@link resolvePricingCacheTtlMs}, so the live default is
 * {@link DEFAULT_PRICING_CACHE_TTL_MS} and not `Infinity`; the two fakes below
 * pin their own value because they bypass the parser on purpose.
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

  /**
   * The gateway-key-only convenience fake, for consumers that never touch the
   * pricing cache. Its `Infinity` is a hand-pinned value, NOT the default: a
   * gateway-key consumer does not want expiry semantics either way, and
   * threading the real default through here would couple this fake to a number
   * it has no reason to assert on.
   */
  static readonly layerWithGatewayKey = (vercelGatewayApiKey: string | null): Layer.Layer<Env> =>
    Env.layerWithValues({
      vercelGatewayApiKey,
      pricingCacheTtlMs: Infinity,
    })
}
