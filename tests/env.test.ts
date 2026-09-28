import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it } from 'vitest'

import {
  Env,
  initAppPaths,
  resolveCacheDir,
  resolveCodexHome,
  resolveCursorCacheSuppressWrites,
  resolveGatewayKey,
  resolvePricingCacheTtlMs,
} from '../src/main/env.js'

// The snapshot holder is module-global and this file never resets it — only
// re-inits. The uninitialized cases (default, env fallback) therefore run
// first, in definition order, before any `initAppPaths` call.
const ORIGINAL_CACHE_DIR: string | undefined = process.env['WATCHTOWER_CACHE_DIR']

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

afterEach(() => {
  if (ORIGINAL_CACHE_DIR === undefined) delete process.env['WATCHTOWER_CACHE_DIR']
  else process.env['WATCHTOWER_CACHE_DIR'] = ORIGINAL_CACHE_DIR
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

describe('Env layer carries the new fields (fake-only, zero env mutation)', () => {
  async function readNewFields(layer: ReturnType<typeof Env.layerWithValues>): Promise<{
    suppress: boolean
    home: string
  }> {
    return Effect.runPromise(
      Effect.gen(function* () {
        const env = yield* Env
        return { suppress: env.cursorCacheSuppressWrites, home: env.codexHome }
      }).pipe(Effect.provide(layer)),
    )
  }

  it('layerWithValues threads suppress + home through Env', async () => {
    await expect(
      readNewFields(
        Env.layerWithValues({
          vercelGatewayApiKey: null,
          pricingCacheTtlMs: Infinity,
          cursorCacheSuppressWrites: true,
          codexHome: '/fake/codex-home',
        }),
      ),
    ).resolves.toEqual({ suppress: true, home: '/fake/codex-home' })
  })

  it('layerWithGatewayKey defaults suppress=false and the homedir default', async () => {
    await expect(readNewFields(Env.layerWithGatewayKey('test-key'))).resolves.toEqual({
      suppress: false,
      home: join(homedir(), '.codex'),
    })
  })
})
