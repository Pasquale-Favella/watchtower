import { mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it } from 'vitest'

import {
  type AppPaths,
  appPaths,
  DEFAULT_PRICING_CACHE_TTL_MS,
  Env,
  ENV_VAR_SOURCES,
  initAppPaths,
  overrideFor,
  platformFor,
  type PlatformPaths,
  PROVIDER_ENV_KEYS,
  type ProviderOverrides,
  REMAINING_DIRECT_ENV_READS,
  resolveCacheDir,
  resolveCodexHome,
  resolveCursorCacheSuppressWrites,
  resolveGatewayKey,
  resolvePlatformPaths,
  resolvePricingCacheTtlMs,
  resolveProviderOverrides,
  resolveSnapshotEnvVar,
  SNAPSHOT_ENV_VARS,
  type SnapshotEnvVar,
} from '../src/main/env.js'

/** Repo root, for the one case that reads a source file to check a claim. */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// The snapshot holder is module-global and this file never resets it — only
// re-inits. Every case that asserts an UNINITIALIZED fallback therefore has to
// run before the first `initAppPaths` call: that is why the `appPaths()` and
// `resolveCacheDir` fallback cases are the first two blocks in the file.
// Vitest runs `describe` bodies in order and these cases are sequential sync
// `it`s, so definition order is execution order.
const ORIGINAL_ENV: Readonly<Record<string, string | undefined>> = {
  cacheDir: process.env['WATCHTOWER_CACHE_DIR'],
  codexHome: process.env['CODEX_HOME'],
  suppress: process.env['WATCHTOWER_SUPPRESS_CACHE_WRITES'],
  appData: process.env['APPDATA'],
  localAppData: process.env['LOCALAPPDATA'],
  xdgConfig: process.env['XDG_CONFIG_HOME'],
  xdgData: process.env['XDG_DATA_HOME'],
}

/** Every platform root unset — the shape `null` (never `''`) produces, and
 *  the starting point the per-root cases override one field at a time. */
const NO_PLATFORM: PlatformPaths = {
  appData: null,
  localAppData: null,
  xdgConfigHome: null,
  xdgDataHome: null,
}

/** The `CODEX_HOME` the env-fallback cases plant, so "the snapshot beats
 *  env" is readable as a comparison against one value. */
const ENV_CODEX_HOME = '/env/codex-home'

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** A minimal `AppPaths` for the seam-helper cases: the fields they read are the
 *  ones passed, everything else falls back to the ambient env like production. */
function appPathsOf(overrides: ProviderOverrides, platform: PlatformPaths = appPaths().platform): AppPaths {
  return { ...appPaths(), overrides, platform }
}

// Static keys: the restore path uses literal assignments/deletes rather than a
// loop so it adds no `no-dynamic-delete` warning to the baseline.
afterEach(() => {
  if (ORIGINAL_ENV.cacheDir === undefined) delete process.env['WATCHTOWER_CACHE_DIR']
  else process.env['WATCHTOWER_CACHE_DIR'] = ORIGINAL_ENV.cacheDir

  if (ORIGINAL_ENV.codexHome === undefined) delete process.env['CODEX_HOME']
  else process.env['CODEX_HOME'] = ORIGINAL_ENV.codexHome

  if (ORIGINAL_ENV.suppress === undefined) delete process.env['WATCHTOWER_SUPPRESS_CACHE_WRITES']
  else process.env['WATCHTOWER_SUPPRESS_CACHE_WRITES'] = ORIGINAL_ENV.suppress

  if (ORIGINAL_ENV.appData === undefined) delete process.env['APPDATA']
  else process.env['APPDATA'] = ORIGINAL_ENV.appData

  if (ORIGINAL_ENV.localAppData === undefined) delete process.env['LOCALAPPDATA']
  else process.env['LOCALAPPDATA'] = ORIGINAL_ENV.localAppData

  if (ORIGINAL_ENV.xdgConfig === undefined) delete process.env['XDG_CONFIG_HOME']
  else process.env['XDG_CONFIG_HOME'] = ORIGINAL_ENV.xdgConfig

  if (ORIGINAL_ENV.xdgData === undefined) delete process.env['XDG_DATA_HOME']
  else process.env['XDG_DATA_HOME'] = ORIGINAL_ENV.xdgData
})

// The `AppPaths` snapshot seam: one record for every sync provider-home /
// platform-path reader. Its uninitialized cases replace the `Env`
// codexHome/suppress cases Wave 8 added — same values, reachable seam
// (`appPaths()`) instead of an `Env` field no Effect consumer ever read.
describe('appPaths() — uninitialized snapshot falls back to env', () => {
  it('derives every field from the same pure resolvers the readers use', () => {
    const dir = makeTempDir('tr-paths-fallback-')
    process.env['WATCHTOWER_CACHE_DIR'] = dir
    process.env['CODEX_HOME'] = ENV_CODEX_HOME
    process.env['WATCHTOWER_SUPPRESS_CACHE_WRITES'] = '1'
    delete process.env['APPDATA']
    delete process.env['LOCALAPPDATA']
    delete process.env['XDG_CONFIG_HOME']
    delete process.env['XDG_DATA_HOME']
    expect(appPaths()).toMatchObject({
      cacheDir: dir,
      codexHome: ENV_CODEX_HOME,
      suppressCacheWrites: true,
      platform: NO_PLATFORM,
    })
    // `overrides` is asserted on its own below: it mirrors whatever the ambient
    // provider vars hold, so pinning it here would make this case depend on the
    // machine's env.
    expect(appPaths().overrides).toEqual(resolveProviderOverrides(name => process.env[name]))
  })

  it('cacheDir/codexHome resolve their homedir defaults when env is absent', () => {
    delete process.env['WATCHTOWER_CACHE_DIR']
    delete process.env['CODEX_HOME']
    delete process.env['WATCHTOWER_SUPPRESS_CACHE_WRITES']
    const paths = appPaths()
    expect(paths.cacheDir).toBe(join(homedir(), '.cache', 'watchtower'))
    expect(paths.codexHome).toBe(join(homedir(), '.codex'))
    expect(paths.suppressCacheWrites).toBe(false)
  })

  it('platform roots are read straight from process.env by the injected reader', () => {
    process.env['APPDATA'] = '/roaming'
    process.env['LOCALAPPDATA'] = '/local'
    process.env['XDG_CONFIG_HOME'] = '/xdg-config'
    process.env['XDG_DATA_HOME'] = '/xdg-data'
    expect(appPaths().platform).toEqual({
      appData: '/roaming',
      localAppData: '/local',
      xdgConfigHome: '/xdg-config',
      xdgDataHome: '/xdg-data',
    })
  })
})

describe('resolveCacheDir (startup snapshot)', () => {
  it('default: neither snapshot nor env resolves the homedir path', () => {
    delete process.env['WATCHTOWER_CACHE_DIR']
    expect(resolveCacheDir()).toBe(join(homedir(), '.cache', 'watchtower'))
  })

  it('fallback: env is honored when uninitialized', () => {
    const dir = makeTempDir('tr-env-fallback-')
    process.env['WATCHTOWER_CACHE_DIR'] = dir
    expect(resolveCacheDir()).toBe(dir)
  })

  it('precedence: initialized snapshot beats env', () => {
    const snapshot = makeTempDir('tr-env-snapshot-')
    const envDir = makeTempDir('tr-env-other-')
    initAppPaths({ cacheDir: snapshot })
    process.env['WATCHTOWER_CACHE_DIR'] = envDir
    expect(resolveCacheDir()).toBe(snapshot)
  })

  it('snapshot survives env deletion', () => {
    const snapshot = makeTempDir('tr-env-survives-')
    initAppPaths({ cacheDir: snapshot })
    delete process.env['WATCHTOWER_CACHE_DIR']
    expect(resolveCacheDir()).toBe(snapshot)
  })

  it('re-init overwrites deterministically', () => {
    const first = makeTempDir('tr-env-first-')
    const second = makeTempDir('tr-env-second-')
    initAppPaths({ cacheDir: first })
    expect(resolveCacheDir()).toBe(first)
    initAppPaths({ cacheDir: second })
    expect(resolveCacheDir()).toBe(second)
  })
})

describe('gateway/TTL seams unaffected by the snapshot', () => {
  it('resolveGatewayKey keeps trim/empty semantics', () => {
    expect(resolveGatewayKey('  test-key  ', undefined)).toBe('test-key')
    expect(resolveGatewayKey('', undefined)).toBeNull()
    expect(resolveGatewayKey(undefined, 'fallback')).toBe('fallback')
    // Empty primary blocks the fallback (legacy `??` parity): never fall through.
    expect(resolveGatewayKey('', 'fallback')).toBeNull()
  })

  it('resolvePricingCacheTtlMs falls back to the finite default, and a positive value converts', () => {
    // Absent/unparseable/non-positive all resolve to the default rather than
    // `Infinity`. An immortal price cache was the defect: a machine that first
    // launched offline kept the bundled snapshot forever with no way to
    // revalidate. ADR 0033.
    expect(resolvePricingCacheTtlMs(undefined)).toBe(DEFAULT_PRICING_CACHE_TTL_MS)
    expect(resolvePricingCacheTtlMs('nope')).toBe(DEFAULT_PRICING_CACHE_TTL_MS)
    expect(resolvePricingCacheTtlMs('-2')).toBe(DEFAULT_PRICING_CACHE_TTL_MS)
    expect(resolvePricingCacheTtlMs('0')).toBe(DEFAULT_PRICING_CACHE_TTL_MS)
    // The default is a default, not a ceiling: an operator wanting a longer
    // cache still gets one.
    expect(resolvePricingCacheTtlMs('2')).toBe(2 * 60 * 60 * 1000)
    expect(DEFAULT_PRICING_CACHE_TTL_MS).toBeLessThan(Infinity)
  })
})

describe('resolveCursorCacheSuppressWrites (sync seam, truthiness parity)', () => {
  it('absent/empty does not suppress', () => {
    expect(resolveCursorCacheSuppressWrites(undefined)).toBe(false)
    expect(resolveCursorCacheSuppressWrites('')).toBe(false)
  })

  it('any set value suppresses (no trim — legacy `if` parity)', () => {
    expect(resolveCursorCacheSuppressWrites('1')).toBe(true)
    // '0' is truthy in JS: the legacy check suppressed on it too.
    expect(resolveCursorCacheSuppressWrites('0')).toBe(true)
    expect(resolveCursorCacheSuppressWrites('   ')).toBe(true)
  })
})

describe('resolveCodexHome (single-provider exemplar, ?? parity)', () => {
  it('falls back to the homedir default when unset', () => {
    expect(resolveCodexHome(undefined)).toBe(join(homedir(), '.codex'))
  })

  it('honors the CODEX_HOME value verbatim (no trim/empty skip)', () => {
    expect(resolveCodexHome('/custom/home')).toBe('/custom/home')
    expect(resolveCodexHome('')).toBe('')
  })

  it('explicit override wins over env', () => {
    expect(resolveCodexHome('/env/home', '/override')).toBe('/override')
    expect(resolveCodexHome(undefined, '/override')).toBe('/override')
  })
})

describe('appPaths() — initialized snapshot wins per field', () => {
  it('initialized fields beat env; an initialized field never leaks env back in', () => {
    const snapshot = makeTempDir('tr-paths-mixed-')
    process.env['WATCHTOWER_CACHE_DIR'] = makeTempDir('tr-paths-env-')
    process.env['CODEX_HOME'] = ENV_CODEX_HOME
    process.env['WATCHTOWER_SUPPRESS_CACHE_WRITES'] = '1'
    process.env['XDG_DATA_HOME'] = '/env/xdg-data'
    initAppPaths({
      cacheDir: snapshot,
      codexHome: '/fake/codex-home',
      // Explicitly `false` beats the truthy env value: the snapshot is the
      // value, not a hint.
      suppressCacheWrites: false,
      platform: NO_PLATFORM,
      overrides: { CLAUDE_CONFIG_DIR: '/fake/claude' },
    })
    expect(appPaths()).toEqual({
      cacheDir: snapshot,
      codexHome: '/fake/codex-home',
      suppressCacheWrites: false,
      platform: NO_PLATFORM,
      overrides: { CLAUDE_CONFIG_DIR: '/fake/claude' },
    })
    // The injected override reaches the seam helper with no `process.env` at all.
    expect(overrideFor(undefined, 'CLAUDE_CONFIG_DIR')).toBe('/fake/claude')
    expect(platformFor(undefined)).toEqual(NO_PLATFORM)
  })

  it('re-init replaces the whole record deterministically (no field bleed)', () => {
    const first = makeTempDir('tr-paths-reinit-a-')
    const second = makeTempDir('tr-paths-reinit-b-')
    process.env['CODEX_HOME'] = ENV_CODEX_HOME
    initAppPaths({ cacheDir: first, codexHome: '/first/home', suppressCacheWrites: true })
    expect(appPaths().codexHome).toBe('/first/home')
    expect(appPaths().suppressCacheWrites).toBe(true)
    // The second init omits codexHome/suppress entirely: they must fall back to
    // the env-derived value, not inherit the first record.
    initAppPaths({ cacheDir: second })
    expect(appPaths().cacheDir).toBe(second)
    expect(appPaths().codexHome).toBe(ENV_CODEX_HOME)
  })

  it('partial init leaves untouched fields on their env fallback', () => {
    const dir = makeTempDir('tr-paths-partial-')
    process.env['WATCHTOWER_CACHE_DIR'] = dir
    process.env['WATCHTOWER_SUPPRESS_CACHE_WRITES'] = '0'
    delete process.env['CODEX_HOME']
    initAppPaths({ cacheDir: makeTempDir('tr-paths-partial-snap-') })
    // `'0'` is truthy in JS: still suppresses, exactly like the legacy `if`.
    expect(appPaths().suppressCacheWrites).toBe(true)
    expect(appPaths().codexHome).toBe(join(homedir(), '.codex'))
  })
})

describe('resolvePlatformPaths (pure, injected reader)', () => {
  it('reads the four platform roots from the injected reader', () => {
    const env: Record<string, string> = {
      APPDATA: '/roaming',
      LOCALAPPDATA: '/local',
      XDG_CONFIG_HOME: '/xdg-config',
      XDG_DATA_HOME: '/xdg-data',
    }
    const read = (name: string): string | undefined => env[name]
    expect(resolvePlatformPaths(read)).toEqual({
      appData: '/roaming',
      localAppData: '/local',
      xdgConfigHome: '/xdg-config',
      xdgDataHome: '/xdg-data',
    })
  })

  it('absent roots normalize to null; each name is read exactly once', () => {
    const seen: string[] = []
    const read = (name: string): string | undefined => {
      seen.push(name)
      return undefined
    }
    expect(resolvePlatformPaths(read)).toEqual(NO_PLATFORM)
    expect(seen.sort()).toEqual(['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'])
  })

  it('empty strings pass through verbatim, NOT normalized to null (?? parity)', () => {
    // Every platform reader reaches these with `??` (copilot.ts:317,
    // crush.ts:37/41, ibm-bob.ts:22/28, open-design.ts:88, goose.ts:60,
    // kilo-code.ts:16, opencode.ts:42, zerostack.ts:54), where `''` is a real
    // value. `resolvePlatformPaths` reports; the reader keeps its own
    // normalization (copilot.ts:352 rejects empty/relative XDG_CONFIG_HOME,
    // claude.ts:133-137 trims APPDATA/LOCALAPPDATA).
    const env: Record<string, string> = {
      APPDATA: '',
      LOCALAPPDATA: '',
      XDG_CONFIG_HOME: '',
      XDG_DATA_HOME: '',
    }
    const read = (name: string): string | undefined => env[name]
    expect(resolvePlatformPaths(read)).toEqual({
      appData: '',
      localAppData: '',
      xdgConfigHome: '',
      xdgDataHome: '',
    })
  })

  it('a partial injected reader leaves the names it does not know as null', () => {
    const read = (name: string): string | undefined => (name === 'XDG_DATA_HOME' ? '/only-this' : undefined)
    expect(resolvePlatformPaths(read)).toEqual({ ...NO_PLATFORM, xdgDataHome: '/only-this' })
  })
})

describe('resolveProviderOverrides + overrideFor/platformFor (rollout step 1)', () => {
  it('reads exactly the listed keys, once each, and drops only undefined', () => {
    const seen: string[] = []
    const env: Record<string, string> = {
      CLAUDE_CONFIG_DIRS: '/a:/b',
      // An empty value is DEFINED: the readers disagree (`??` uses `''`
      // verbatim, `||` treats it as unset), so the snapshot reports it as-is.
      WATCHTOWER_COPILOT_OTEL_DB: '',
      OPENCODE_DB_PREFIX: 'opencode',
    }
    const read = (name: string): string | undefined => {
      seen.push(name)
      return env[name]
    }
    expect(resolveProviderOverrides(read)).toEqual({
      CLAUDE_CONFIG_DIRS: '/a:/b',
      OPENCODE_DB_PREFIX: 'opencode',
      WATCHTOWER_COPILOT_OTEL_DB: '',
    })
    expect(seen.sort()).toEqual([...PROVIDER_ENV_KEYS].sort())
    expect(seen).toHaveLength(PROVIDER_ENV_KEYS.length)
  })

  it('an empty injected reader yields an empty record (nothing invented)', () => {
    expect(resolveProviderOverrides(() => undefined)).toEqual({})
  })

  it('the key list is sorted and unique, so it stays reviewable', () => {
    expect([...PROVIDER_ENV_KEYS]).toEqual([...PROVIDER_ENV_KEYS].slice().sort())
    expect(new Set(PROVIDER_ENV_KEYS).size).toBe(PROVIDER_ENV_KEYS.length)
  })

  it('overrideFor prefers a threaded record and otherwise reads the ambient env', () => {
    const threaded = appPathsOf({ CLAUDE_CONFIG_DIR: '/threaded' })
    expect(overrideFor(threaded, 'CLAUDE_CONFIG_DIR')).toBe('/threaded')
    // A threaded record REPLACES the overrides map, it does not merge with the
    // ambient env: a key it does not carry is `undefined`, exactly what
    // `process.env[missing]` would have been. Pinned with a value the machine may
    // or may not actually set, so the assertion cannot depend on the host.
    process.env['CRUSH_GLOBAL_DATA'] = '/ambient/crush'
    try {
      expect(overrideFor(threaded, 'CRUSH_GLOBAL_DATA')).toBeUndefined()
      // No record threaded: the same value the seam read from `process.env` before.
      expect(overrideFor(undefined, 'CRUSH_GLOBAL_DATA')).toBe('/ambient/crush')
      expect(overrideFor(undefined, 'CLAUDE_CONFIG_DIR')).toBe(process.env['CLAUDE_CONFIG_DIR'])
    } finally {
      delete process.env['CRUSH_GLOBAL_DATA']
    }
  })

  it('platformFor prefers a threaded record and otherwise reads the ambient env', () => {
    expect(platformFor(appPathsOf({}, NO_PLATFORM))).toEqual(NO_PLATFORM)
    expect(platformFor(undefined)).toEqual(appPaths().platform)
  })

  it('the fingerprint-only vars are registered, so the union covers what seams read', () => {
    // `PROVIDER_ENV_VARS` in session-cache named fourteen vars that no
    // `ProviderEnvKey` registered, which is why the fingerprint needed its own
    // inventory. These are the ten override-shaped ones; the four that are NOT
    // override-shaped (`XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `CODEX_HOME`,
    // `WATCHTOWER_CACHE_DIR`) are platform roots or resolved snapshot fields,
    // asserted separately below.
    for (const key of [
      'CODEWHALE_HOME',
      'FACTORY_DIR',
      'HERMES_HOME',
      'KIMI_CODE_HOME',
      'LINGTAI_HOME',
      'LINGTAI_TUI_GLOBAL_DIR',
      'LINGTAI_TUI_HOME',
      'QWEN_DATA_DIR',
      'QUICKWORK_HOME',
      'WARP_DB_PATH',
    ] as const) {
      expect(PROVIDER_ENV_KEYS).toContain(key)
      expect(ENV_VAR_SOURCES[key]).toEqual({ kind: 'override' })
    }
  })

  it('every listed remaining direct read really is a direct read (the list is not a wish)', () => {
    // The registry is the seam's honesty check: an entry that no longer matches
    // the file makes this fail, so the snapshot can never quietly stop being
    // the single source of truth for a key it claims to own.
    for (const [relativePath, keys] of Object.entries(REMAINING_DIRECT_ENV_READS)) {
      const source = readFileSync(join(repoRoot, 'src', 'main', 'pipeline', relativePath), 'utf8')
      for (const key of keys) {
        expect(source, `${relativePath} must still read ${key} directly`).toContain(`process.env['${key}']`)
        // A key the snapshot already carries must never appear here.
        expect(PROVIDER_ENV_KEYS).toContain(key)
      }
    }
  })
})

// ── ENV_VAR_SOURCES + resolveSnapshotEnvVar (one inventory, three sources) ──
describe('ENV_VAR_SOURCES + resolveSnapshotEnvVar (which source answers a name)', () => {
  /** A record carrying only what the case plants. The answer comes from the
   *  PLANTED fields, so this file writes no env var and no case depends on what
   *  the host machine happens to export. */
  function recordOf(fields: Partial<AppPaths> = {}): AppPaths {
    return { ...appPaths(), ...fields }
  }

  it('the inventory is sorted, unique, and holds a row per registered key', () => {
    expect([...SNAPSHOT_ENV_VARS]).toEqual([...SNAPSHOT_ENV_VARS].slice().sort())
    expect(new Set(SNAPSHOT_ENV_VARS).size).toBe(SNAPSHOT_ENV_VARS.length)
    // Compile-time exhaustive (the `satisfies` clause on ENV_VAR_SOURCES); this
    // is the runtime half of the same claim.
    for (const key of PROVIDER_ENV_KEYS) expect(ENV_VAR_SOURCES[key]).toEqual({ kind: 'override' })
  })

  it('the three groups are disjoint: a name answers from exactly one source', () => {
    const overrideNames = SNAPSHOT_ENV_VARS.filter(name => ENV_VAR_SOURCES[name].kind === 'override')
    const platformNames = SNAPSHOT_ENV_VARS.filter(name => ENV_VAR_SOURCES[name].kind === 'platform')
    const fieldNames = SNAPSHOT_ENV_VARS.filter(name => ENV_VAR_SOURCES[name].kind === 'field')
    // An override name is a `ProviderEnvKey`, so it can never also be a
    // platform root or a field var: the groups partition the inventory.
    expect(overrideNames.slice().sort()).toEqual([...PROVIDER_ENV_KEYS].sort())
    expect(platformNames.slice().sort()).toEqual(['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'].sort())
    expect(fieldNames.slice().sort()).toEqual(['CODEX_HOME', 'WATCHTOWER_CACHE_DIR'])
    expect(new Set([...platformNames, ...fieldNames]).size).toBe(platformNames.length + fieldNames.length)
  })

  it('an override-shaped name answers from `overrides`, verbatim', () => {
    const record = recordOf({ overrides: { CLAUDE_CONFIG_DIR: '/threaded/claude', COLUMNS: '' } })
    expect(resolveSnapshotEnvVar('CLAUDE_CONFIG_DIR', record)).toBe('/threaded/claude')
    // An empty override is DEFINED, not "unset": the snapshot reports the raw
    // string and the consumer decides (the `?? ''` in the fingerprint is its
    // own choice, the `!== ''` in claude.ts is the seam's).
    expect(resolveSnapshotEnvVar('COLUMNS', record)).toBe('')
    // A threaded record REPLACES the overrides map, so a key it does not carry
    // is `undefined` even if the ambient env has it.
    expect(resolveSnapshotEnvVar('WATCHTOWER_VERBOSE', record)).toBeUndefined()
  })

  it('a platform-shaped name answers from `platform`, with null meaning unset', () => {
    const record = recordOf({ platform: { ...NO_PLATFORM, xdgDataHome: '/threaded/xdg-data' } })
    expect(resolveSnapshotEnvVar('XDG_DATA_HOME', record)).toBe('/threaded/xdg-data')
    // `null` is "unset" and only `null` may be — the resolver reports it as
    // `undefined` (not `''`), leaving the consumer to choose. Which is what
    // keeps an unset platform root hashing as `''` in the fingerprint.
    expect(resolveSnapshotEnvVar('XDG_CONFIG_HOME', record)).toBeUndefined()
    // An empty platform value is a real value (every reader reaches it with
    // `??`), so it survives.
    expect(resolveSnapshotEnvVar('APPDATA', recordOf({ platform: { ...NO_PLATFORM, appData: '' } }))).toBe('')
  })

  it('a field-shaped name answers from the RESOLVED field, not the raw var', () => {
    // This is the shape the pre-snapshot fingerprint could not express: these
    // two seams read the resolved field, so a threaded `cacheDir` / `codexHome`
    // must move the answer even with no env var set.
    const record = recordOf({ cacheDir: '/threaded/cache', codexHome: '/threaded/codex' })
    expect(resolveSnapshotEnvVar('WATCHTOWER_CACHE_DIR', record)).toBe('/threaded/cache')
    expect(resolveSnapshotEnvVar('CODEX_HOME', record)).toBe('/threaded/codex')
    // A field is never "unset": the resolver has already applied the default.
    const defaulted = recordOf({ codexHome: join(homedir(), '.codex') })
    expect(resolveSnapshotEnvVar('CODEX_HOME', defaulted)).toBe(join(homedir(), '.codex'))
  })

  it('each platform/field var maps to the field its own seam reads', () => {
    // The pairs are the claim: a `PlatformPaths` / `AppPaths` field renamed
    // without updating the inventory fails the `satisfies` clause first and
    // this case second.
    const expected: Readonly<Record<string, { kind: string; field: string }>> = {
      APPDATA: { kind: 'platform', field: 'appData' },
      LOCALAPPDATA: { kind: 'platform', field: 'localAppData' },
      XDG_CONFIG_HOME: { kind: 'platform', field: 'xdgConfigHome' },
      XDG_DATA_HOME: { kind: 'platform', field: 'xdgDataHome' },
      CODEX_HOME: { kind: 'field', field: 'codexHome' },
      WATCHTOWER_CACHE_DIR: { kind: 'field', field: 'cacheDir' },
    }
    for (const [name, source] of Object.entries(expected)) {
      expect(ENV_VAR_SOURCES[name as SnapshotEnvVar], name).toEqual(source)
    }
  })

  it('a threaded record answers with no ambient env at all (the seam reads the record)', () => {
    // The strongest form of the claim: every inventory name resolves from this
    // one planted record, so a stale ambient value cannot leak into any of them.
    const planted: AppPaths = {
      cacheDir: '/p/cacheDir',
      codexHome: '/p/codexHome',
      suppressCacheWrites: true,
      platform: {
        appData: '/p/appData',
        localAppData: '/p/localAppData',
        xdgConfigHome: '/p/xdgConfigHome',
        xdgDataHome: '/p/xdgDataHome',
      },
      overrides: Object.fromEntries(PROVIDER_ENV_KEYS.map(key => [key, `/p/${key}`])) as ProviderOverrides,
    }
    for (const name of SNAPSHOT_ENV_VARS) {
      const source = ENV_VAR_SOURCES[name]
      const expected = source.kind === 'override' ? `/p/${name}` : `/p/${source.field}`
      expect(resolveSnapshotEnvVar(name, planted), name).toBe(expected)
    }
  })

  it('an unregistered name falls through to the override map rather than throwing', () => {
    // Unreachable through the typed surface (`name: SnapshotEnvVar`), reachable
    // through a cast from a `string[]`. A mid-scan throw would be worse than a
    // value the coverage test flags, so the default branch answers `undefined`.
    const record = recordOf({ overrides: {} })
    expect(resolveSnapshotEnvVar('TOTALLY_UNREGISTERED_VAR' as SnapshotEnvVar, record)).toBeUndefined()
  })

  it('overrideFor/platformFor are unchanged (the inventory does not refactor the seams)', () => {
    const record = appPathsOf({ CLAUDE_CONFIG_DIR: '/threaded' }, NO_PLATFORM)
    expect(overrideFor(record, 'CLAUDE_CONFIG_DIR')).toBe('/threaded')
    expect(platformFor(record)).toEqual(NO_PLATFORM)
  })
})

describe('Env layer carries exactly its two Effect-reachable fields', () => {
  async function readEnv(layer: ReturnType<typeof Env.layerWithValues>): Promise<Env['Service']> {
    return Effect.runPromise(
      Effect.gen(function* () {
        return yield* Env
      }).pipe(Effect.provide(layer)),
    )
  }

  it('layerWithValues threads the gateway key + TTL, and nothing else', async () => {
    await expect(
      readEnv(
        Env.layerWithValues({
          vercelGatewayApiKey: 'test-key',
          pricingCacheTtlMs: 1234,
        }),
      ),
    ).resolves.toEqual({ vercelGatewayApiKey: 'test-key', pricingCacheTtlMs: 1234 })
  })

  it('layerWithGatewayKey defaults the TTL to Infinity', async () => {
    await expect(readEnv(Env.layerWithGatewayKey('test-key'))).resolves.toEqual({
      vercelGatewayApiKey: 'test-key',
      pricingCacheTtlMs: Infinity,
    })
  })

  it('the removed fields are gone from the service shape', async () => {
    // Wave 8 carried `cursorCacheSuppressWrites` / `codexHome` on `Env`, but
    // their only readers are sync discovery paths, so no `yield* Env` consumer
    // existed. They moved to `AppPaths` (`appPaths().suppressCacheWrites` /
    // `.codexHome`), and the service is back to what an Effect can read.
    const env = await readEnv(Env.layerWithGatewayKey(null))
    expect(Object.keys(env).sort()).toEqual(['pricingCacheTtlMs', 'vercelGatewayApiKey'])
  })
})
