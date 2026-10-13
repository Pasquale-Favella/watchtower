import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fsControls = vi.hoisted(() => ({
  interceptedPath: null as string | null,
  readStarted: null as (() => void) | null,
  readGate: null as Promise<void> | null,
  readFailurePath: null as string | null,
  closeFailurePath: null as string | null,
  closeCalls: 0,
}))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const path = args[0]
      if (path !== fsControls.interceptedPath) return handle

      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === 'read') {
            return async (buffer: Buffer, offset: number, length: number, position: number) => {
              fsControls.readStarted?.()
              if (fsControls.readGate) await fsControls.readGate
              if (path === fsControls.readFailurePath) throw new Error('test read failure')
              return target.read(buffer, offset, length, position)
            }
          }
          if (property === 'close') {
            return async () => {
              fsControls.closeCalls += 1
              await target.close()
              if (path === fsControls.closeFailurePath) throw new Error('test close failure')
            }
          }
          const value = Reflect.get(target, property, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
  }
})

import { ExportFiles } from '../src/main/application/export-files.js'
import { ExportFilesLive, writeCsvExportFiles, writeJsonExportFile } from '../src/main/export-files-live.js'

const directories: string[] = []

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-export-files-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  fsControls.interceptedPath = null
  fsControls.readStarted = null
  fsControls.readGate = null
  fsControls.readFailurePath = null
  fsControls.closeFailurePath = null
  fsControls.closeCalls = 0
  const expectedParent = resolve(tmpdir())
  for (const directory of directories.splice(0)) {
    const target = resolve(directory)
    if (
      dirname(target) !== expectedParent ||
      !basename(target).startsWith('watchtower-export-files-') ||
      target !== directory
    ) {
      throw new Error('Refusing to remove an unexpected export test directory')
    }
    rmSync(target, { recursive: true, force: true })
  }
})

function writeJsonWithLivePort(target: string, contents: string): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    const files = yield* ExportFiles
    return yield* files.writeJsonFile(target, contents)
  }).pipe(Effect.provide(ExportFilesLive))
}

describe('export file ownership and overwrite checks', () => {
  it('writes the marker, README and all nine CSV files into the resolved folder', async () => {
    const root = tempDirectory()
    const target = join(root, 'usage.csv')
    const files = [
      { name: 'README.txt', contents: 'generated once' },
      ...Array.from({ length: 9 }, (_, index) => ({ name: `table-${index}.csv`, contents: `row-${index}` })),
    ]

    await expect(writeCsvExportFiles(target, files)).resolves.toBe(resolve(root, 'usage'))
    expect(readdirSync(join(root, 'usage')).sort()).toEqual(
      ['.watchtower-export', ...files.map(file => file.name)].sort(),
    )
    expect(readFileSync(join(root, 'usage', 'table-8.csv'), 'utf-8')).toBe('row-8')
  })

  it('refuses an unmarked directory without changing its contents', async () => {
    const root = tempDirectory()
    const folder = join(root, 'occupied')
    mkdirSync(folder)
    writeFileSync(join(folder, 'keep.txt'), 'user data')

    await expect(writeCsvExportFiles(folder, [])).rejects.toMatchObject({
      _tag: 'ExportFileError',
      reason: 'csv-unmarked-directory',
    })
    expect(readFileSync(join(folder, 'keep.txt'), 'utf-8')).toBe('user data')
  })

  it('clears only a marked export folder before writing its replacement', async () => {
    const root = tempDirectory()
    const folder = join(root, 'previous')
    mkdirSync(join(folder, 'old'), { recursive: true })
    writeFileSync(join(folder, '.watchtower-export'), '')
    writeFileSync(join(folder, 'old', 'table.csv'), 'old')
    writeFileSync(join(folder, 'README.txt'), 'old readme')

    await writeCsvExportFiles(folder, [{ name: 'README.txt', contents: 'new readme' }])
    expect(readdirSync(folder).sort()).toEqual(['.watchtower-export', 'README.txt'])
    expect(readFileSync(join(folder, 'README.txt'), 'utf-8')).toBe('new readme')
  })

  it('refuses a plain CSV target file without overwriting it', async () => {
    const root = tempDirectory()
    const target = join(root, 'report')
    writeFileSync(target, 'keep')

    await expect(writeCsvExportFiles(target, [])).rejects.toMatchObject({ reason: 'csv-file-target' })
    expect(readFileSync(target, 'utf-8')).toBe('keep')
  })

  it('maps filesystem failures to a typed error without exposing the target path', async () => {
    const root = tempDirectory()
    const blocker = join(root, 'file')
    writeFileSync(blocker, 'not a directory')

    await expect(writeCsvExportFiles(join(blocker, 'child'), [])).rejects.toMatchObject({
      _tag: 'ExportFileError',
      reason: 'io-failure',
    })
  })

  it('refuses an unmarked JSON file and directory without changing either', async () => {
    const root = tempDirectory()
    const target = join(root, 'report.json')
    writeFileSync(target, '{"user":"data"}')
    const folder = join(root, 'folder.json')
    mkdirSync(folder)

    await expect(writeJsonExportFile(target, '{}')).rejects.toMatchObject({ reason: 'json-unmarked-file' })
    await expect(writeJsonExportFile(folder, '{}')).rejects.toMatchObject({ reason: 'json-directory-target' })
    expect(readFileSync(target, 'utf-8')).toBe('{"user":"data"}')
    expect(readdirSync(folder)).toEqual([])
  })

  it('overwrites a prior Watchtower JSON export and adds the extension once', async () => {
    const root = tempDirectory()
    const target = join(root, 'report')
    writeFileSync(`${target}.json`, '{"schema": "watchtower.export.v1", "old": true}')

    await expect(writeJsonExportFile(target, '{"schema":"watchtower.export.v1"}')).resolves.toBe(`${target}.json`)
    expect(readFileSync(`${target}.json`, 'utf-8')).toBe('{"schema":"watchtower.export.v1"}')
  })

  it('closes a pending JSON header read before honoring interruption and skips overwrite', async () => {
    const root = tempDirectory()
    const target = join(root, 'report.json')
    const original = '{"schema": "watchtower.export.v1", "old": true}'
    writeFileSync(target, original)
    fsControls.interceptedPath = target

    let startRead!: () => void
    const readStarted = new Promise<void>(resolve => {
      startRead = resolve
    })
    let finishRead!: () => void
    fsControls.readGate = new Promise<void>(resolve => {
      finishRead = resolve
    })
    fsControls.readStarted = startRead

    const fiber = Effect.runFork(writeJsonWithLivePort(target, '{"schema":"watchtower.export.v1","new":true}'))
    await readStarted
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber))
    finishRead()
    await interrupted

    expect(fsControls.closeCalls).toBe(1)
    expect(readFileSync(target, 'utf-8')).toBe(original)
  })

  it('maps JSON close failure to io-failure and does not retry the close', async () => {
    const root = tempDirectory()
    const target = join(root, 'report.json')
    const original = '{"schema": "watchtower.export.v1", "old": true}'
    writeFileSync(target, original)
    fsControls.interceptedPath = target
    fsControls.closeFailurePath = target

    await expect(
      Effect.runPromise(writeJsonWithLivePort(target, '{"schema":"watchtower.export.v1"}')),
    ).rejects.toMatchObject({
      _tag: 'ExportFileError',
      reason: 'io-failure',
    })
    expect(fsControls.closeCalls).toBe(1)
    expect(readFileSync(target, 'utf-8')).toBe(original)
  })

  it('keeps JSON header read and close failures typed without a second close', async () => {
    const root = tempDirectory()
    const target = join(root, 'report.json')
    const original = '{"schema": "watchtower.export.v1", "old": true}'
    writeFileSync(target, original)
    fsControls.interceptedPath = target
    fsControls.readFailurePath = target
    fsControls.closeFailurePath = target

    await expect(
      Effect.runPromise(writeJsonWithLivePort(target, '{"schema":"watchtower.export.v1"}')),
    ).rejects.toMatchObject({
      _tag: 'ExportFileError',
      reason: 'io-failure',
    })
    expect(fsControls.closeCalls).toBe(1)
    expect(readFileSync(target, 'utf-8')).toBe(original)
  })
})
