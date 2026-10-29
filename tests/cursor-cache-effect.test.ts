import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { Cause, Effect, Exit, FileSystem, PlatformError } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  root: '',
  failWrite: false,
  failPartialWrite: false,
  failRename: false,
  renameCalls: 0,
  abortAfterWrite: undefined as (() => void) | undefined,
  openedFile: undefined as FileSystem.File | undefined,
  closedBeforeRename: false,
}))

vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: () => hooks.root }
})

import { readCachedResultsEffect, writeCachedResultsEffect } from '../src/infrastructure/ingestion/cursor-cache.js'
import type { ParsedProviderCall } from '../src/infrastructure/provider-adapters/types.js'

let root = ''
let dbPath = ''

function fileSystemError(method: string, message: string): PlatformError.PlatformError {
  return PlatformError.systemError({ _tag: 'Unknown', module: 'FileSystem', method, cause: new Error(message) })
}

function withFileSystem<A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | import('effect/Scope').Scope>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const hooked: FileSystem.FileSystem = {
      ...fs,
      open: (path, options) =>
        fs.open(path, options).pipe(
          Effect.map(handle => {
            if (path.endsWith('.tmp')) hooks.openedFile = handle
            return {
              ...handle,
              sync: handle.sync,
              writeAll: bytes => {
                if (hooks.failWrite) return Effect.fail(fileSystemError('writeAll', 'temporary write failed'))
                const write = handle.writeAll(bytes)
                if (!hooks.failPartialWrite)
                  return write.pipe(Effect.tap(() => Effect.sync(() => hooks.abortAfterWrite?.())))
                return write.pipe(
                  Effect.flatMap(() => Effect.fail(fileSystemError('writeAll', 'partial write failed'))),
                )
              },
            }
          }),
        ),
      rename: (fromPath, toPath) => {
        hooks.renameCalls++
        return Effect.gen(function* () {
          if (hooks.openedFile) {
            const stat = yield* Effect.exit(hooks.openedFile.stat)
            if (Exit.isFailure(stat)) {
              const failure = Cause.findErrorOption(stat.cause)
              const cause =
                failure._tag === 'Some' && PlatformError.isPlatformError(failure.value) ? failure.value.cause : null
              hooks.closedBeforeRename = (cause as NodeJS.ErrnoException | null)?.code === 'EBADF'
            }
          }
          if (hooks.failRename) return yield* Effect.fail(fileSystemError('rename', 'rename failed'))
          return yield* fs.rename(fromPath, toPath)
        })
      },
    }
    return yield* Effect.provideService(effect, FileSystem.FileSystem, hooked)
  }).pipe(Effect.provide(NodeFileSystem.layer))
}

function run<A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | import('effect/Scope').Scope>) {
  return Effect.runPromise(Effect.scoped(withFileSystem(effect)))
}

function call(): ParsedProviderCall {
  return {
    provider: 'cursor',
    model: 'test-model',
    inputTokens: 4,
    outputTokens: 2,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costUSD: 0.25,
    costIsEstimated: true,
    tools: [],
    bashCommands: [],
    timestamp: '2026-10-01T00:00:00.000Z',
    speed: 'standard',
    deduplicationKey: 'cursor:test-call',
    userMessage: '',
    sessionId: 'test-session',
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watchtower-cursor-cache-effect-'))
  hooks.root = root
  hooks.failWrite = false
  hooks.failPartialWrite = false
  hooks.failRename = false
  hooks.renameCalls = 0
  hooks.abortAfterWrite = undefined
  hooks.openedFile = undefined
  hooks.closedBeforeRename = false
  dbPath = join(root, 'state.vscdb')
  writeFileSync(dbPath, 'cursor database')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('Cursor cache native Effects', () => {
  it('writes atomically and reads a schema-validated matching v6 cache', async () => {
    const expected = [call()]
    await run(Effect.scoped(writeCachedResultsEffect(dbPath, expected, '2026-04-01T00:00:00.000Z')))

    const actual = await run(readCachedResultsEffect(dbPath, '2026-06-01T00:00:00.000Z'))

    expect(actual).toEqual(expected)
    expect(hooks.closedBeforeRename).toBe(true)
    expect(readdirSync(join(root, '.cache', 'watchtower'))).toEqual(['cursor-results.json'])
  })

  it('keeps the cache floor and database fingerprint checks', async () => {
    await run(Effect.scoped(writeCachedResultsEffect(dbPath, [call()], '2026-06-01T00:00:00.000Z')))
    expect(await run(readCachedResultsEffect(dbPath, '2026-04-01T00:00:00.000Z'))).toBeNull()

    writeFileSync(dbPath, 'cursor database changed')
    expect(await run(readCachedResultsEffect(dbPath, '2026-06-01T00:00:00.000Z'))).toBeNull()
  })

  it('removes an owned temporary file after write failure', async () => {
    hooks.failWrite = true
    await run(Effect.scoped(writeCachedResultsEffect(dbPath, [call()], '2026-04-01T00:00:00.000Z')))

    expect(readdirSync(join(root, '.cache', 'watchtower'))).toEqual([])
  })

  it('removes the staged file when abort arrives after the filesystem write settles', async () => {
    const controller = new AbortController()
    hooks.abortAfterWrite = () => controller.abort()

    await expect(
      run(
        Effect.scoped(writeCachedResultsEffect(dbPath, [call()], '2026-04-01T00:00:00.000Z', false, controller.signal)),
      ),
    ).rejects.toMatchObject({ _tag: 'ScanAbortedError' })
    expect(readdirSync(join(root, '.cache', 'watchtower'))).toEqual([])
  })

  it('retains the previous cache and removes a partially written temporary file', async () => {
    const previous = [call()]
    const floor = '2026-04-01T00:00:00.000Z'
    await run(Effect.scoped(writeCachedResultsEffect(dbPath, previous, floor)))
    hooks.failPartialWrite = true
    await run(Effect.scoped(writeCachedResultsEffect(dbPath, [{ ...call(), costUSD: 1 }], floor)))

    expect(hooks.renameCalls).toBe(1)
    expect(await run(readCachedResultsEffect(dbPath, floor))).toEqual(previous)
    expect(readdirSync(join(root, '.cache', 'watchtower'))).toEqual(['cursor-results.json'])
  })

  it('retains the previous cache and removes the staged file after rename failure', async () => {
    const previous = [call()]
    const floor = '2026-04-01T00:00:00.000Z'
    await run(Effect.scoped(writeCachedResultsEffect(dbPath, previous, floor)))
    hooks.failRename = true
    await run(Effect.scoped(writeCachedResultsEffect(dbPath, [{ ...call(), costUSD: 1 }], floor)))

    expect(await run(readCachedResultsEffect(dbPath, floor))).toEqual(previous)
    expect(readdirSync(join(root, '.cache', 'watchtower'))).toEqual(['cursor-results.json'])
  })

  it('does not create cache files when writes are suppressed', async () => {
    await run(Effect.scoped(writeCachedResultsEffect(dbPath, [call()], '2026-04-01T00:00:00.000Z', true)))
    expect(() => readdirSync(join(root, '.cache', 'watchtower'))).toThrow()
  })
})
