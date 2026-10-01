import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'

import { makeWorkerOperationalLogSink } from '../src/main/db-worker/operational-log-sink.js'
import type { DbWorkerEvent } from '../src/main/db-worker/protocol.js'
import { OperationalLog, SCAN_DURATION_COUNTER } from '../src/main/operational-log.js'
import { LedgerStore } from '../src/main/store/ledger.js'
import { makeWorkerLive, makeWorkerRuntime } from '../src/main/worker-runtime.js'

describe('worker operational log forwarding', () => {
  it('forwards Effect logs, spans and service counters without a worker file writer', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'watchtower-worker-log-'))
    const ledger = new LedgerStore(join(directory, 'ledger.db'))
    const events: DbWorkerEvent[] = []
    const sink = makeWorkerOperationalLogSink(event => events.push(event))
    const runtime = makeWorkerRuntime(ledger, makeWorkerLive(ledger, sink))
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          yield* Effect.logInfo('worker.test').pipe(
            Effect.annotateLogs({
              event: 'worker.test',
              context: 'main',
              op: 'read',
              prompt: 'secret',
              file: '/private/session.json',
            }),
          )
          const log = yield* OperationalLog
          yield* log.incrementCounter(SCAN_DURATION_COUNTER, 2, { outcome: 'success', token: 'secret' })
          yield* Effect.void.pipe(Effect.withSpan('worker.test.span', { attributes: { prompt: 'secret' } }))
        }),
      )
      const records = events.filter(event => event.event === 'oplog')
      expect(records).toHaveLength(3)
      expect(records[0]).toEqual({
        event: 'oplog',
        level: 'info',
        logEvent: 'worker.test',
        fields: { op: 'read', file: 'session.json' },
      })
      expect(records[1]).toEqual({
        event: 'oplog',
        level: 'info',
        logEvent: SCAN_DURATION_COUNTER,
        fields: { outcome: 'success', count: 2 },
      })
      expect(records[2]).toMatchObject({
        event: 'oplog',
        level: 'debug',
        logEvent: 'effect.span',
        fields: { op: 'worker.test.span' },
      })
      expect(JSON.stringify(records)).not.toContain('secret')
      expect(JSON.stringify(records)).not.toContain('/private')
      expect(records.every(record => !('context' in record.fields))).toBe(true)
    } finally {
      await runtime.dispose()
      ledger.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('contains forwarding failures in all three observation paths', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'watchtower-worker-log-'))
    const ledger = new LedgerStore(join(directory, 'ledger.db'))
    const sink = makeWorkerOperationalLogSink(() => {
      throw new Error('closed port')
    })
    const runtime = makeWorkerRuntime(ledger, makeWorkerLive(ledger, sink))
    try {
      await expect(
        runtime.runPromise(
          Effect.gen(function* () {
            yield* Effect.logInfo('worker.test')
            const log = yield* OperationalLog
            yield* log.incrementCounter(SCAN_DURATION_COUNTER)
          }).pipe(Effect.withSpan('worker.test.span')),
        ),
      ).resolves.toBeUndefined()
    } finally {
      await runtime.dispose()
      ledger.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
