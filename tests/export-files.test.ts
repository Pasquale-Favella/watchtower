import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as PlatformError from 'effect/PlatformError'
import { afterEach, describe, expect, it } from 'vitest'

const fsControls = {
  interceptedPath: null as string | null,
  readStarted: null as (() => void) | null,
  readGate: null as Promise<void> | null,
  readFailurePath: null as string | null,
  closeFailurePath: null as string | null,
  defectClosePath: null as string | null,
  closeCalls: 0,
  closedFile: null as FileSystem.File | null,
  missingStatPath: null as string | null,
}

import { ExportFiles } from '../src/core/ports/export-files.js'
import { ExportFilesLive } from '../src/infrastructure/services/export-files-live.js'

const testFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return FileSystem.FileSystem.of({
      ...fs,
      stat: path =>
        path === fsControls.missingStatPath
          ? Effect.fail(PlatformError.systemError({ _tag: 'NotFound', module: 'FileSystem', method: 'stat' }))
          : fs.stat(path),
      open: (path, options) =>
        Effect.gen(function* () {
          const trackClose =
            path === fsControls.interceptedPath ||
            path === fsControls.closeFailurePath ||
            path === fsControls.defectClosePath
          let acquired = false
          if (trackClose) {
            yield* Effect.addFinalizer(() =>
              acquired
                ? Effect.sync(() => {
                    fsControls.closeCalls += 1
                  }).pipe(
                    Effect.andThen(
                      path === fsControls.closeFailurePath
                        ? Effect.die(
                            PlatformError.systemError({
                              _tag: 'Unknown',
                              module: 'FileSystem',
                              method: 'close',
                              cause: Object.assign(new Error('bad file descriptor'), { code: 'EBADF' }),
                            }),
                          )
                        : path === fsControls.defectClosePath
                          ? Effect.die(new Error('unexpected close defect'))
                          : Effect.void,
                    ),
                  )
                : Effect.void,
            )
          }
          const file = yield* fs.open(path, options)
          acquired = true
          if (trackClose) fsControls.closedFile = file
          if (path !== fsControls.interceptedPath) return file

          return new Proxy(file, {
            get(target, property, receiver) {
              if (property === 'read') {
                return (buffer: Uint8Array, readOptions?: FileSystem.File.ReadOptions) =>
                  Effect.suspend(() => {
                    fsControls.readStarted?.()
                    const readGate = fsControls.readGate
                    const wait = readGate ? Effect.promise(() => readGate) : Effect.void
                    return wait.pipe(
                      Effect.flatMap(() =>
                        path === fsControls.readFailurePath
                          ? Effect.fail(
                              PlatformError.systemError({
                                _tag: 'Unknown',
                                module: 'FileSystem',
                                method: 'read',
                                cause: new Error('test read failure'),
                              }),
                            )
                          : target.read(buffer, readOptions),
                      ),
                    )
                  })
              }
              const value = Reflect.get(target, property, receiver)
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
        }),
    })
  }),
).pipe(Layer.provideMerge(NodeFileSystem.layer))
const exportFilesLayer = ExportFilesLive.pipe(Layer.provide(testFileSystem))

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
  fsControls.defectClosePath = null
  fsControls.closeCalls = 0
  fsControls.closedFile = null
  fsControls.missingStatPath = null
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
  }).pipe(Effect.provide(exportFilesLayer))
}

function writeCsvWithLivePort(
  outputPath: string,
  files: readonly { readonly name: string; readonly contents: string }[],
): Promise<string> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const exportFiles = yield* ExportFiles
      return yield* exportFiles.writeCsvFolder(outputPath, files)
    }).pipe(Effect.provide(exportFilesLayer)),
  )
}

function writeJsonFileWithLivePort(target: string, contents: string): Promise<string> {
  return Effect.runPromise(writeJsonWithLivePort(target, contents))
}

async function expectOpenedFileClosed(): Promise<void> {
  const file = fsControls.closedFile
  if (file === null) throw new Error('expected an acquired export file handle')
  const exit = await Effect.runPromiseExit(file.stat)
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    expect(
      exit.cause.reasons.some(
        reason =>
          Cause.isFailReason(reason) &&
          PlatformError.isPlatformError(reason.error) &&
          (reason.error.reason.cause as NodeJS.ErrnoException | undefined)?.code === 'EBADF',
      ),
    ).toBe(true)
  }
}

describe('export file ownership and overwrite checks', () => {
  it('accepts a normalized missing destination without depending on a native errno cause', async () => {
    const root = tempDirectory()
    const target = join(root, 'new.json')
    const contents = '{"schema":"watchtower.export.v1"}'
    fsControls.missingStatPath = target

    await expect(writeJsonFileWithLivePort(target, contents)).resolves.toBe(target)
    expect(readFileSync(target, 'utf8')).toBe(contents)
  })

  it('writes the marker, README and all nine CSV files into the resolved folder', async () => {
    const root = tempDirectory()
    const target = join(root, 'usage.csv')
    const files = [
      { name: 'README.txt', contents: 'generated once' },
      ...Array.from({ length: 9 }, (_, index) => ({ name: `table-${index}.csv`, contents: `row-${index}` })),
    ]

    await expect(writeCsvWithLivePort(target, files)).resolves.toBe(resolve(root, 'usage'))
    expect(readdirSync(join(root, 'usage')).sort()).toEqual(
      ['.watchtower-export', ...files.map(file => file.name)].sort(),
    )
    const table8 = readFileSync(join(root, 'usage', 'table-8.csv'), 'utf-8')
    expect(table8.charCodeAt(0)).toBe(0xfeff)
    expect(table8.slice(1)).toBe('row-8')
  })

  it('writes .csv files with a UTF-8 BOM but leaves the marker and README raw', async () => {
    const root = tempDirectory()
    const target = join(root, 'usage')
    await writeCsvWithLivePort(target, [
      { name: 'README.txt', contents: 'plain readme' },
      { name: 'daily.csv', contents: 'Date,Cost (USD)\n' },
    ])
    expect(readFileSync(join(root, 'usage', 'daily.csv'), 'utf-8').charCodeAt(0)).toBe(0xfeff)
    expect(readFileSync(join(root, 'usage', 'README.txt'), 'utf-8')).toBe('plain readme')
  })

  it('refuses an unmarked directory without changing its contents', async () => {
    const root = tempDirectory()
    const folder = join(root, 'occupied')
    mkdirSync(folder)
    writeFileSync(join(folder, 'keep.txt'), 'user data')

    await expect(writeCsvWithLivePort(folder, [])).rejects.toMatchObject({
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

    await writeCsvWithLivePort(folder, [{ name: 'README.txt', contents: 'new readme' }])
    expect(readdirSync(folder).sort()).toEqual(['.watchtower-export', 'README.txt'])
    expect(readFileSync(join(folder, 'README.txt'), 'utf-8')).toBe('new readme')
  })

  it('refuses a plain CSV target file without overwriting it', async () => {
    const root = tempDirectory()
    const target = join(root, 'report')
    writeFileSync(target, 'keep')

    await expect(writeCsvWithLivePort(target, [])).rejects.toMatchObject({ reason: 'csv-file-target' })
    expect(readFileSync(target, 'utf-8')).toBe('keep')
  })

  it('refuses symbolic link destinations without changing their targets', async () => {
    const root = tempDirectory()
    const markedFolder = join(root, 'marked')
    mkdirSync(markedFolder)
    writeFileSync(join(markedFolder, '.watchtower-export'), '')
    writeFileSync(join(markedFolder, 'keep.txt'), 'user data')
    const csvLink = join(root, 'linked-export')
    await symlink(markedFolder, csvLink, 'junction')

    await expect(writeCsvWithLivePort(csvLink, [])).rejects.toMatchObject({ reason: 'io-failure' })
    expect(readFileSync(join(markedFolder, 'keep.txt'), 'utf-8')).toBe('user data')
    if (process.platform !== 'win32') {
      const jsonTarget = join(root, 'owned.json')
      const original = '{"schema": "watchtower.export.v1", "old": true}'
      writeFileSync(jsonTarget, original)
      const jsonLink = join(root, 'linked.json')
      await symlink(jsonTarget, jsonLink)

      await expect(writeJsonFileWithLivePort(jsonLink, '{"schema":"watchtower.export.v1"}')).rejects.toMatchObject({
        reason: 'io-failure',
      })
      expect(readFileSync(jsonTarget, 'utf-8')).toBe(original)
    }
  })

  it('maps filesystem failures to a typed error without exposing the target path', async () => {
    const root = tempDirectory()
    const blocker = join(root, 'file')
    writeFileSync(blocker, 'not a directory')

    await expect(writeCsvWithLivePort(join(blocker, 'child'), [])).rejects.toMatchObject({
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

    await expect(writeJsonFileWithLivePort(target, '{}')).rejects.toMatchObject({ reason: 'json-unmarked-file' })
    await expect(writeJsonFileWithLivePort(folder, '{}')).rejects.toMatchObject({ reason: 'json-directory-target' })
    expect(readFileSync(target, 'utf-8')).toBe('{"user":"data"}')
    expect(readdirSync(folder)).toEqual([])
  })

  it('overwrites a prior Watchtower JSON export and adds the extension once', async () => {
    const root = tempDirectory()
    const target = join(root, 'report')
    writeFileSync(`${target}.json`, '{"schema": "watchtower.export.v1", "old": true}')

    await expect(writeJsonFileWithLivePort(target, '{"schema":"watchtower.export.v1"}')).resolves.toBe(`${target}.json`)
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
    let interruptSettled = false
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
      interruptSettled = true
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(fsControls.closeCalls).toBe(0)
    expect(interruptSettled).toBe(false)
    finishRead()
    await interrupted

    expect(fsControls.closeCalls).toBe(1)
    await expectOpenedFileClosed()
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
    await expectOpenedFileClosed()
    expect(readFileSync(target, 'utf-8')).toBe(original)
  })

  it('maps JSON header read failure to io-failure and closes once', async () => {
    const root = tempDirectory()
    const target = join(root, 'report.json')
    const original = '{"schema": "watchtower.export.v1", "old": true}'
    writeFileSync(target, original)
    fsControls.interceptedPath = target
    fsControls.readFailurePath = target

    await expect(
      Effect.runPromise(writeJsonWithLivePort(target, '{"schema":"watchtower.export.v1"}')),
    ).rejects.toMatchObject({ _tag: 'ExportFileError', reason: 'io-failure' })
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

    const exit = await Effect.runPromiseExit(writeJsonWithLivePort(target, '{"schema":"watchtower.export.v1"}'))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(exit.cause.reasons.filter(Cause.isDieReason)).toEqual([])
      const failures = exit.cause.reasons.filter(Cause.isFailReason).map(reason => reason.error)
      expect(failures).toHaveLength(2)
      for (const failure of failures) {
        expect(failure).toMatchObject({ _tag: 'ExportFileError', reason: 'io-failure' })
      }
    }
    expect(fsControls.closeCalls).toBe(1)
    await expectOpenedFileClosed()
    expect(readFileSync(target, 'utf-8')).toBe(original)
  })

  it('preserves an arbitrary release defect alongside the read failure', async () => {
    const root = tempDirectory()
    const target = join(root, 'report.json')
    const original = '{"schema": "watchtower.export.v1", "old": true}'
    writeFileSync(target, original)
    fsControls.interceptedPath = target
    fsControls.readFailurePath = target
    fsControls.defectClosePath = target

    const exit = await Effect.runPromiseExit(writeJsonWithLivePort(target, '{"schema":"watchtower.export.v1"}'))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(exit.cause.reasons.some(Cause.isFailReason)).toBe(true)
      expect(
        exit.cause.reasons.some(
          reason =>
            Cause.isDieReason(reason) &&
            reason.defect instanceof Error &&
            reason.defect.message === 'unexpected close defect',
        ),
      ).toBe(true)
      expect(
        exit.cause.reasons.some(
          reason =>
            Cause.isFailReason(reason) &&
            typeof reason.error === 'object' &&
            reason.error !== null &&
            '_tag' in reason.error &&
            reason.error._tag === 'ExportFileError' &&
            'reason' in reason.error &&
            reason.error.reason === 'io-failure',
        ),
      ).toBe(true)
    }
    expect(fsControls.closeCalls).toBe(1)
    await expectOpenedFileClosed()
    expect(readFileSync(target, 'utf-8')).toBe(original)
  })
})
