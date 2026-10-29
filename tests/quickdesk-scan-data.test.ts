import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Effect, Fiber, Stream } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  reads: new Map<string, number>(),
  opened: 0,
  closed: 0,
  pausePath: '',
  onReadStarted: undefined as (() => void) | undefined,
  releaseRead: undefined as (() => void) | undefined,
}))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      const path = String(args[0])
      native.reads.set(path, (native.reads.get(path) ?? 0) + 1)
      if (path === native.pausePath) {
        return new Promise<Awaited<ReturnType<typeof actual.readFile>>>((resolve, reject) => {
          native.releaseRead = () => void actual.readFile(...args).then(resolve, reject)
          native.onReadStarted?.()
        })
      }
      return actual.readFile(...args)
    },
  }
})

vi.mock('../src/infrastructure/ingestion/sqlite.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/infrastructure/ingestion/sqlite.js')>()
  return {
    ...actual,
    openDatabase: (...args: Parameters<typeof actual.openDatabase>) => {
      const db = actual.openDatabase(...args)
      native.opened++
      return {
        ...db,
        close: () => {
          db.close()
          native.closed++
        },
      }
    },
  }
})

import {
  createQuickdeskProvider,
  createQuickdeskScanData,
  type QuickdeskScanData,
  QuickdeskScanReads,
} from '../src/infrastructure/provider-adapters/quickdesk.js'
import type { ParsedProviderCall, SessionSource } from '../src/infrastructure/provider-adapters/types.js'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watchtower-quickdesk-scan-data-'))
  native.reads.clear()
  native.opened = 0
  native.closed = 0
  native.pausePath = ''
  native.onReadStarted = undefined
  native.releaseRead = undefined
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function metric(path: string, sessionId: string, cost: number): void {
  writeFileSync(
    path,
    JSON.stringify({ Model: 'test-model', InputTokens: 10, OutputTokens: 5, CostUSD: cost, session_id: sessionId }),
  )
}

async function parse(path: string, scanData: QuickdeskScanData): Promise<ParsedProviderCall[]> {
  const source: SessionSource = {
    path,
    project: 'fixture',
    provider: 'quickdesk',
    sourceId: path.endsWith('.db') ? 'sessions-db' : 'metrics',
    sourcePath: root,
  }
  const parser = createQuickdeskProvider(root).createSessionParser(source, new Set())
  if (!parser.parseStream) throw new Error('Missing native parser')
  return Effect.runPromise(
    Stream.runCollect(parser.parseStream()).pipe(Effect.provideService(QuickdeskScanReads, scanData)),
  )
}

describe('QuickDesk scan-owned decoded data', () => {
  it('creates its capability without reading files or opening databases', async () => {
    await Effect.runPromise(createQuickdeskScanData())
    expect(native.reads.size).toBe(0)
    expect(native.opened).toBe(0)
  })

  it('reuses metrics and one closed snapshot across metric files and database exclusion', async () => {
    mkdirSync(join(root, 'metrics'))
    mkdirSync(join(root, 'sessions'))
    const first = join(root, 'metrics', 'metrics-2026-10-01.jsonl')
    const second = join(root, 'metrics', 'metrics-2026-10-02.jsonl')
    metric(first, 'one', 0)
    metric(second, 'two', 2)
    const dbPath = join(root, 'sessions', 'sessions.db')
    const db = new DatabaseSync(dbPath)
    try {
      db.exec(`CREATE TABLE sessions (id TEXT, created_at INTEGER, deleted_at TEXT);
        CREATE TABLE session_messages (session_id TEXT, role TEXT, content TEXT, tool_names TEXT, timestamp INTEGER);
        INSERT INTO sessions VALUES ('one', 1790812800, NULL), ('two', 1790899200, NULL);
        INSERT INTO session_messages VALUES ('one', 'user', 'first prompt', '[]', 1), ('one', 'assistant', 'answer', '[]', 2),
          ('two', 'user', 'second prompt', '[]', 1), ('two', 'assistant', 'answer', '[]', 2);`)
    } finally {
      db.close()
    }
    const context = await Effect.runPromise(createQuickdeskScanData())

    const firstCalls = await parse(first, context)
    const secondCalls = await parse(second, context)
    const databaseCalls = await parse(dbPath, context)

    expect(firstCalls[0]).toMatchObject({ costUSD: 0, costIsEstimated: false, userMessage: 'first prompt' })
    expect(secondCalls[0]).toMatchObject({ costUSD: 2, costIsEstimated: false, userMessage: 'second prompt' })
    expect(databaseCalls).toEqual([])
    expect(native.reads.get(first)).toBe(1)
    expect(native.reads.get(second)).toBe(1)
    expect(native.opened).toBe(1)
    expect(native.closed).toBe(1)
  })

  it('reads fresh metrics in the next scan without changing the previous scan data', async () => {
    mkdirSync(join(root, 'metrics'))
    const path = join(root, 'metrics', 'metrics-2026-10-01.jsonl')
    metric(path, 'one', 1)
    const first = await Effect.runPromise(createQuickdeskScanData())
    expect((await parse(path, first))[0]?.costUSD).toBe(1)
    metric(path, 'one', 3)
    expect((await parse(path, first))[0]?.costUSD).toBe(1)
    const next = await Effect.runPromise(createQuickdeskScanData())
    expect((await parse(path, next))[0]?.costUSD).toBe(3)
    expect(native.reads.get(path)).toBe(2)
  })

  it('rejects an aborted lookup even when its decoded records are already cached', async () => {
    const path = join(root, 'metrics-2026-10-01.jsonl')
    metric(path, 'one', 1)
    const controller = new AbortController()
    const data = await Effect.runPromise(createQuickdeskScanData(controller.signal))
    await Effect.runPromise(data.readMetrics(path))
    controller.abort(new Error('stop scan'))
    await expect(Effect.runPromise(data.readMetrics(path))).rejects.toHaveProperty('name', 'ScanAbortedError')
    expect(native.reads.get(path)).toBe(1)
  })

  it('drains the pending shared native read before its last consumer finishes interruption', async () => {
    const path = join(root, 'metrics-2026-10-01.jsonl')
    metric(path, 'one', 1)
    native.pausePath = path
    const started = new Promise<void>(resolve => {
      native.onReadStarted = resolve
    })
    const data = await Effect.runPromise(createQuickdeskScanData())
    const fiber = Effect.runFork(data.readMetrics(path))
    await started
    let stopped = false
    const stop = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
      stopped = true
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    const stoppedBeforeReadSettled = stopped
    native.releaseRead?.()
    await stop
    expect(stoppedBeforeReadSettled).toBe(false)
    expect(stopped).toBe(true)
    expect(native.reads.get(path)).toBe(1)
  })
})
