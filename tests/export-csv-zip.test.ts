import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import AdmZip from 'adm-zip'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import { afterEach, describe, expect, it } from 'vitest'

import { exportCsvZip, type ExportCsvZipPorts } from '../src/main/application/export-csv-zip.js'
import type { ExportResult } from '../src/shared/schemas/export.js'

let root = ''
let staging = ''

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
  staging = ''
})

function freshRoot(): string {
  root = mkdtempSync(join(tmpdir(), 'watchtower-export-csv-zip-'))
  return root
}

function runExport(ports: ExportCsvZipPorts): Promise<ExportResult> {
  return Effect.runPromise(exportCsvZip('20261021-095907', ports).pipe(Effect.provide(NodeFileSystem.layer)))
}

function ports(overrides: Partial<ExportCsvZipPorts> = {}): ExportCsvZipPorts {
  const directory = freshRoot()
  return {
    defaultDirectory: directory,
    showSaveDialog: async () => ({ canceled: false, filePath: join(directory, 'chosen-export') }),
    requestCsvFolder: async path => {
      staging = path
      expect(existsSync(path)).toBe(false)
      mkdirSync(path)
      writeFileSync(join(path, 'daily.csv'), 'Date,Cost\n2026-10-21,1.25')
      return { ok: true, path } as ExportResult
    },
    ...overrides,
  }
}

describe('exportCsvZip', () => {
  it('returns cancellation without requesting or creating a CSV folder', async () => {
    let requestCount = 0
    const result = await runExport(
      ports({
        showSaveDialog: async () => ({ canceled: true, filePath: '' }),
        requestCsvFolder: async () => {
          requestCount += 1
          return { ok: false, error: 'unexpected' }
        },
      }),
    )

    expect(result).toEqual({ ok: false, cancelled: true })
    expect(requestCount).toBe(0)
  })

  it('zips the worker-written folder and removes its private temp parent', async () => {
    const result = await runExport(ports())
    const target = join(root, 'chosen-export.zip')

    expect(result).toEqual({ ok: true, path: target })
    expect(existsSync(staging)).toBe(false)
    expect(existsSync(dirname(staging))).toBe(false)
    const zip = new AdmZip(target)
    const topName = 'watchtower-export-20261021-095907'
    expect(zip.getEntries().map(entry => entry.entryName)).toContain(`${topName}/daily.csv`)
    expect(zip.readAsText(`${topName}/daily.csv`)).toBe('Date,Cost\n2026-10-21,1.25')
  })

  it('returns the worker failure and removes staging', async () => {
    const result = await runExport(
      ports({
        requestCsvFolder: async path => {
          staging = path
          expect(existsSync(path)).toBe(false)
          return { ok: false, error: 'no data to export yet' }
        },
      }),
    )

    expect(result).toEqual({ ok: false, error: 'no data to export yet' })
    expect(existsSync(dirname(staging))).toBe(false)
  })

  it('keeps staging alive until an interrupted worker request settles, then removes it', async () => {
    let started!: () => void
    const requestStarted = new Promise<void>(resolve => {
      started = resolve
    })
    let finishRequest!: (result: ExportResult) => void
    const requestGate = new Promise<ExportResult>(resolve => {
      finishRequest = resolve
    })
    const program = exportCsvZip(
      '20261021-095907',
      ports({
        requestCsvFolder: path => {
          staging = path
          started()
          return requestGate
        },
      }),
    ).pipe(Effect.provide(NodeFileSystem.layer))
    const fiber = Effect.runFork(program)
    await requestStarted

    let interrupted = false
    const interruption = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
      interrupted = true
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(interrupted).toBe(false)
    expect(existsSync(dirname(staging))).toBe(true)

    finishRequest({ ok: false, error: 'worker finished' })
    await interruption

    expect(existsSync(dirname(staging))).toBe(false)
  })

  it('does not leave an archive temp file when the target is not replaceable', async () => {
    const configuredPorts = ports()
    const blocker = join(root, 'not-a-directory')
    writeFileSync(blocker, 'blocks directory creation')
    const target = join(blocker, 'chosen-export.zip')
    const result = await runExport({
      ...configuredPorts,
      showSaveDialog: async () => ({ canceled: false, filePath: target }),
    })

    expect(result).toMatchObject({ ok: false, error: expect.any(String) })
    expect(existsSync(dirname(staging))).toBe(false)
    expect(existsSync(target)).toBe(false)
  })
})
