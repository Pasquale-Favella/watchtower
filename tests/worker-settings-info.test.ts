import { Cause, Deferred, Effect, Exit, Fiber } from 'effect'
import type { Dirent, Stats } from 'fs'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { readdir, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { settingsInfoEffect, type SettingsInfoFileSystem } from '../src/main/application/settings-info.js'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watchtower-settings-info-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const claudeDirs = () => Effect.succeed(['claude-home'])

describe('worker settings info', () => {
  it('reads real database, data, and cache sizes recursively', async () => {
    const dataDir = join(root, 'data')
    const cacheDir = join(root, 'cache')
    const nestedDir = join(dataDir, 'nested')
    const fs = await import('fs')
    fs.mkdirSync(nestedDir, { recursive: true })
    fs.mkdirSync(cacheDir)
    writeFileSync(join(dataDir, 'ledger.db'), '12345')
    writeFileSync(join(dataDir, 'other.txt'), 'abc')
    writeFileSync(join(nestedDir, 'nested.txt'), '1234')
    writeFileSync(join(cacheDir, 'cache.bin'), '123456')

    const result = await Effect.runPromise(settingsInfoEffect(dataDir, cacheDir, { getClaudeConfigDirs: claudeDirs }))

    expect(result).toEqual({
      dataDir,
      dbSize: 5,
      dataDirSize: 12,
      cacheDir,
      cacheSize: 6,
      claudeConfigDirs: ['claude-home'],
    })
  })

  it('returns zero sizes for missing paths and omits Claude config after an operational failure', async () => {
    const dataDir = join(root, 'missing-data')
    const cacheDir = join(root, 'missing-cache')

    const result = await Effect.runPromise(
      settingsInfoEffect(dataDir, cacheDir, {
        getClaudeConfigDirs: () => Effect.fail(new Error('unreadable config')),
      }),
    )

    expect(result).toEqual({ dataDir, dbSize: 0, dataDirSize: 0, cacheDir, cacheSize: 0 })
  })

  it('propagates defects from Claude config lookup', async () => {
    const failure = new Error('unexpected config defect')
    const fileSystem: SettingsInfoFileSystem = {
      readdir: async () => {
        throw new Error('filesystem should not run before config lookup')
      },
      stat: async () => {
        throw new Error('filesystem should not run before config lookup')
      },
    }

    const result = await Effect.runPromise(
      Effect.exit(
        settingsInfoEffect(join(root, 'data'), join(root, 'cache'), {
          fileSystem,
          getClaudeConfigDirs: () => Effect.die(failure),
        }),
      ),
    )

    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) expect(Cause.hasDies(result.cause)).toBe(true)
  })

  it('keeps a partial directory total and stops visiting siblings after a file stat failure', async () => {
    const dataDir = join(root, 'data')
    const cacheDir = join(root, 'cache')
    const entries = ['first', 'broken', 'later'].map(name => ({
      name,
      isDirectory: () => false,
      isFile: () => true,
    })) as Dirent[]
    const statCalls: string[] = []
    const fileSystem: SettingsInfoFileSystem = {
      async readdir(path) {
        if (path === dataDir) return entries
        throw new Error('missing directory')
      },
      async stat(path) {
        statCalls.push(path)
        if (path.endsWith('first')) return { size: 3 } as Stats
        throw new Error('unreadable file')
      },
    }

    const result = await Effect.runPromise(
      settingsInfoEffect(dataDir, cacheDir, { fileSystem, getClaudeConfigDirs: claudeDirs }),
    )

    expect(result.dbSize).toBe(0)
    expect(result.dataDirSize).toBe(3)
    expect(result.cacheSize).toBe(0)
    expect(statCalls).toEqual([join(dataDir, 'ledger.db'), join(dataDir, 'first'), join(dataDir, 'broken')])
  })

  it('continues counting parent siblings when a child directory cannot be read', async () => {
    const dataDir = join(root, 'data')
    const childDir = join(dataDir, 'unreadable')
    const cacheDir = join(root, 'cache')
    const readdirCalls: string[] = []
    const entries = [
      { name: 'unreadable', isDirectory: () => true, isFile: () => false },
      { name: 'sibling.txt', isDirectory: () => false, isFile: () => true },
    ] as Dirent[]
    const fileSystem: SettingsInfoFileSystem = {
      async readdir(path) {
        readdirCalls.push(path)
        if (path === dataDir) return entries
        throw new Error('unreadable directory')
      },
      async stat(path) {
        if (path === join(dataDir, 'sibling.txt')) return { size: 7 } as Stats
        throw new Error('missing file')
      },
    }

    const result = await Effect.runPromise(
      settingsInfoEffect(dataDir, cacheDir, { fileSystem, getClaudeConfigDirs: claudeDirs }),
    )

    expect(result.dataDirSize).toBe(7)
    expect(readdirCalls).toEqual([dataDir, childDir, cacheDir])
  })

  it('drains a pending filesystem read before interruption completes', async () => {
    const started = await Effect.runPromise(Deferred.make<undefined>())
    const settleRead = await Effect.runPromise(Deferred.make<undefined>())
    const dataDir = join(root, 'data')
    const cacheDir = join(root, 'cache')
    let readCount = 0
    const fileSystem: SettingsInfoFileSystem = {
      async readdir(path, options) {
        readCount += 1
        if (path === dataDir) {
          await Effect.runPromise(Deferred.succeed(started, undefined))
          await Effect.runPromise(Deferred.await(settleRead))
        }
        return readdir(path, options)
      },
      stat,
    }

    const fiber = Effect.runFork(settingsInfoEffect(dataDir, cacheDir, { fileSystem, getClaudeConfigDirs: claudeDirs }))
    await Effect.runPromise(Deferred.await(started))
    const interruption = Effect.runFork(Fiber.interrupt(fiber))
    await Effect.runPromise(Effect.yieldNow)
    expect(readCount).toBe(1)

    await Effect.runPromise(Deferred.succeed(settleRead, undefined))
    expect(Exit.isFailure(await Effect.runPromise(Fiber.await(fiber)))).toBe(true)
    await Effect.runPromise(Fiber.join(interruption))
    expect(readCount).toBe(1)
  })
})
