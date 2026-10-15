import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  root: '',
  failWrite: false,
  failPartialWrite: false,
  failRename: false,
  renameCalls: 0,
  abortAfterWrite: undefined as (() => void) | undefined,
}))

vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: () => hooks.root }
})

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (hooks.failWrite) throw new Error('temporary write failed')
      if (hooks.failPartialWrite) {
        await actual.writeFile(args[0], 'partial cache')
        throw new Error('partial write failed')
      }
      await actual.writeFile(...args)
      hooks.abortAfterWrite?.()
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      hooks.renameCalls++
      if (hooks.failRename) throw new Error('rename failed')
      return actual.rename(...args)
    },
  }
})

import { readCachedResultsEffect, writeCachedResultsEffect } from '../src/main/pipeline/cursor-cache.js'
import type { ParsedProviderCall } from '../src/main/pipeline/providers/types.js'

let root = ''
let dbPath = ''

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
  dbPath = join(root, 'state.vscdb')
  writeFileSync(dbPath, 'cursor database')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('Cursor cache native Effects', () => {
  it('writes atomically and reads a schema-validated matching v6 cache', async () => {
    const expected = [call()]
    await Effect.runPromise(Effect.scoped(writeCachedResultsEffect(dbPath, expected, '2026-04-01T00:00:00.000Z')))

    const actual = await Effect.runPromise(readCachedResultsEffect(dbPath, '2026-06-01T00:00:00.000Z'))

    expect(actual).toEqual(expected)
    expect(readdirSync(join(root, '.cache', 'watchtower'))).toEqual(['cursor-results.json'])
  })

  it('keeps the cache floor and database fingerprint checks', async () => {
    await Effect.runPromise(Effect.scoped(writeCachedResultsEffect(dbPath, [call()], '2026-06-01T00:00:00.000Z')))
    expect(await Effect.runPromise(readCachedResultsEffect(dbPath, '2026-04-01T00:00:00.000Z'))).toBeNull()

    writeFileSync(dbPath, 'cursor database changed')
    expect(await Effect.runPromise(readCachedResultsEffect(dbPath, '2026-06-01T00:00:00.000Z'))).toBeNull()
  })

  it('removes an owned temporary file after write failure', async () => {
    hooks.failWrite = true
    await Effect.runPromise(Effect.scoped(writeCachedResultsEffect(dbPath, [call()], '2026-04-01T00:00:00.000Z')))

    expect(readdirSync(join(root, '.cache', 'watchtower'))).toEqual([])
  })

  it('removes the staged file when abort arrives after the native write settles', async () => {
    const controller = new AbortController()
    hooks.abortAfterWrite = () => controller.abort()

    await expect(
      Effect.runPromise(
        Effect.scoped(writeCachedResultsEffect(dbPath, [call()], '2026-04-01T00:00:00.000Z', false, controller.signal)),
      ),
    ).rejects.toMatchObject({ _tag: 'ScanAbortedError' })
    expect(readdirSync(join(root, '.cache', 'watchtower'))).toEqual([])
  })

  it('retains the previous cache and removes a partially written temporary file', async () => {
    const previous = [call()]
    const floor = '2026-04-01T00:00:00.000Z'
    await Effect.runPromise(Effect.scoped(writeCachedResultsEffect(dbPath, previous, floor)))
    hooks.failPartialWrite = true
    await Effect.runPromise(Effect.scoped(writeCachedResultsEffect(dbPath, [{ ...call(), costUSD: 1 }], floor)))

    expect(hooks.renameCalls).toBe(1)
    expect(await Effect.runPromise(readCachedResultsEffect(dbPath, floor))).toEqual(previous)
    expect(readdirSync(join(root, '.cache', 'watchtower'))).toEqual(['cursor-results.json'])
  })

  it('retains the previous cache and removes the staged file after rename failure', async () => {
    const previous = [call()]
    const floor = '2026-04-01T00:00:00.000Z'
    await Effect.runPromise(Effect.scoped(writeCachedResultsEffect(dbPath, previous, floor)))
    hooks.failRename = true
    await Effect.runPromise(Effect.scoped(writeCachedResultsEffect(dbPath, [{ ...call(), costUSD: 1 }], floor)))

    expect(await Effect.runPromise(readCachedResultsEffect(dbPath, floor))).toEqual(previous)
    expect(readdirSync(join(root, '.cache', 'watchtower'))).toEqual(['cursor-results.json'])
  })

  it('does not create cache files when writes are suppressed', async () => {
    await Effect.runPromise(Effect.scoped(writeCachedResultsEffect(dbPath, [call()], '2026-04-01T00:00:00.000Z', true)))
    expect(() => readdirSync(join(root, '.cache', 'watchtower'))).toThrow()
  })
})
