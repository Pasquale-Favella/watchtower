import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Metric from 'effect/Metric'
import * as SqlClient from 'effect/sql/SqlClient'
import { describe, expect, it, vi } from 'vitest'

import { DbWorkerContext } from '../src/main/db-worker/context.js'
import { makeWorkerOperationalLogSink } from '../src/main/db-worker/operational-log-sink.js'
import type { DbWorkerEvent } from '../src/main/db-worker/protocol.js'
import { OperationalLog, SCAN_DURATION_COUNTER } from '../src/main/operational-log.js'
import { HttpFetch } from '../src/main/pipeline/fetch-utils.js'
import { LedgerConfig } from '../src/main/store/ledger-repository.js'
import { openWorkerRuntime } from '../src/main/worker-runtime.js'

function removeTemporaryDirectory(directory: string, prefix: string): void {
  const resolvedDirectory = resolve(directory)
  const resolvedParent = dirname(resolvedDirectory)
  const resolvedTempDirectory = resolve(tmpdir())
  const directoryName = basename(resolvedDirectory)
  if (
    resolvedParent !== resolvedTempDirectory ||
    !directoryName.startsWith(prefix) ||
    directoryName.length <= prefix.length
  ) {
    throw new Error(`Refusing to remove unexpected temporary directory: ${resolvedDirectory}`)
  }
  rmSync(resolvedDirectory, { recursive: true, force: true })
}

describe('worker operational log forwarding', () => {
  it('logs a malformed FX cache once without fetching or publishing a successful currency', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'watchtower-worker-fx-error-'))
    const events: DbWorkerEvent[] = []
    const failure = Deferred.makeUnsafe<DbWorkerEvent>()
    const emit = (event: DbWorkerEvent): void => {
      events.push(event)
      if (event.event === 'oplog' && event.logEvent === 'currency.refresh.error') {
        Effect.runSync(Deferred.succeed(failure, event))
      }
    }
    const fetch = vi.fn<typeof globalThis.fetch>()
    const dbPath = join(directory, 'ledger.db')
    let runtime: ReturnType<typeof openWorkerRuntime> | undefined
    let context: DbWorkerContext | undefined
    try {
      runtime = openWorkerRuntime(dbPath, makeWorkerOperationalLogSink(emit), HttpFetch.layerWithFetch(fetch))
      runtime.runSync(
        Effect.gen(function* () {
          const config = yield* LedgerConfig
          const sql = yield* SqlClient.SqlClient
          yield* config.setDisplayCurrency('EUR')
          yield* sql.unsafe(
            "INSERT INTO currency_rate (code, symbol, rate, updated_at) VALUES ('EUR', '€', 'malformed', 'old')",
          )
        }),
      )
      context = new DbWorkerContext({ dbPath, dataDir: directory, cacheDir: join(directory, 'cache') }, emit, {
        runtime,
      })
      expect(await Effect.runPromise(Deferred.await(failure))).toMatchObject({
        event: 'oplog',
        level: 'error',
        logEvent: 'currency.refresh.error',
        fields: { op: 'currency.refresh', code: 'SchemaError' },
      })
      expect(fetch).not.toHaveBeenCalled()
      expect(events.filter(event => event.event === 'currency:changed')).toEqual([])
      expect(
        events.filter(event => event.event === 'oplog' && event.logEvent === 'currency.refresh.error'),
      ).toHaveLength(1)
    } finally {
      try {
        if (context) await context.close()
      } finally {
        try {
          if (runtime) await runtime.dispose()
        } finally {
          removeTemporaryDirectory(directory, 'watchtower-worker-fx-error-')
        }
      }
    }
  })

  it('forwards Effect logs, spans and service counters without a worker file writer', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'watchtower-worker-log-'))
    const events: DbWorkerEvent[] = []
    const sink = makeWorkerOperationalLogSink(event => events.push(event))
    let runtime: ReturnType<typeof openWorkerRuntime> | undefined
    try {
      runtime = openWorkerRuntime(join(directory, 'ledger.db'), sink)
      const metrics = await runtime.runPromise(
        Effect.gen(function* () {
          const before = yield* Metric.value(Metric.counter(SCAN_DURATION_COUNTER))
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
          const after = yield* Metric.value(Metric.counter(SCAN_DURATION_COUNTER))
          return { before: before.count, after: after.count }
        }),
      )
      expect(metrics).toEqual({ before: 0, after: 2 })
      const sqlTraceStart = events.length
      runtime.runSync(Effect.flatMap(LedgerConfig, config => config.getRefreshCadence()))
      const records = events
        .slice(0, sqlTraceStart)
        .filter(
          event =>
            event.event === 'oplog' &&
            (event.logEvent === 'worker.test' ||
              event.logEvent === SCAN_DURATION_COUNTER ||
              (event.logEvent === 'effect.span' && event.fields.op === 'worker.test.span')),
        )
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
      expect(records.every(record => record.event !== 'oplog' || !('context' in record.fields))).toBe(true)
      expect(
        events.slice(sqlTraceStart).some(event => {
          if (event.event !== 'oplog') return false
          return event.logEvent === 'effect.span' && event.fields.op === 'LedgerConfig.getRefreshCadence'
        }),
      ).toBe(true)
      expect(
        events
          .slice(sqlTraceStart)
          .filter(
            event => event.event === 'oplog' && (event.fields.op === 'sql.execute' || event.fields.op === 'sqlite'),
          ),
      ).toEqual([])
    } finally {
      try {
        if (runtime) await runtime.dispose()
      } finally {
        removeTemporaryDirectory(directory, 'watchtower-worker-log-')
      }
    }
  })

  it('contains forwarding failures in all three observation paths', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'watchtower-worker-log-'))
    const sink = makeWorkerOperationalLogSink(() => {
      throw new Error('closed port')
    })
    let runtime: ReturnType<typeof openWorkerRuntime> | undefined
    try {
      runtime = openWorkerRuntime(join(directory, 'ledger.db'), sink)
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
      try {
        if (runtime) await runtime.dispose()
      } finally {
        removeTemporaryDirectory(directory, 'watchtower-worker-log-')
      }
    }
  })
})
