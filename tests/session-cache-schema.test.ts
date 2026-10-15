import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Schema from 'effect/Schema'
import { afterEach, describe, expect, it } from 'vitest'

import { loadCache, saveCache, sessionCachePath } from '../src/main/pipeline/session-cache.js'
import { sessionCacheSchema } from '../src/shared/schemas/session-cache.js'
import { buildFixtureCachedFile } from './fixtures/cached-file.js'

const ORIGINAL_CACHE_DIR = process.env['WATCHTOWER_CACHE_DIR']
const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (ORIGINAL_CACHE_DIR === undefined) delete process.env['WATCHTOWER_CACHE_DIR']
  else process.env['WATCHTOWER_CACHE_DIR'] = ORIGINAL_CACHE_DIR
})

function useCacheDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  process.env['WATCHTOWER_CACHE_DIR'] = dir
  return dir
}

describe('session cache Effect Schema decoding at load boundaries', () => {
  it('strips unknown keys while retaining valid cached facts', async () => {
    useCacheDir('tr-cache-schema-current-')
    const file = buildFixtureCachedFile() as unknown as Record<string, unknown>
    file['futureFileField'] = 'ignored'
    const turn = (file['turns'] as Array<Record<string, unknown>>)[0]
    if (!turn) throw new Error('fixture has no turn')
    turn['futureTurnField'] = true
    const cache = {
      version: 7,
      futureCacheField: true,
      providers: {
        demo: {
          envFingerprint: 'env-1',
          futureProviderField: true,
          files: { '/demo.jsonl': file },
        },
      },
    }
    writeFileSync(sessionCachePath(), JSON.stringify(cache))

    const loaded = await loadCache()
    expect(loaded.providers['demo']?.files['/demo.jsonl']?.turns[0]?.userMessage).toBe('Refactor the auth module')
    expect(loaded).not.toHaveProperty('futureCacheField')
    expect(loaded.providers['demo']).not.toHaveProperty('futureProviderField')
    expect(loaded.providers['demo']?.files['/demo.jsonl']).not.toHaveProperty('futureFileField')
    expect(loaded.providers['demo']?.files['/demo.jsonl']?.turns[0]).not.toHaveProperty('futureTurnField')
  })

  it('decodes and rewrites a valid legacy cache through the same stripping schema', async () => {
    const dir = useCacheDir('tr-cache-schema-legacy-')
    const file = buildFixtureCachedFile() as unknown as Record<string, unknown>
    file['futureFileField'] = 'ignored'
    const legacyText = JSON.stringify({
      version: 7,
      complete: 1,
      providers: {
        demo: {
          envFingerprint: 'env-1',
          durable: 0,
          prEvidenceV1: 'true',
          files: { '/demo.jsonl': file },
        },
      },
    })
    writeFileSync(join(dir, 'session-cache.json'), legacyText)

    const loaded = await loadCache()
    expect(loaded.providers['demo']?.files['/demo.jsonl']?.turns[0]?.calls[0]?.model).toBe('demo-model')
    expect(loaded.complete).toBe(false)
    expect(loaded.providers['demo']?.durable).toBe(false)
    expect(loaded.providers['demo']?.prEvidenceV1).toBe(false)
    expect(loaded.providers['demo']?.files['/demo.jsonl']).not.toHaveProperty('futureFileField')
    const rewritten = JSON.parse(readFileSync(sessionCachePath(), 'utf8'))
    expect(rewritten.providers.demo.files['/demo.jsonl']).not.toHaveProperty('futureFileField')
    expect(await saveCache(loaded)).toBe(true)
    const normalized = JSON.parse(readFileSync(sessionCachePath(), 'utf8'))
    expect(normalized.complete).toBe(false)
    expect(normalized.providers.demo.durable).toBe(false)
    expect(normalized.providers.demo.prEvidenceV1).toBe(false)
    expect(readFileSync(join(dir, 'session-cache.json'), 'utf8')).toBe(legacyText)
  })

  it('normalizes legacy provider flags and preserves the active cache facts', async () => {
    useCacheDir('tr-cache-schema-invalid-')
    const file = buildFixtureCachedFile()
    const rawCache = {
      version: 7,
      complete: 'legacy-truthy',
      providers: {
        demo: {
          envFingerprint: 'env-1',
          durable: 'legacy-truthy',
          prEvidenceV1: 'true',
          files: { '/demo.jsonl': file },
        },
      },
    }
    writeFileSync(sessionCachePath(), JSON.stringify(rawCache))
    expect(Schema.decodeUnknownResult(sessionCacheSchema)(rawCache)._tag).toBe('Failure')

    const loaded = await loadCache()
    expect(loaded.providers['demo']?.files['/demo.jsonl']?.turns[0]?.userMessage).toBe('Refactor the auth module')
    expect(loaded.complete).toBe(false)
    expect(loaded.providers['demo']?.durable).toBe(true)
    expect(loaded.providers['demo']?.prEvidenceV1).toBe(false)
  })

  it('adopts v5 and v6 expired PR history, skips bad or present entries, and lets v6 win duplicate paths', async () => {
    const dir = useCacheDir('tr-cache-schema-prior-')
    const oldOnlyPath = join(dir, 'expired-v5.jsonl')
    const sharedPath = join(dir, 'expired-shared.jsonl')
    const newOnlyPath = join(dir, 'expired-v6.jsonl')
    const presentPath = join(dir, 'present-source.jsonl')
    writeFileSync(presentPath, '')

    writeFileSync(
      join(dir, 'session-cache.v5.json'),
      JSON.stringify({
        version: 5,
        providers: {
          demo: {
            envFingerprint: 'v5-env',
            files: {
              [oldOnlyPath]: buildFixtureCachedFile({ prLinks: ['https://example.test/pull/5'] }),
              [sharedPath]: buildFixtureCachedFile({ prLinks: ['https://example.test/pull/old'] }),
              [presentPath]: buildFixtureCachedFile({ prLinks: ['https://example.test/pull/present'] }),
              [join(dir, 'no-pr.jsonl')]: buildFixtureCachedFile(),
              [join(dir, 'bad-entry.jsonl')]: {
                fingerprint: { dev: 'broken' },
                prLinks: ['https://example.test/pull/bad'],
              },
            },
          },
        },
      }),
    )
    writeFileSync(
      join(dir, 'session-cache.v6.json'),
      JSON.stringify({
        version: 6,
        providers: {
          demo: {
            envFingerprint: 'v6-env',
            files: {
              [sharedPath]: buildFixtureCachedFile({ prLinks: ['https://example.test/pull/new'] }),
              [newOnlyPath]: buildFixtureCachedFile({ prLinks: ['https://example.test/pull/6'] }),
            },
          },
        },
      }),
    )

    const adopted = await loadCache()
    const files = adopted.providers['demo']?.files
    expect(Object.keys(files ?? {}).sort()).toEqual([oldOnlyPath, sharedPath, newOnlyPath].sort())
    expect(files?.[oldOnlyPath]?.prLinks).toEqual(['https://example.test/pull/5'])
    expect(files?.[sharedPath]?.prLinks).toEqual(['https://example.test/pull/new'])
    expect(files?.[newOnlyPath]?.prLinks).toEqual(['https://example.test/pull/6'])
    expect(adopted.providers['demo']?.envFingerprint).not.toBe('v5-env')
    expect(adopted.providers['demo']?.envFingerprint).not.toBe('v6-env')
    expect(adopted.complete).toBe(false)

    expect(await saveCache(adopted)).toBe(true)
    const reloaded = await loadCache()
    expect(reloaded.providers['demo']?.files[oldOnlyPath]?.prLinks).toEqual(['https://example.test/pull/5'])
    expect(reloaded.providers['demo']?.files[sharedPath]?.prLinks).toEqual(['https://example.test/pull/new'])
    expect(reloaded.providers['demo']?.files[newOnlyPath]?.prLinks).toEqual(['https://example.test/pull/6'])
  })

  it('uses a valid active v7 cache as authoritative when prior files remain', async () => {
    const dir = useCacheDir('tr-cache-schema-active-')
    const activePath = join(dir, 'active.jsonl')
    const stalePath = join(dir, 'stale-v6.jsonl')
    writeFileSync(
      sessionCachePath(),
      JSON.stringify({
        version: 7,
        providers: {
          demo: {
            envFingerprint: 'active-env',
            files: { [activePath]: buildFixtureCachedFile({ prLinks: ['https://example.test/pull/active'] }) },
          },
        },
      }),
    )
    writeFileSync(
      join(dir, 'session-cache.v6.json'),
      JSON.stringify({
        version: 6,
        providers: {
          demo: {
            envFingerprint: 'old-env',
            files: { [stalePath]: buildFixtureCachedFile({ prLinks: ['https://example.test/pull/stale'] }) },
          },
        },
      }),
    )

    const loaded = await loadCache()
    expect(Object.keys(loaded.providers['demo']?.files ?? {})).toEqual([activePath])
    expect(loaded.providers['demo']?.envFingerprint).toBe('active-env')
    expect(loaded.providers['demo']?.files[activePath]?.prLinks).toEqual(['https://example.test/pull/active'])
  })
})
