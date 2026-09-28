import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { initAppPaths, resolveCacheDir, resolveGatewayKey, resolvePricingCacheTtlMs } from '../src/main/env.js'

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
