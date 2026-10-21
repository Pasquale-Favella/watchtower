import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import AdmZip from 'adm-zip'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as PlatformError from 'effect/PlatformError'
import { afterEach, describe, expect, it } from 'vitest'

import { ensureZipSuffix, exportStamp, zipExportFolder } from '../src/main/export-zip.js'

describe('export-zip', () => {
  const bases: string[] = []

  afterEach(() => {
    for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true })
  })

  function freshBase(): string {
    const base = mkdtempSync(join(tmpdir(), 'wt-export-zip-'))
    bases.push(base)
    return base
  }

  it('formats the local timestamp slug as YYYYMMDD-HHmmss', () => {
    expect(exportStamp(new Date(2026, 9, 21, 9, 59, 7))).toBe('20261021-095907')
  })

  it('accepts bare save-dialog paths and keeps real zip paths', () => {
    expect(ensureZipSuffix('C:\\x\\a')).toBe('C:\\x\\a.zip')
    expect(ensureZipSuffix('C:\\x\\a.zip')).toBe('C:\\x\\a.zip')
    expect(ensureZipSuffix('C:\\x\\a.ZIP')).toBe('C:\\x\\a.ZIP')
    expect(ensureZipSuffix('C:\\x\\a.zipx')).toBe('C:\\x\\a.zipx.zip')
  })

  it('atomically replaces a previous archive with one top-level folder', async () => {
    const base = freshBase()
    const topName = 'watchtower-export-20261021-095907'
    const staging = join(base, topName)
    mkdirSync(staging)
    writeFileSync(join(staging, 'daily.csv'), '€,à\r\n1,one')
    writeFileSync(join(staging, 'README.txt'), 'hello')
    writeFileSync(join(staging, '.watchtower-export'), '')

    const target = join(base, 'nested', `${topName}.zip`)
    mkdirSync(dirname(target), { recursive: true })
    const previousZip = new AdmZip()
    previousZip.addFile('previous.txt', Buffer.from('previous'))
    writeFileSync(target, previousZip.toBuffer())
    const returned = await Effect.runPromise(
      zipExportFolder(staging, target, topName).pipe(Effect.provide(NodeFileSystem.layer)),
    )

    expect(returned).toBe(target)
    expect(existsSync(target)).toBe(true)
    const zip = new AdmZip(target)
    const entryNames = zip.getEntries().map(entry => entry.entryName)
    expect(entryNames.every(name => name.startsWith(`${topName}/`))).toBe(true)
    expect(entryNames).not.toContain('previous.txt')
    expect(entryNames).toContain(`${topName}/daily.csv`)
    expect(entryNames).toContain(`${topName}/README.txt`)
    expect(entryNames).toContain(`${topName}/.watchtower-export`)
    expect(zip.readAsText(`${topName}/daily.csv`)).toContain('€,à')
    expect(zip.readAsText(`${topName}/README.txt`)).toBe('hello')
  })

  it('preserves the previous archive and removes the temp file when replacement fails', async () => {
    const base = freshBase()
    const topName = 'watchtower-export-20261021-095907'
    const staging = join(base, topName)
    mkdirSync(staging)
    writeFileSync(join(staging, 'daily.csv'), '1,one')

    const target = join(base, 'nested', `${topName}.zip`)
    mkdirSync(dirname(target))
    const previousZip = new AdmZip()
    previousZip.addFile('previous.txt', Buffer.from('previous'))
    const previousArchive = previousZip.toBuffer()
    writeFileSync(target, previousArchive)
    const renameFailureLayer = Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        return FileSystem.FileSystem.of({
          ...fs,
          rename: () =>
            Effect.fail(
              PlatformError.systemError({
                _tag: 'Unknown',
                module: 'FileSystem',
                method: 'rename',
                cause: new Error('simulated rename failure'),
              }),
            ),
        })
      }),
    ).pipe(Layer.provideMerge(NodeFileSystem.layer))

    await expect(
      Effect.runPromise(zipExportFolder(staging, target, topName).pipe(Effect.provide(renameFailureLayer))),
    ).rejects.toMatchObject({
      _tag: 'ExportZipError',
      cause: expect.objectContaining({
        reason: expect.objectContaining({
          cause: expect.objectContaining({ message: 'simulated rename failure' }),
        }),
      }),
    })

    expect(readFileSync(target)).toEqual(previousArchive)
    expect(new AdmZip(target).readAsText('previous.txt')).toBe('previous')
    expect(
      readdirSync(dirname(target)).filter(name => name.startsWith(`${basename(target)}.`) && name.endsWith('.tmp')),
    ).toEqual([])
  })
})
