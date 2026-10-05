import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  cache: undefined as unknown,
  discovered: vi.fn(),
  getProvider: vi.fn(),
  fingerprint: vi.fn(),
  readLines: vi.fn(),
  readdir: vi.fn(),
  parserCreated: vi.fn(),
  saveCache: vi.fn(),
}))

vi.mock('fs/promises', () => ({
  lstat: vi.fn(),
  readdir: (...args: unknown[]) => hooks.readdir(...args),
  readFile: vi.fn(),
  stat: vi.fn(),
}))

vi.mock('../src/main/pipeline/fs-utils.js', () => ({
  readSessionLines: (...args: unknown[]) => hooks.readLines(...args),
}))

vi.mock('../src/main/pipeline/providers/index.js', () => ({
  discoverAllSessions: (...args: unknown[]) => hooks.discovered(...args),
  getProvider: (...args: unknown[]) => hooks.getProvider(...args),
}))

vi.mock('../src/main/pipeline/session-cache.js', () => ({
  beginColdHydration: vi.fn(),
  cleanupOrphanedTempFiles: vi.fn(async () => undefined),
  computeEnvFingerprint: vi.fn(() => 'test-env'),
  DURABLE_PROVIDER_NAMES: new Set(),
  fingerprintFile: (...args: unknown[]) => hooks.fingerprint(...args),
  isCacheComplete: (cache: { complete?: boolean }) => cache.complete === true,
  loadCache: vi.fn(() => hooks.cache),
  reconcileFile: vi.fn(() => ({ action: 'modified' })),
  saveCache: (...args: unknown[]) => hooks.saveCache(...args),
  sectionNeedsPrEvidenceReparse: vi.fn(() => false),
}))

vi.mock('../src/main/pipeline/cache-refresh-lock.js', () => ({
  acquireCacheRefreshLock: vi.fn(async () => ({ outcome: 'acquired', handle: { release: async () => undefined } })),
}))

import { clearSessionCache, parseAllSessions } from '../src/main/pipeline/parser.js'
import { ScanAbortedError } from '../src/main/pipeline/scan-control.js'
import type { CachedFile, SessionCache } from '../src/shared/schemas/session-cache.js'

const source = (provider: string, path: string) => ({ provider, path, project: 'test-project' })

const priorFile: CachedFile = {
  fingerprint: { dev: 1, ino: 1, mtimeMs: 1, sizeBytes: 1 },
  mcpInventory: [],
  turns: [],
}

function makeCache(provider: string, paths: string[]): SessionCache {
  return {
    version: 7,
    complete: true,
    providers: {
      [provider]: {
        envFingerprint: 'test-env',
        files: Object.fromEntries(paths.map(path => [path, structuredClone(priorFile)])),
      },
    },
  } as SessionCache
}

function parsedCall() {
  return {
    provider: 'test-provider',
    model: 'test-model',
    inputTokens: 1,
    outputTokens: 1,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    tools: [],
    bashCommands: [],
    timestamp: '2026-01-01T00:00:00.000Z',
    speed: 'standard' as const,
    deduplicationKey: 'test-provider:call-1',
    userMessage: 'test',
    sessionId: 'session-1',
  }
}

describe('parser cooperative stop', () => {
  beforeEach(() => {
    clearSessionCache()
    hooks.discovered.mockReset()
    hooks.getProvider.mockReset()
    hooks.fingerprint.mockReset()
    hooks.readLines.mockReset()
    hooks.readdir.mockReset()
    hooks.parserCreated.mockReset()
    hooks.saveCache.mockReset()
    hooks.cache = undefined
  })

  afterEach(() => {
    clearSessionCache()
    vi.unstubAllEnvs()
  })

  it('rethrows provider delta abort without turning the file into a failed cache result or starting the next file', async () => {
    const firstPath = '/test/one.session'
    const secondPath = '/test/two.session'
    const cache = makeCache('test-provider', [firstPath, secondPath])
    hooks.cache = cache
    hooks.discovered.mockResolvedValue([source('test-provider', firstPath), source('test-provider', secondPath)])
    hooks.fingerprint.mockResolvedValue({ dev: 2, ino: 2, mtimeMs: 2, sizeBytes: 2 })
    hooks.getProvider.mockResolvedValue({
      network: false,
      durableSources: false,
      createSessionParser: () => ({
        parse: async function* () {
          hooks.parserCreated()
          yield parsedCall()
        },
      }),
    })
    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'scan aborted' })
    const onDelta = vi.fn(async () => {
      controller.abort(abort)
      throw abort
    })
    vi.stubEnv('WATCHTOWER_PROGRESS', '1')
    const progressWrites = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write)

    try {
      await expect(parseAllSessions(undefined, undefined, onDelta, undefined, controller.signal)).rejects.toBe(abort)

      expect(hooks.parserCreated).toHaveBeenCalledOnce()
      expect(onDelta).toHaveBeenCalledOnce()
      const files = cache.providers['test-provider']?.files
      expect(files?.[firstPath]).toEqual(priorFile)
      expect(files?.[secondPath]).toEqual(priorFile)
      expect(files && Object.values(files).some(file => file.failed)).toBe(false)
      expect(hooks.saveCache).not.toHaveBeenCalled()
      const progress = progressWrites.mock.calls.map(([value]) => String(value)).join('')
      expect(progress).not.toContain('"state":"done"')
    } finally {
      progressWrites.mockRestore()
    }
  })

  it('rethrows Claude read abort without writing a failure marker or reading the next file', async () => {
    const projectDir = '/test/claude-project'
    const firstPath = `${projectDir}/one.jsonl`
    const secondPath = `${projectDir}/two.jsonl`
    const cache = makeCache('claude', [firstPath, secondPath])
    hooks.cache = cache
    hooks.discovered.mockResolvedValue([source('claude', projectDir)])
    hooks.fingerprint.mockResolvedValue({ dev: 2, ino: 2, mtimeMs: 2, sizeBytes: 2 })
    hooks.readdir.mockImplementation(async (path: string) => {
      if (path === projectDir) return ['one.jsonl', 'two.jsonl']
      throw new Error('missing directory')
    })
    const abort = new ScanAbortedError({ message: 'scan aborted' })
    hooks.readLines.mockImplementation(async function* () {
      yield 'not json'
      throw abort
    })

    await expect(parseAllSessions()).rejects.toBe(abort)

    expect(hooks.readLines).toHaveBeenCalledOnce()
    const files = cache.providers.claude?.files
    expect(files?.[firstPath]).toEqual(priorFile)
    expect(files?.[secondPath]).toEqual(priorFile)
    expect(files && Object.values(files).some(file => file.failed)).toBe(false)
    expect(hooks.saveCache).not.toHaveBeenCalled()
  })

  it('normalizes a provider factory failure during stop to the scan cancellation error', async () => {
    const path = '/test/one.session'
    const cache = makeCache('test-provider', [path])
    hooks.cache = cache
    hooks.discovered.mockResolvedValue([source('test-provider', path)])
    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'scan aborted' })
    hooks.getProvider.mockImplementation(async () => {
      controller.abort(abort)
      throw new Error('provider load failed during stop')
    })

    await expect(parseAllSessions(undefined, undefined, undefined, undefined, controller.signal)).rejects.toBe(abort)
    expect(cache.providers['test-provider']?.files[path]).toEqual(priorFile)
    expect(hooks.saveCache).not.toHaveBeenCalled()
  })
})
