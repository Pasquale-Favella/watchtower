import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Env } from '../src/infrastructure/config/environment.js'
import { HttpFetch } from '../src/infrastructure/ingestion/fetch-utils.js'
const hooks = vi.hoisted(() => ({
  events: [] as string[],
  discovered: vi.fn(),
}))

vi.mock('fs/promises', () => ({
  lstat: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
}))

vi.mock('../src/infrastructure/provider-adapters/index.js', () => ({
  discoverAllSessionsEffect: (...args: unknown[]) =>
    Effect.tryPromise({
      try: () => hooks.discovered(...args) as Promise<unknown>,
      catch: cause => cause as Error,
    }),
}))

vi.mock('../src/infrastructure/ingestion/session-cache.js', async () => {
  const Effect = await import('effect/Effect')
  const cache = { version: 7, complete: true, providers: {} }
  return {
    beginColdHydrationEffect: vi.fn(),
    cleanupOrphanedTempFilesEffect: vi.fn(() => Effect.sync(() => hooks.events.push('cleanup'))),
    computeEnvFingerprint: vi.fn(() => 'test-env'),
    DURABLE_PROVIDER_NAMES: new Set(),
    fingerprintFile: vi.fn(),
    isCacheComplete: (value: { complete?: boolean }) => value.complete === true,
    loadCacheEffect: vi.fn(() =>
      Effect.sync(() => {
        hooks.events.push('load')
        return cache
      }),
    ),
    reconcileFile: vi.fn(),
    saveCache: vi.fn(),
    saveCacheEffect: vi.fn(),
    sectionNeedsPrEvidenceReparse: vi.fn(() => false),
  }
})

vi.mock('../src/infrastructure/ingestion/cache-refresh-lock.js', async () => {
  const Effect = await import('effect/Effect')
  return {
    acquireCacheRefreshLockEffect: vi.fn(() =>
      Effect.sync(() => {
        hooks.events.push('refresh-lock')
        return { outcome: 'completed-by-other' as const }
      }),
    ),
  }
})

import { clearSessionCache, parseAllSessionsEffect } from '../src/infrastructure/ingestion/parser.js'

describe('parser Effect workflow', () => {
  afterEach(() => {
    clearSessionCache()
    hooks.events = []
    hooks.discovered.mockReset()
  })

  it('loads, cleans, and reconciles through composed cache and discovery Effects', async () => {
    hooks.discovered.mockImplementation(async () => {
      hooks.events.push('discover')
      return []
    })

    const result = await Effect.runPromise(
      parseAllSessionsEffect().pipe(
        Effect.provide(Env.layer),
        Effect.provide(HttpFetch.layerWithFetch(globalThis.fetch)),
        Effect.provide(NodeFileSystem.layer),
      ),
    )

    expect(result).toEqual([])
    expect(hooks.events).toEqual(['load', 'cleanup', 'refresh-lock', 'load', 'discover'])
  })
})
