import { mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it } from 'vitest'

import {
  type AppPaths,
  appPaths,
  Env,
  initAppPaths,
  overrideFor,
  platformFor,
  type PlatformPaths,
  PROVIDER_ENV_KEYS,
  type ProviderOverrides,
  resolveCacheDir,
  resolveCodexHome,
  resolveCursorCacheSuppressWrites,
  resolveGatewayKey,
  REMAINING_DIRECT_ENV_READS,
  resolvePlatformPaths,
  resolvePricingCacheTtlMs,
  resolveProviderOverrides,
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

  it('resolvePricingCacheTtlMs keeps absent/unparseable/non-positive → Infinity', () => {
    expect(resolvePricingCacheTtlMs(undefined)).toBe(Infinity)
    expect(resolvePricingCacheTtlMs('nope')).toBe(Infinity)
    expect(resolvePricingCacheTtlMs('-2')).toBe(Infinity)
    expect(resolvePricingCacheTtlMs('0')).toBe(Infinity)
    expect(resolvePricingCacheTtlMs('2')).toBe(2 * 60 * 60 * 1000)
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
