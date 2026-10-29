import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import * as Stream from 'effect/Stream'
import { describe, expect, it } from 'vitest'

import type { DbWorkerEvent } from '../src/platform/electron/workers/protocol.js'
import type { LifecyclePublishEvent } from '../src/platform/electron/main/rpc/lifecycle.js'
import {
  LifecycleHub,
  lifecycleLayer,
  type LifecycleSnapshotReader,
} from '../src/platform/electron/main/rpc/lifecycle.js'
import { lifecycleEventFromWorker } from '../src/platform/electron/main/rpc/worker-events.js'
import type { ScanStatus } from '../src/shared/schemas/ipc.js'

const reader: LifecycleSnapshotReader = {
  scanStatus: () => Effect.succeed({ scanned: false } satisfies ScanStatus),
  scanActivity: () => Effect.succeed({ scanning: false, progress: null, error: null }),
  currency: () => Effect.succeed({ code: 'USD', symbol: '$', rate: 1 }),
  updater: () =>
    Effect.succeed({
      revision: 0,
      currentVersion: '1.0.0',
      latestVersion: null,
      updateAvailable: false,
      tag: null,
      phase: 'idle',
      installSupported: false,
      progress: null,
      message: null,
    }),
  harnesses: () => Effect.succeed([]),
}

describe('worker lifecycle event mapping', () => {
  it('maps validated worker events and ignores operational logs', () => {
    const events: ReadonlyArray<readonly [DbWorkerEvent, LifecyclePublishEvent | undefined]> = [
      [
        { event: 'scan:progress', manual: true, progress: { stage: 'parse', processed: 1, total: 2 } },
        {
          _tag: 'ScanProgress',
          progress: { stage: 'parse', processed: 1, total: 2 },
        },
      ],
      [
        { event: 'scan:error', manual: false, message: 'scan failed' },
        { _tag: 'ScanError', message: 'scan failed' },
      ],
      [{ event: 'scan:idle' }, { _tag: 'ScanIdle' }],
      [
        {
          event: 'store:changed',
          metadata: {
            scanId: 'scan-1',
            startedAt: '2026-10-23T10:00:00.000Z',
            completedAt: '2026-10-23T10:01:00.000Z',
            portedFiles: 1,
            unchangedFiles: 0,
            failedFiles: 0,
            perProvider: [{ provider: 'opencode', ported: 1, unchanged: 0, failed: 0, unparsed: 0 }],
            aborted: false,
          },
        },
        {
          _tag: 'StoreChanged',
          metadata: {
            scanId: 'scan-1',
            startedAt: '2026-10-23T10:00:00.000Z',
            completedAt: '2026-10-23T10:01:00.000Z',
            portedFiles: 1,
            unchangedFiles: 0,
            failedFiles: 0,
            perProvider: [{ provider: 'opencode', ported: 1, unchanged: 0, failed: 0, unparsed: 0 }],
            aborted: false,
          },
        },
      ],
      [{ event: 'config:changed' }, { _tag: 'ConfigChanged' }],
      [{ event: 'ledger:reset' }, { _tag: 'LedgerReset' }],
      [
        { event: 'currency:changed', currency: { code: 'EUR', symbol: '€', rate: 0.9 } },
        {
          _tag: 'CurrencyChanged',
          currency: { code: 'EUR', symbol: '€', rate: 0.9 },
        },
      ],
      [{ event: 'oplog', level: 'error', logEvent: 'scan.error', fields: { code: 'failed' } }, undefined],
    ]

    for (const [input, expected] of events) {
      const mapped = lifecycleEventFromWorker(input)
      expect(Result.isSuccess(mapped)).toBe(true)
      if (Result.isSuccess(mapped)) expect(mapped.success).toEqual(expected)
    }
  })

  it('rejects malformed payloads with safe errors before the hub state changes', async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const hub = yield* LifecycleHub
        const malformed = lifecycleEventFromWorker({
          event: 'store:changed',
          metadata: { privateProviderPath: 'C:/sensitive/provider.json' },
        } as DbWorkerEvent)
        if (Result.isSuccess(malformed) && malformed.success !== undefined) yield* hub.publish(malformed.success)
        const frame = Option.getOrThrow(yield* Stream.runHead(hub.events('app')))
        return { malformed, frame, subscribers: yield* hub.subscriberCount }
      }).pipe(Effect.provide(lifecycleLayer({ epoch: 'worker-mapping', readSnapshot: reader }))),
    )

    expect(Result.isFailure(outcome.malformed)).toBe(true)
    if (Result.isFailure(outcome.malformed)) {
      expect(outcome.malformed.failure).toMatchObject({
        _tag: 'WorkerLifecycleEventError',
        code: 'invalid-payload',
        event: 'store:changed',
      })
      expect(JSON.stringify(outcome.malformed.failure)).not.toContain('sensitive')
    }
    expect(outcome.frame).toMatchObject({ _tag: 'Snapshot', state: { sequence: 0, scanStatus: { scanned: false } } })
    expect(outcome.subscribers).toBe(0)
  })
})
