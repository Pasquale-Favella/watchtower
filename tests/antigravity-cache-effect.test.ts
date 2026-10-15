import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect, Fiber } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  failCacheRead: false,
  failWrite: false,
  failRename: false,
  failRandomBytes: false,
  renameCalls: 0,
  pauseWrite: false,
  onWriteStarted: undefined as (() => void) | undefined,
  releaseWrite: undefined as (() => void) | undefined,
  closedHandles: new Set<string>(),
  cleanupAfterClose: [] as boolean[],
}))

vi.mock('crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return {
    ...actual,
    randomBytes: (...args: Parameters<typeof actual.randomBytes>) => {
      if (hooks.failRandomBytes) throw new Error('crypto defect')
      return actual.randomBytes(...args)
    },
  }
})

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (hooks.failCacheRead && String(args[0]).endsWith('antigravity-results.json')) {
        throw new Error('cache read failed')
      }
      return actual.readFile(...args)
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const path = String(args[0])
      let closed = false
      return {
        writeFile: async (...writeArgs: Parameters<typeof handle.writeFile>) => {
          if (hooks.pauseWrite) {
            hooks.pauseWrite = false
            await new Promise<void>(resolve => {
              hooks.releaseWrite = resolve
              hooks.onWriteStarted?.()
            })
          }
          if (hooks.failWrite) {
            await handle.writeFile('partial cache payload')
            throw new Error('cache write failed')
          }
          return handle.writeFile(...writeArgs)
        },
        sync: () => handle.sync(),
        close: async () => {
          closed = true
          hooks.closedHandles.add(path)
          return handle.close()
        },
        get closed() {
          return closed
        },
      }
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      hooks.renameCalls++
      if (hooks.failRename) throw new Error('cache rename failed')
      return actual.rename(...args)
    },
    unlink: async (path: Parameters<typeof actual.unlink>[0]) => {
      hooks.cleanupAfterClose.push(hooks.closedHandles.has(String(path)))
      return actual.unlink(path)
    },
  }
})

vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null, stdout: string) => void
      callback(null, '')
      return {} as ReturnType<typeof actual.execFile>
    },
  }
})

let root = ''
let provider: typeof import('../src/main/pipeline/providers/antigravity.js')

beforeEach(async () => {
  vi.resetModules()
  root = await mkdtemp(join(tmpdir(), 'watchtower-antigravity-cache-effect-'))
  hooks.failCacheRead = false
  hooks.failWrite = false
  hooks.failRename = false
  hooks.failRandomBytes = false
  hooks.renameCalls = 0
  hooks.pauseWrite = false
  hooks.onWriteStarted = undefined
  hooks.releaseWrite = undefined
  hooks.closedHandles.clear()
  hooks.cleanupAfterClose.length = 0
  const env = await import('../src/main/env.js')
  env.initAppPaths({ cacheDir: root })
  provider = await import('../src/main/pipeline/providers/antigravity.js')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function validCall() {
  return {
    provider: 'antigravity',
    model: 'fixture-model',
    inputTokens: 10,
    outputTokens: 4,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costUSD: 0.1,
    tools: ['read_file'],
    bashCommands: [],
    timestamp: '2026-10-01T00:00:00.000Z',
    speed: 'standard',
    deduplicationKey: 'fixture-call',
    userMessage: 'hello',
    sessionId: 'fixture-cascade',
    project: 'antigravity-cli',
    extensionFromNewerVersion: 'stripped by schema',
  }
}

async function seedCache(): Promise<{ cachePath: string; sourcePath: string; rawCache: string }> {
  const conversations = join(root, '.gemini', 'antigravity-cli', 'conversations')
  const sourcePath = join(conversations, 'fixture-cascade.pb')
  await (await import('node:fs/promises')).mkdir(conversations, { recursive: true })
  await writeFile(sourcePath, 'source')
  const sourceStat = await (await import('node:fs/promises')).stat(sourcePath)
  const cachePath = join(root, 'antigravity-results.json')
  const rawCache = JSON.stringify({
    version: 5,
    cascades: {
      'fixture-cascade': {
        mtimeMs: sourceStat.mtimeMs,
        sizeBytes: sourceStat.size,
        calls: [validCall()],
      },
    },
  })
  await writeFile(cachePath, rawCache)
  return { cachePath, sourcePath, rawCache }
}

async function loadThroughParser(sourcePath: string): Promise<unknown[]> {
  const parser = provider
    .createAntigravityProvider()
    .createSessionParser({ path: sourcePath, project: 'antigravity-cli', provider: 'antigravity' }, new Set())
  const calls: unknown[] = []
  for await (const call of parser.parse()) calls.push(call)
  return calls
}

describe('Antigravity native cache effects', () => {
  it('decodes valid v5 calls through the parsed-call schema and preserves mutable call fields', async () => {
    const { sourcePath } = await seedCache()
    const calls = await loadThroughParser(sourcePath)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ tools: ['read_file'], deduplicationKey: 'fixture-call' })
    expect(calls[0]).not.toHaveProperty('extensionFromNewerVersion')
  })

  it('recovers from malformed JSON and filesystem read failures', async () => {
    const { cachePath, sourcePath } = await seedCache()
    await writeFile(cachePath, '{bad json')
    expect(await loadThroughParser(sourcePath)).toEqual([])

    vi.resetModules()
    const env = await import('../src/main/env.js')
    env.initAppPaths({ cacheDir: root })
    provider = await import('../src/main/pipeline/providers/antigravity.js')
    hooks.failCacheRead = true
    expect(await loadThroughParser(sourcePath)).toEqual([])
  })

  it('quietly recovers from partial write failure after close and temp cleanup', async () => {
    const { cachePath, sourcePath, rawCache } = await seedCache()
    await loadThroughParser(sourcePath)
    hooks.failWrite = true

    await expect(Effect.runPromise(provider.flushAntigravityCacheEffect(new Set()))).resolves.toBeUndefined()

    expect(await readFile(cachePath, 'utf-8')).toBe(rawCache)
    expect(hooks.cleanupAfterClose).toEqual([true])
    expect(hooks.renameCalls).toBe(0)
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])

    hooks.failWrite = false
    await Effect.runPromise(provider.flushAntigravityCacheEffect())
    expect(JSON.parse(await readFile(cachePath, 'utf-8'))).toEqual({ version: 5, cascades: {} })
  })

  it('evicts absent cascades and publishes the schema-encoded cache', async () => {
    const { cachePath, sourcePath } = await seedCache()
    await loadThroughParser(sourcePath)

    await Effect.runPromise(Effect.scoped(provider.flushAntigravityCacheEffect(new Set(['other-cascade']))))

    expect(JSON.parse(await readFile(cachePath, 'utf-8'))).toEqual({ version: 5, cascades: {} })
  })

  it('removes the temporary file after rename failure and retains the prior cache', async () => {
    const { cachePath, sourcePath, rawCache } = await seedCache()
    await loadThroughParser(sourcePath)
    hooks.failRename = true

    await Effect.runPromise(Effect.scoped(provider.flushAntigravityCacheEffect(new Set())))

    expect(await readFile(cachePath, 'utf-8')).toBe(rawCache)
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])
    expect(hooks.cleanupAfterClose).toEqual([true])
    await Effect.runPromise(provider.flushAntigravityCacheEffect())
    expect(hooks.renameCalls).toBe(1)
  })

  it('waits for a pending write to settle before closing and cleaning up on interruption', async () => {
    const { sourcePath } = await seedCache()
    await loadThroughParser(sourcePath)
    hooks.pauseWrite = true
    let writeStarted!: () => void
    const started = new Promise<void>(resolve => {
      writeStarted = resolve
    })
    hooks.onWriteStarted = writeStarted

    const fiber = Effect.runFork(Effect.scoped(provider.flushAntigravityCacheEffect(new Set())))
    await started
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toHaveLength(1)
    expect(hooks.cleanupAfterClose).toEqual([])

    hooks.releaseWrite?.()
    await interrupted

    expect(hooks.cleanupAfterClose).toEqual([true])
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('surfaces a pre-aborted caller signal as a typed scan cancellation', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      Effect.runPromise(Effect.scoped(provider.flushAntigravityCacheEffect(undefined, controller.signal))),
    ).rejects.toMatchObject({ _tag: 'ScanAbortedError' })
  })

  it('preserves defects instead of recovering them as best-effort filesystem failures', async () => {
    const { sourcePath } = await seedCache()
    await loadThroughParser(sourcePath)
    hooks.failRandomBytes = true
    await expect(Effect.runPromise(provider.flushAntigravityCacheEffect(new Set()))).rejects.toThrow('crypto defect')
  })
})
