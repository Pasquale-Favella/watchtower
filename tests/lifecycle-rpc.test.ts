import * as Cause from 'effect/Cause'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'
import { describe, expect, it } from 'vitest'

import { LifecycleHub, lifecycleLayer, type LifecycleSnapshotReader } from '../src/main/rpc/lifecycle.js'
import type { LifecycleEvent } from '../src/shared/rpc/lifecycle.js'
import type { CoachHarnessRow } from '../src/shared/schemas/agents.js'
import type { ActiveCurrency } from '../src/shared/schemas/fx.js'
import type { ScanStatus } from '../src/shared/schemas/ipc.js'
import type { UpdateStatus } from '../src/shared/schemas/updates.js'

const usd: ActiveCurrency = { code: 'USD', symbol: '$', rate: 1 }
const eur: ActiveCurrency = { code: 'EUR', symbol: '€', rate: 0.92 }
const status: UpdateStatus = {
  revision: 1,
  currentVersion: '1.0.0',
  latestVersion: null,
  updateAvailable: false,
  tag: null,
  phase: 'idle',
  installSupported: true,
  progress: null,
  message: null,
}
const harnesses: CoachHarnessRow[] = [
  {
    instanceId: 'codex',
    kind: 'codex',
    displayName: 'Codex',
    status: 'ready',
    auth: { status: 'configured', label: 'Signed in' },
  },
]
const scanStatus: ScanStatus = { scanned: true }

function required<A>(value: A | undefined): A {
  if (value === undefined) throw new Error('Expected stream frame')
  return value
}

function reader(overrides: Partial<LifecycleSnapshotReader> = {}): LifecycleSnapshotReader {
  return {
    scanStatus: () => Effect.succeed(scanStatus),
    scanActivity: () => Effect.succeed({ scanning: false, progress: null, error: null }),
    currency: () => Effect.succeed(usd),
    updater: () => Effect.succeed(status),
    harnesses: () => Effect.succeed(harnesses),
    ...overrides,
  }
}

function progressEvent(provider: string): LifecycleEvent {
  return { _tag: 'ScanProgress', progress: { stage: 'parse', provider, processed: 1, total: 3 } }
}

const storeEvent: LifecycleEvent = {
  _tag: 'StoreChanged',
  metadata: {
    scanId: 'scan-1',
    startedAt: '2026-10-23T10:00:00.000Z',
    completedAt: '2026-10-23T10:01:00.000Z',
    portedFiles: 1,
    unchangedFiles: 0,
    failedFiles: 0,
    perProvider: [],
    aborted: false,
  },
}

describe('main lifecycle RPC hub', () => {
  it('subscribes before reading and merges events received during snapshot reads', async () => {
    const gates = await Effect.runPromise(
      Effect.all({
        entered: Deferred.make<undefined>(),
        release: Deferred.make<undefined>(),
        emitted: Deferred.make<undefined>(),
      }),
    )
    const gatedReader = reader({
      scanActivity: () =>
        Effect.succeed({
          scanning: true,
          progress: { stage: 'port-in', provider: 'opencode', processed: 2, total: 2 },
          error: null,
        }),
      scanStatus: () =>
        Effect.andThen(Deferred.succeed(gates.entered, undefined), Deferred.await(gates.release)).pipe(
          Effect.as(scanStatus),
        ),
    })
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const hub = yield* LifecycleHub
        const frames = yield* Effect.forkChild(
          Stream.runCollect(
            hub.events('app').pipe(
              Stream.tap(frame =>
                frame._tag === 'Snapshot' ? Deferred.succeed(gates.emitted, undefined) : Effect.void,
              ),
              Stream.take(2),
            ),
          ),
          { startImmediately: true },
        )
        yield* Deferred.await(gates.entered)
        expect(yield* hub.subscriberCount).toBe(1)
        yield* hub.publish({ _tag: 'CurrencyChanged', currency: eur })
        yield* hub.publish({ _tag: 'UpdateChanged', status: { ...status, revision: 2, phase: 'available' } })
        yield* hub.publish(storeEvent)
        yield* Deferred.succeed(gates.release, undefined)
        yield* Deferred.await(gates.emitted)
        yield* hub.publish(progressEvent('claude'))
        return yield* Fiber.join(frames)
      }).pipe(Effect.provide(lifecycleLayer({ epoch: 'epoch-a', readSnapshot: gatedReader }))),
    )

    expect(events).toHaveLength(2)
    const first = required(events[0])
    expect(first._tag).toBe('Snapshot')
    if (first._tag !== 'Snapshot' || first.role !== 'app') throw new Error('Expected app snapshot')
    expect(first.state.sequence).toBe(3)
    expect(required(first.state.scanStatus).metadata).toEqual(storeEvent.metadata)
    expect(required(first.state.scanActivity).scanning).toBe(false)
    expect(first.state.harnesses).toEqual(harnesses)
    expect(required(first.state.currency).code).toBe('EUR')
    expect(required(first.state.updater).phase).toBe('available')
    const next = required(events[1])
    expect(next._tag).toBe('Event')
    if (next._tag !== 'Event') throw new Error('Expected live event')
    expect(next.envelope.sequence).toBe(4)
    expect(next.envelope.event._tag).toBe('ScanProgress')
  })

  it('hydrates cold snapshots with the canonical main-owned values and role fields', async () => {
    const snapshots = await Effect.runPromise(
      Effect.gen(function* () {
        const hub = yield* LifecycleHub
        const app = Option.getOrThrow(yield* Stream.runHead(hub.events('app')))
        const panel = Option.getOrThrow(yield* Stream.runHead(hub.events('panel')))
        const beacon = Option.getOrThrow(yield* Stream.runHead(hub.events('beacon')))
        return { app, panel, beacon, subscribers: yield* hub.subscriberCount }
      }).pipe(Effect.provide(lifecycleLayer({ epoch: 'epoch-cold', readSnapshot: reader() }))),
    )

    expect(snapshots.app._tag).toBe('Snapshot')
    if (snapshots.app._tag !== 'Snapshot' || snapshots.app.role !== 'app') throw new Error('Expected app snapshot')
    expect(snapshots.app.state).toMatchObject({
      epoch: 'epoch-cold',
      sequence: 0,
      scanStatus,
      currency: usd,
      updater: status,
      harnesses,
    })
    expect(snapshots.panel._tag).toBe('Snapshot')
    if (snapshots.panel._tag !== 'Snapshot' || snapshots.panel.role !== 'panel')
      throw new Error('Expected panel snapshot')
    expect(snapshots.panel.state).toMatchObject({ hasScanned: true, currency: usd, resetGeneration: 0 })
    expect(snapshots.panel.state).not.toHaveProperty('updater')
    expect(snapshots.panel.state).not.toHaveProperty('harnesses')
    expect(snapshots.panel.state).not.toHaveProperty('ledgerGeneration')
    expect(snapshots.panel.state).not.toHaveProperty('configRevision')
    expect(snapshots.beacon._tag).toBe('Snapshot')
    if (snapshots.beacon._tag !== 'Snapshot' || snapshots.beacon.role !== 'beacon')
      throw new Error('Expected beacon snapshot')
    expect(Object.keys(snapshots.beacon.state).sort()).toEqual(['epoch', 'scanActivity', 'sequence'])
    expect(snapshots.subscribers).toBe(0)
  })

  it('filters live categories by role while preserving global sequence and reset/config revisions', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const hub = yield* LifecycleHub
        const snapshotsSeen = yield* Effect.all([
          Deferred.make<undefined>(),
          Deferred.make<undefined>(),
          Deferred.make<undefined>(),
        ])
        const collect = (role: 'app' | 'panel' | 'beacon', signal: Deferred.Deferred<undefined>) =>
          Effect.forkChild(
            Stream.runCollect(
              hub.events(role).pipe(
                Stream.tap(frame => (frame._tag === 'Snapshot' ? Deferred.succeed(signal, undefined) : Effect.void)),
                Stream.take(2),
              ),
            ),
            { startImmediately: true },
          )
        const app = yield* collect('app', required(snapshotsSeen[0]))
        const panel = yield* collect('panel', required(snapshotsSeen[1]))
        const beacon = yield* collect('beacon', required(snapshotsSeen[2]))
        yield* Effect.all(snapshotsSeen.map(signal => Deferred.await(signal)))
        yield* hub.publish({ _tag: 'UpdateChanged', status })
        yield* hub.publish({ _tag: 'HarnessesChanged', rows: harnesses })
        yield* hub.publish({ _tag: 'CurrencyChanged', currency: eur })
        yield* hub.publish(progressEvent('claude'))
        const [appFrames, panelFrames, beaconFrames] = yield* Effect.all([
          Fiber.join(app),
          Fiber.join(panel),
          Fiber.join(beacon),
        ])
        const resetSnapshotSeen = yield* Deferred.make<undefined>()
        const resetFramesFiber = yield* Effect.forkChild(
          Stream.runCollect(
            hub.events('app').pipe(
              Stream.tap(frame =>
                frame._tag === 'Snapshot' ? Deferred.succeed(resetSnapshotSeen, undefined) : Effect.void,
              ),
              Stream.take(4),
            ),
          ),
          { startImmediately: true },
        )
        yield* Deferred.await(resetSnapshotSeen)
        const configBefore = yield* hub.currentConfigRevision
        yield* hub.publish({ _tag: 'ConfigChanged' })
        const configAfter = yield* hub.currentConfigRevision
        yield* hub.publish(storeEvent)
        yield* hub.publish({ _tag: 'LedgerReset' })
        const revision = yield* hub.currentConfigRevision
        const lifecycleFrames = yield* Fiber.join(resetFramesFiber)
        return { appFrames, panelFrames, beaconFrames, lifecycleFrames, configBefore, configAfter, revision }
      }).pipe(Effect.provide(lifecycleLayer({ epoch: 'epoch-sequence', readSnapshot: reader() }))),
    )

    expect(result.appFrames[1]).toMatchObject({
      _tag: 'Event',
      envelope: { sequence: 1, event: { _tag: 'UpdateChanged' } },
    })
    expect(result.panelFrames[1]).toMatchObject({
      _tag: 'Event',
      envelope: { sequence: 3, event: { _tag: 'CurrencyChanged' } },
    })
    expect(result.beaconFrames[1]).toMatchObject({
      _tag: 'Event',
      envelope: { sequence: 4, event: { _tag: 'ScanProgress' } },
    })
    expect(result.configBefore).toBe(0)
    expect(result.configAfter).toBe(1)
    expect(result.revision).toBe(1)
    expect(result.lifecycleFrames[0]).toMatchObject({ _tag: 'Snapshot', state: { sequence: 4, ledgerGeneration: 0 } })
    expect(result.lifecycleFrames[1]).toMatchObject({
      _tag: 'Event',
      envelope: { sequence: 5, configRevision: 1, event: { _tag: 'ConfigChanged', configRevision: 1 } },
    })
    expect(result.lifecycleFrames[2]).toMatchObject({
      _tag: 'Event',
      envelope: { sequence: 6, ledgerGeneration: 0, event: { _tag: 'StoreChanged' } },
    })
    expect(result.lifecycleFrames[3]).toMatchObject({
      _tag: 'Event',
      envelope: { sequence: 7, ledgerGeneration: 1, event: { _tag: 'LedgerReset', ledgerGeneration: 1 } },
    })
  })

  it('keeps StoreChanged metadata out of panel and beacon event frames', async () => {
    const frames = await Effect.runPromise(
      Effect.gen(function* () {
        const hub = yield* LifecycleHub
        const panelSnapshot = yield* Deferred.make<undefined>()
        const beaconSnapshot = yield* Deferred.make<undefined>()
        const collect = (role: 'panel' | 'beacon', signal: Deferred.Deferred<undefined>) =>
          Effect.forkChild(
            Stream.runCollect(
              hub.events(role).pipe(
                Stream.tap(frame => (frame._tag === 'Snapshot' ? Deferred.succeed(signal, undefined) : Effect.void)),
                Stream.take(2),
              ),
            ),
            { startImmediately: true },
          )
        const panel = yield* collect('panel', panelSnapshot)
        const beacon = yield* collect('beacon', beaconSnapshot)
        yield* Effect.all([Deferred.await(panelSnapshot), Deferred.await(beaconSnapshot)])
        yield* hub.publish(storeEvent)
        return yield* Effect.all([Fiber.join(panel), Fiber.join(beacon)])
      }).pipe(Effect.provide(lifecycleLayer({ epoch: 'epoch-redacted', readSnapshot: reader() }))),
    )

    const panelEvent = frames[0][1]
    const beaconEvent = frames[1][1]
    expect(panelEvent).toMatchObject({ _tag: 'Event', envelope: { event: { _tag: 'LedgerChanged' } } })
    expect(panelEvent).not.toHaveProperty('envelope.event.metadata')
    expect(beaconEvent).toMatchObject({ _tag: 'Event', envelope: { event: { _tag: 'ScanIdle' } } })
    expect(beaconEvent).not.toHaveProperty('envelope.ledgerGeneration')
    expect(beaconEvent).not.toHaveProperty('envelope.event.metadata')
  })

  it('reads only the snapshot capabilities allowed for panel and beacon roles', async () => {
    const frames = await Effect.runPromise(
      Effect.gen(function* () {
        const hub = yield* LifecycleHub
        const beacon = Option.getOrThrow(yield* Stream.runHead(hub.events('beacon')))
        return { beacon }
      }).pipe(
        Effect.provide(
          lifecycleLayer({
            epoch: 'epoch-beacon',
            readSnapshot: reader({
              scanStatus: () => Effect.fail(new Error('ledger unavailable')),
              currency: () => Effect.fail(new Error('currency unavailable')),
              updater: () => Effect.fail(new Error('updater unavailable')),
              harnesses: () => Effect.fail(new Error('harnesses unavailable')),
            }),
          }),
        ),
      ),
    )

    const panelFrame = await Effect.runPromise(
      Effect.gen(function* () {
        const hub = yield* LifecycleHub
        return Option.getOrThrow(yield* Stream.runHead(hub.events('panel')))
      }).pipe(
        Effect.provide(
          lifecycleLayer({
            epoch: 'epoch-panel',
            readSnapshot: reader({
              updater: () => Effect.fail(new Error('updater unavailable')),
              harnesses: () => Effect.fail(new Error('harnesses unavailable')),
            }),
          }),
        ),
      ),
    )

    expect(frames.beacon).toMatchObject({ _tag: 'Snapshot', role: 'beacon', state: { epoch: 'epoch-beacon' } })
    expect(panelFrame).toMatchObject({ _tag: 'Snapshot', role: 'panel', state: { epoch: 'epoch-panel' } })
  })

  it('projects app snapshot metadata by selected category', async () => {
    const categoryFields = [
      ['store', 'scanStatus', 'scanStatus'],
      ['scan', 'scanActivity', 'scanActivity'],
      ['currency', 'currency', 'currency'],
      ['updates', 'updater', 'updater'],
      ['harnesses', 'harnesses', 'harnesses'],
    ] as const

    for (const [category, expectedField, expectedReader] of categoryFields) {
      const calls = { scanStatus: 0, scanActivity: 0, currency: 0, updater: 0, harnesses: 0 }
      const selectedReader = reader({
        scanStatus: () => {
          calls.scanStatus++
          return Effect.succeed(scanStatus)
        },
        scanActivity: () => {
          calls.scanActivity++
          return Effect.succeed({ scanning: false, progress: null, error: null })
        },
        currency: () => {
          calls.currency++
          return Effect.succeed(usd)
        },
        updater: () => {
          calls.updater++
          return Effect.succeed(status)
        },
        harnesses: () => {
          calls.harnesses++
          return Effect.succeed(harnesses)
        },
      })
      const frame = await Effect.runPromise(
        Effect.gen(function* () {
          const hub = yield* LifecycleHub
          return Option.getOrThrow(yield* Stream.runHead(hub.events('app', [category])))
        }).pipe(Effect.provide(lifecycleLayer({ epoch: `epoch-${category}`, readSnapshot: selectedReader }))),
      )

      expect(frame._tag).toBe('Snapshot')
      if (frame._tag !== 'Snapshot' || frame.role !== 'app') throw new Error('Expected app snapshot')
      expect(Object.keys(frame.state).sort()).toEqual(
        ['configRevision', 'epoch', 'ledgerGeneration', 'sequence', expectedField].sort(),
      )
      expect(calls).toEqual({
        scanStatus: Number(expectedReader === 'scanStatus'),
        scanActivity: Number(expectedReader === 'scanActivity'),
        currency: Number(expectedReader === 'currency'),
        updater: Number(expectedReader === 'updater'),
        harnesses: Number(expectedReader === 'harnesses'),
      })
    }
  })

  it('delivers config and reset from a header-only snapshot when every metadata read fails', async () => {
    const calls = { scanStatus: 0, scanActivity: 0, currency: 0, updater: 0, harnesses: 0 }
    const failedReader = reader({
      scanStatus: () => {
        calls.scanStatus++
        return Effect.fail(new Error('scan status unavailable'))
      },
      scanActivity: () => {
        calls.scanActivity++
        return Effect.fail(new Error('scan activity unavailable'))
      },
      currency: () => {
        calls.currency++
        return Effect.fail(new Error('currency unavailable'))
      },
      updater: () => {
        calls.updater++
        return Effect.fail(new Error('updater unavailable'))
      },
      harnesses: () => {
        calls.harnesses++
        return Effect.fail(new Error('harnesses unavailable'))
      },
    })
    const frames = await Effect.runPromise(
      Effect.gen(function* () {
        const hub = yield* LifecycleHub
        const snapshotSeen = yield* Deferred.make<undefined>()
        const subscriber = yield* Effect.forkChild(
          Stream.runCollect(
            hub.events('app', ['config', 'reset']).pipe(
              Stream.tap(frame =>
                frame._tag === 'Snapshot' ? Deferred.succeed(snapshotSeen, undefined) : Effect.void,
              ),
              Stream.take(3),
            ),
          ),
          { startImmediately: true },
        )
        yield* Deferred.await(snapshotSeen)
        yield* hub.publish({ _tag: 'ConfigChanged' })
        yield* hub.publish({ _tag: 'LedgerReset' })
        return yield* Fiber.join(subscriber)
      }).pipe(Effect.provide(lifecycleLayer({ epoch: 'epoch-config-reset', readSnapshot: failedReader }))),
    )

    expect(calls).toEqual({ scanStatus: 0, scanActivity: 0, currency: 0, updater: 0, harnesses: 0 })
    const snapshot = required(frames[0])
    expect(snapshot._tag).toBe('Snapshot')
    if (snapshot._tag !== 'Snapshot' || snapshot.role !== 'app') throw new Error('Expected app snapshot')
    expect(Object.keys(snapshot.state).sort()).toEqual(['configRevision', 'epoch', 'ledgerGeneration', 'sequence'])
    expect(required(frames[1])).toMatchObject({ _tag: 'Event', envelope: { event: { _tag: 'ConfigChanged' } } })
    expect(required(frames[2])).toMatchObject({
      _tag: 'Event',
      envelope: { event: { _tag: 'LedgerReset', ledgerGeneration: 1 } },
    })
  })

  it('delivers ledger events independently of failed metadata hydration with version-only snapshots', async () => {
    let reads = 0
    const unavailable = () => {
      reads += 1
      return Effect.fail(new Error('metadata unavailable'))
    }
    const frames = await Effect.runPromise(
      Effect.gen(function* () {
        const hub = yield* LifecycleHub
        const ready = yield* Deferred.make<undefined>()
        const subscription = yield* Effect.forkChild(
          Stream.runCollect(
            hub.events('app', undefined, 'versions').pipe(
              Stream.tap(frame => (frame._tag === 'Snapshot' ? Deferred.succeed(ready, undefined) : Effect.void)),
              Stream.take(2),
            ),
          ),
        )
        yield* Deferred.await(ready)
        yield* hub.publish(storeEvent)
        return yield* Fiber.join(subscription)
      }).pipe(
        Effect.provide(
          lifecycleLayer({
            epoch: 'read-free-ledger',
            readSnapshot: {
              scanStatus: unavailable,
              scanActivity: unavailable,
              currency: unavailable,
              updater: unavailable,
              harnesses: unavailable,
            },
          }),
        ),
      ),
    )
    expect(reads).toBe(0)
    expect(frames[0]).toEqual({
      _tag: 'Snapshot',
      role: 'app',
      state: { epoch: 'read-free-ledger', sequence: 0, ledgerGeneration: 0, configRevision: 0 },
    })
    expect(frames[1]).toMatchObject({ _tag: 'Event', envelope: { event: storeEvent } })
  })

  it('resnapshots after worker replacement and drops buffered events from the old owner', async () => {
    const seen: string[] = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const hub = yield* LifecycleHub
        const snapshotSeen = yield* Deferred.make<undefined>()
        const release = yield* Deferred.make<undefined>()
        const subscription = yield* Effect.forkChild(
          Effect.exit(
            Stream.runDrain(
              hub.events('app', undefined, 'versions').pipe(
                Stream.tap(frame => {
                  seen.push(frame._tag)
                  return frame._tag === 'Snapshot'
                    ? Deferred.succeed(snapshotSeen, undefined).pipe(Effect.andThen(Deferred.await(release)))
                    : Effect.void
                }),
              ),
            ),
          ),
        )
        yield* Deferred.await(snapshotSeen)
        yield* hub.publish({ _tag: 'ConfigChanged' })
        yield* hub.workerReplaced
        expect(yield* hub.subscriberCount).toBe(0)
        yield* Deferred.succeed(release, undefined)
        const previous = yield* Fiber.join(subscription)
        const snapshot = Option.getOrThrow(yield* Stream.runHead(hub.events('app')))
        return { previous, snapshot, subscribers: yield* hub.subscriberCount }
      }).pipe(Effect.provide(lifecycleLayer({ epoch: 'worker-replacement', readSnapshot: reader() }))),
    )
    expect(seen).toEqual(['Snapshot'])
    expect(result.previous._tag).toBe('Failure')
    if (result.previous._tag === 'Failure')
      expect(Cause.findError(result.previous.cause)).toMatchObject({ _tag: 'Success', success: { code: 'resnapshot' } })
    expect(result.snapshot).toMatchObject({
      _tag: 'Snapshot',
      state: { sequence: 2, ledgerGeneration: 1, configRevision: 1, scanStatus: { scanned: true } },
    })
    expect(result.subscribers).toBe(0)
  })

  it('rejects an in-flight snapshot from a replaced worker owner', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<undefined>()
        const release = yield* Deferred.make<undefined>()
        const layer = lifecycleLayer({
          epoch: 'worker-snapshot-race',
          readSnapshot: reader({
            scanStatus: () =>
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(scanStatus)),
          }),
        })
        return yield* Effect.gen(function* () {
          const hub = yield* LifecycleHub
          const subscription = yield* Effect.forkChild(Effect.exit(Stream.runHead(hub.events('app', ['store']))))
          yield* Deferred.await(entered)
          yield* hub.workerReplaced
          yield* Deferred.succeed(release, undefined)
          return yield* Fiber.join(subscription)
        }).pipe(Effect.provide(layer))
      }),
    )
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure')
      expect(Cause.findError(result.cause)).toMatchObject({ _tag: 'Success', success: { code: 'resnapshot' } })
  })

  it('lets the app opt into one event category during a staged migration', async () => {
    const frames = await Effect.runPromise(
      Effect.gen(function* () {
        const hub = yield* LifecycleHub
        const snapshotSeen = yield* Deferred.make<undefined>()
        const fiber = yield* Effect.forkChild(
          Stream.runCollect(
            hub.events('app', ['config']).pipe(
              Stream.tap(frame =>
                frame._tag === 'Snapshot' ? Deferred.succeed(snapshotSeen, undefined) : Effect.void,
              ),
              Stream.take(2),
            ),
          ),
          { startImmediately: true },
        )
        yield* Deferred.await(snapshotSeen)
        yield* hub.publish({ _tag: 'CurrencyChanged', currency: eur })
        yield* hub.publish({ _tag: 'UpdateChanged', status })
        yield* hub.publish({ _tag: 'ConfigChanged' })
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(lifecycleLayer({ epoch: 'epoch-category', readSnapshot: reader() }))),
    )

    expect(frames).toHaveLength(2)
    expect(frames[1]).toMatchObject({ _tag: 'Event', envelope: { sequence: 3, event: { _tag: 'ConfigChanged' } } })
  })

  it('fails a bounded slow subscriber with a typed lag error and releases it', async () => {
    const gates = await Effect.runPromise(
      Effect.all({ entered: Deferred.make<undefined>(), release: Deferred.make<undefined>() }),
    )
    const gatedReader = reader({
      scanStatus: () =>
        Effect.andThen(Deferred.succeed(gates.entered, undefined), Deferred.await(gates.release)).pipe(
          Effect.as(scanStatus),
        ),
    })
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const hub = yield* LifecycleHub
        const result = yield* Effect.forkChild(
          Effect.result(Stream.runCollect(hub.events('app').pipe(Stream.take(20)))),
          { startImmediately: true },
        )
        yield* Deferred.await(gates.entered)
        yield* hub.publish(progressEvent('claude'))
        yield* hub.publish({ _tag: 'ScanError', message: 'scan failed' })
        yield* Deferred.succeed(gates.release, undefined)
        const exit = yield* Fiber.join(result)
        const subscribers = yield* hub.subscriberCount
        return { exit, subscribers }
      }).pipe(Effect.provide(lifecycleLayer({ epoch: 'epoch-lag', readSnapshot: gatedReader, subscriberCapacity: 1 }))),
    )

    expect(result.exit._tag).toBe('Failure')
    if (result.exit._tag !== 'Failure') throw new Error('Expected lagged stream failure')
    expect(result.exit.failure).toMatchObject({ _tag: 'LifecycleRpcError', code: 'lagged' })
    expect(result.subscribers).toBe(0)
  })

  it('delivers committed resets during the config pilot without duplicating store-change events', async () => {
    const frames = await Effect.runPromise(
      Effect.gen(function* () {
        const hub = yield* LifecycleHub
        const snapshotSeen = yield* Deferred.make<undefined>()
        const subscriber = yield* Effect.forkChild(
          Stream.runCollect(
            hub.events('app', ['config', 'reset']).pipe(
              Stream.tap(frame =>
                frame._tag === 'Snapshot' ? Deferred.succeed(snapshotSeen, undefined) : Effect.void,
              ),
              Stream.take(2),
            ),
          ),
          { startImmediately: true },
        )
        yield* Deferred.await(snapshotSeen)
        yield* hub.publish(storeEvent)
        yield* hub.publish({ _tag: 'LedgerReset' })
        return yield* Fiber.join(subscriber)
      }).pipe(Effect.provide(lifecycleLayer({ epoch: 'reset-pilot', readSnapshot: reader() }))),
    )
    expect(frames[1]).toMatchObject({
      _tag: 'Event',
      envelope: { sequence: 2, ledgerGeneration: 1, event: { _tag: 'LedgerReset', ledgerGeneration: 1 } },
    })
  })

  it('maps failed snapshot reads to a safe typed stream error and unregisters', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const hub = yield* LifecycleHub
        const exit = yield* Effect.result(Stream.runCollect(hub.events('app')))
        return { exit, subscribers: yield* hub.subscriberCount }
      }).pipe(
        Effect.provide(
          lifecycleLayer({
            epoch: 'epoch-failure',
            readSnapshot: reader({ scanStatus: () => Effect.fail(new Error('private detail')) }),
          }),
        ),
      ),
    )

    expect(result.exit._tag).toBe('Failure')
    if (result.exit._tag !== 'Failure') throw new Error('Expected snapshot failure')
    expect(result.exit.failure).toMatchObject({
      _tag: 'LifecycleRpcError',
      code: 'snapshot-failed',
      message: 'Lifecycle snapshot failed',
    })
    expect(result.subscribers).toBe(0)
  })

  it('redacts snapshot defects, catches throwing readers, and preserves interruption', async () => {
    const read = async (readSnapshot: LifecycleSnapshotReader) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const hub = yield* LifecycleHub
          const exit = yield* Effect.result(Stream.runCollect(hub.events('app')))
          return { exit, subscribers: yield* hub.subscriberCount }
        }).pipe(Effect.provide(lifecycleLayer({ epoch: 'epoch-defect', readSnapshot }))),
      )

    const defects = [
      reader({ scanStatus: () => Effect.die(new Error('private defect')) }),
      reader({
        scanStatus: () => {
          throw new Error('private throw')
        },
      }),
    ]
    for (const readSnapshot of defects) {
      const result = await read(readSnapshot)
      expect(result.exit._tag).toBe('Failure')
      if (result.exit._tag !== 'Failure') throw new Error('Expected snapshot failure')
      expect(result.exit.failure).toMatchObject({
        _tag: 'LifecycleRpcError',
        code: 'snapshot-failed',
        message: 'Lifecycle snapshot failed',
      })
      expect(JSON.stringify(result.exit.failure)).not.toContain('private')
      expect(result.subscribers).toBe(0)
    }

    const interrupted = await Effect.runPromise(
      Effect.gen(function* () {
        const hub = yield* LifecycleHub
        const exit = yield* Effect.exit(Stream.runCollect(hub.events('app')))
        return { exit, subscribers: yield* hub.subscriberCount }
      }).pipe(
        Effect.provide(
          lifecycleLayer({
            epoch: 'epoch-interrupted',
            readSnapshot: reader({ scanStatus: () => Effect.interrupt }),
          }),
        ),
      ),
    )
    expect(interrupted.exit._tag).toBe('Failure')
    if (interrupted.exit._tag !== 'Failure') throw new Error('Expected interrupted snapshot')
    expect(Cause.hasInterruptsOnly(interrupted.exit.cause)).toBe(true)
    expect(interrupted.subscribers).toBe(0)
  })
})
