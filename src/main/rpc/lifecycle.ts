import * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Queue from 'effect/Queue'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'

import {
  type AppLifecycleFrame,
  appLifecycleFrameSchema,
  type BeaconLifecycleEvent,
  type BeaconLifecycleFrame,
  beaconLifecycleFrameSchema,
  type LifecycleAppEventCategory,
  type LifecycleEnvelope,
  type LifecycleEvent,
  LifecycleRpcError,
  LifecycleRpcGroup,
  type LifecycleScanActivity,
  lifecycleScanActivitySchema,
  type PanelLifecycleEvent,
  type PanelLifecycleFrame,
  panelLifecycleFrameSchema,
} from '../../shared/rpc/lifecycle.js'
import { coachHarnessesResultSchema, type CoachHarnessRow } from '../../shared/schemas/agents.js'
import { type ActiveCurrency, activeCurrencySchema } from '../../shared/schemas/fx.js'
import { type ScanStatus, scanStatusSchema } from '../../shared/schemas/ipc.js'
import { type UpdateStatus, updateStatusSchema } from '../../shared/schemas/updates.js'

type SnapshotField = 'scanStatus' | 'scanActivity' | 'currency' | 'updater' | 'harnesses'
export type LifecyclePublishEvent =
  | Exclude<LifecycleEvent, { _tag: 'ConfigChanged' | 'LedgerReset' }>
  | { readonly _tag: 'ConfigChanged' }
  | { readonly _tag: 'LedgerReset' }

export interface LifecycleSnapshotReader<R = never> {
  readonly scanStatus: () => Effect.Effect<unknown, unknown, R>
  readonly scanActivity: () => Effect.Effect<unknown, unknown, R>
  readonly currency: () => Effect.Effect<unknown, unknown, R>
  readonly updater: () => Effect.Effect<unknown, unknown, R>
  readonly harnesses: () => Effect.Effect<unknown, unknown, R>
}

export interface LifecycleHubOptions<R = never> {
  readonly epoch: string
  readonly readSnapshot: LifecycleSnapshotReader<R>
  readonly subscriberCapacity?: number
}

export interface LifecycleHubService {
  readonly events: {
    (
      role: 'app',
      categories?: readonly LifecycleAppEventCategory[],
    ): Stream.Stream<AppLifecycleFrame, LifecycleRpcError>
    (role: 'panel'): Stream.Stream<PanelLifecycleFrame, LifecycleRpcError>
    (role: 'beacon'): Stream.Stream<BeaconLifecycleFrame, LifecycleRpcError>
    (
      role: 'app' | 'panel' | 'beacon',
      categories?: readonly LifecycleAppEventCategory[],
    ): Stream.Stream<AppLifecycleFrame | PanelLifecycleFrame | BeaconLifecycleFrame, LifecycleRpcError>
  }
  readonly publish: (event: LifecyclePublishEvent) => Effect.Effect<void>
  readonly currentConfigRevision: Effect.Effect<number>
  /** Diagnostic count used by lifecycle integration tests. */
  readonly subscriberCount: Effect.Effect<number>
}

export class LifecycleHub extends Context.Service<LifecycleHub, LifecycleHubService>()(
  'watchtower/main/LifecycleHub',
) {}

interface HubState {
  readonly epoch: string
  sequence: number
  ledgerGeneration: number
  configRevision: number
  scanStatus: ScanStatus
  scanActivity: LifecycleScanActivity
  currency: ActiveCurrency
  updater: UpdateStatus
  harnesses: CoachHarnessRow[]
  readonly revisions: Record<SnapshotField, number>
}

interface Subscriber {
  readonly role: 'app' | 'panel' | 'beacon'
  readonly categories: ReadonlySet<LifecycleAppEventCategory>
  readonly queue: Queue.Queue<LifecycleEnvelope, LifecycleRpcError>
}

const zeroActivity = (): LifecycleScanActivity => ({ scanning: false, progress: null, error: null })
const emptyScanStatus = (): ScanStatus => ({ scanned: false })
const defaultCurrency: ActiveCurrency = { code: 'USD', symbol: '$', rate: 1 }
const defaultUpdater: UpdateStatus = {
  revision: 0,
  currentVersion: '',
  latestVersion: null,
  updateAvailable: false,
  tag: null,
  phase: 'idle',
  installSupported: false,
  progress: null,
  message: null,
}
const ALL_CATEGORIES: ReadonlySet<LifecycleAppEventCategory> = new Set([
  'scan',
  'store',
  'reset',
  'config',
  'currency',
  'updates',
  'harnesses',
])

function categoryFor(event: LifecycleEvent): LifecycleAppEventCategory {
  switch (event._tag) {
    case 'ScanProgress':
    case 'ScanError':
    case 'ScanIdle':
      return 'scan'
    case 'StoreChanged':
      return 'store'
    case 'LedgerReset':
      return 'reset'
    case 'ConfigChanged':
      return 'config'
    case 'CurrencyChanged':
      return 'currency'
    case 'UpdateChanged':
      return 'updates'
    case 'HarnessesChanged':
      return 'harnesses'
  }
}

function accepts(
  role: Subscriber['role'],
  event: LifecycleEvent,
  categories: ReadonlySet<LifecycleAppEventCategory>,
): boolean {
  if (role === 'app') return categories.has(categoryFor(event))
  switch (event._tag) {
    case 'ScanProgress':
    case 'ScanError':
    case 'ScanIdle':
    case 'StoreChanged':
    case 'LedgerReset':
      return true
    case 'ConfigChanged':
    case 'CurrencyChanged':
      return role === 'panel'
    case 'UpdateChanged':
    case 'HarnessesChanged':
      return false
  }
}

function makeActivitySnapshot(state: HubState): LifecycleScanActivity {
  return { ...state.scanActivity, progress: state.scanActivity.progress ? { ...state.scanActivity.progress } : null }
}

function buildFrame(
  state: HubState,
  role: 'app',
  categories?: ReadonlySet<LifecycleAppEventCategory>,
): AppLifecycleFrame
function buildFrame(state: HubState, role: 'panel'): PanelLifecycleFrame
function buildFrame(state: HubState, role: 'beacon'): BeaconLifecycleFrame
function buildFrame(
  state: HubState,
  role: Subscriber['role'],
  categories?: ReadonlySet<LifecycleAppEventCategory>,
): AppLifecycleFrame | PanelLifecycleFrame | BeaconLifecycleFrame
function buildFrame(
  state: HubState,
  role: Subscriber['role'],
  categories?: ReadonlySet<LifecycleAppEventCategory>,
): AppLifecycleFrame | PanelLifecycleFrame | BeaconLifecycleFrame {
  const common = { epoch: state.epoch, sequence: state.sequence, ledgerGeneration: state.ledgerGeneration }
  switch (role) {
    case 'app': {
      const selected = categories ?? ALL_CATEGORIES
      return Schema.decodeUnknownSync(appLifecycleFrameSchema)({
        _tag: 'Snapshot',
        role,
        state: {
          ...common,
          configRevision: state.configRevision,
          ...(selected.has('store') ? { scanStatus: state.scanStatus } : {}),
          ...(selected.has('scan') ? { scanActivity: makeActivitySnapshot(state) } : {}),
          ...(selected.has('currency') ? { currency: state.currency } : {}),
          ...(selected.has('updates') ? { updater: state.updater } : {}),
          ...(selected.has('harnesses') ? { harnesses: state.harnesses } : {}),
        },
      })
    }
    case 'panel':
      return Schema.decodeUnknownSync(panelLifecycleFrameSchema)({
        _tag: 'Snapshot',
        role,
        state: {
          epoch: state.epoch,
          sequence: state.sequence,
          hasScanned: state.scanStatus.scanned,
          scanActivity: makeActivitySnapshot(state),
          currency: state.currency,
          resetGeneration: state.ledgerGeneration,
        },
      })
    case 'beacon':
      return Schema.decodeUnknownSync(beaconLifecycleFrameSchema)({
        _tag: 'Snapshot',
        role,
        state: { epoch: state.epoch, sequence: state.sequence, scanActivity: makeActivitySnapshot(state) },
      })
  }
}

function applyEvent(state: HubState, input: LifecyclePublishEvent): LifecycleEvent {
  let event: LifecycleEvent
  switch (input._tag) {
    case 'ScanProgress':
      event = input
      state.scanActivity = { scanning: true, progress: { ...event.progress }, error: null }
      state.revisions.scanActivity++
      break
    case 'ScanError':
      event = input
      state.scanActivity = { ...state.scanActivity, scanning: false, error: event.message }
      state.revisions.scanActivity++
      break
    case 'ScanIdle':
      event = input
      state.scanActivity = { ...state.scanActivity, scanning: false, progress: null }
      state.revisions.scanActivity++
      break
    case 'StoreChanged':
      event = input
      state.scanStatus = { scanned: true, metadata: event.metadata }
      state.scanActivity = { ...state.scanActivity, scanning: false, progress: null }
      state.revisions.scanStatus++
      state.revisions.scanActivity++
      break
    case 'ConfigChanged':
      state.configRevision++
      event = { ...input, configRevision: state.configRevision }
      break
    case 'CurrencyChanged':
      event = input
      state.currency = event.currency
      state.revisions.currency++
      break
    case 'UpdateChanged':
      event = input
      state.updater = event.status
      state.revisions.updater++
      break
    case 'HarnessesChanged':
      event = input
      state.harnesses = [...event.rows]
      state.revisions.harnesses++
      break
    case 'LedgerReset':
      state.ledgerGeneration++
      state.scanStatus = emptyScanStatus()
      state.scanActivity = zeroActivity()
      state.revisions.scanStatus++
      state.revisions.scanActivity++
      event = { ...input, ledgerGeneration: state.ledgerGeneration }
      break
  }
  return event
}

function eventFrame(envelope: LifecycleEnvelope, role: 'app'): AppLifecycleFrame
function eventFrame(envelope: LifecycleEnvelope, role: 'panel'): PanelLifecycleFrame
function eventFrame(envelope: LifecycleEnvelope, role: 'beacon'): BeaconLifecycleFrame
function eventFrame(
  envelope: LifecycleEnvelope,
  role: 'app' | 'panel' | 'beacon',
): AppLifecycleFrame | PanelLifecycleFrame | BeaconLifecycleFrame
function eventFrame(
  envelope: LifecycleEnvelope,
  role: Subscriber['role'],
): AppLifecycleFrame | PanelLifecycleFrame | BeaconLifecycleFrame {
  if (role === 'app') return Schema.decodeUnknownSync(appLifecycleFrameSchema)({ _tag: 'Event', envelope })
  if (role === 'panel') {
    const event = panelEventFor(envelope)
    return Schema.decodeUnknownSync(panelLifecycleFrameSchema)({
      _tag: 'Event',
      envelope: {
        epoch: envelope.epoch,
        sequence: envelope.sequence,
        ledgerGeneration: envelope.ledgerGeneration,
        configRevision: envelope.configRevision,
        event,
      },
    })
  }
  const event = beaconEventFor(envelope)
  return Schema.decodeUnknownSync(beaconLifecycleFrameSchema)({
    _tag: 'Event',
    envelope: { epoch: envelope.epoch, sequence: envelope.sequence, event },
  })
}

function panelEventFor(envelope: LifecycleEnvelope): PanelLifecycleEvent {
  switch (envelope.event._tag) {
    case 'ScanProgress':
    case 'ScanError':
    case 'ScanIdle':
    case 'ConfigChanged':
    case 'CurrencyChanged':
      return envelope.event
    case 'StoreChanged':
      return { _tag: 'LedgerChanged' }
    case 'LedgerReset':
      return { _tag: 'LedgerReset', ledgerGeneration: envelope.ledgerGeneration }
    case 'UpdateChanged':
    case 'HarnessesChanged':
      throw new Error('Unexpected app-only event in panel subscription')
  }
}

function beaconEventFor(envelope: LifecycleEnvelope): BeaconLifecycleEvent {
  switch (envelope.event._tag) {
    case 'ScanProgress':
    case 'ScanError':
    case 'ScanIdle':
      return envelope.event
    case 'StoreChanged':
    case 'LedgerReset':
      return { _tag: 'ScanIdle' }
    case 'ConfigChanged':
    case 'CurrencyChanged':
    case 'UpdateChanged':
    case 'HarnessesChanged':
      throw new Error('Unexpected non-activity event in beacon subscription')
  }
}

const makeLifecycleHub = Effect.fnUntraced(function* <R>(
  options: LifecycleHubOptions<R>,
): Effect.fn.Return<LifecycleHubService, never, R> {
  const readerContext = yield* Effect.context<R>()
  const capacity = options.subscriberCapacity ?? 128
  const state: HubState = {
    epoch: options.epoch,
    sequence: 0,
    ledgerGeneration: 0,
    configRevision: 0,
    scanStatus: emptyScanStatus(),
    scanActivity: zeroActivity(),
    currency: defaultCurrency,
    updater: { ...defaultUpdater },
    harnesses: [],
    revisions: { scanStatus: 0, scanActivity: 0, currency: 0, updater: 0, harnesses: 0 },
  }
  const subscribers = new Set<Subscriber>()

  const snapshot = (role: Subscriber['role'], categories: ReadonlySet<LifecycleAppEventCategory>) =>
    Effect.gen(function* () {
      const baseline = { ...state.revisions }
      const reads: Partial<Pick<HubState, SnapshotField>> = {}
      if (role !== 'app' || categories.has('scan')) {
        reads.scanActivity = yield* Effect.suspend(options.readSnapshot.scanActivity).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(lifecycleScanActivitySchema)),
        )
      }
      if (role === 'panel' || (role === 'app' && categories.has('store'))) {
        reads.scanStatus = yield* Effect.suspend(options.readSnapshot.scanStatus).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(scanStatusSchema)),
        )
      }
      if (role === 'panel' || (role === 'app' && categories.has('currency'))) {
        reads.currency = yield* Effect.suspend(options.readSnapshot.currency).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(activeCurrencySchema)),
        )
      }
      if (role === 'app') {
        if (categories.has('updates')) {
          reads.updater = yield* Effect.suspend(options.readSnapshot.updater).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(updateStatusSchema)),
          )
        }
        if (categories.has('harnesses')) {
          reads.harnesses = yield* Effect.suspend(options.readSnapshot.harnesses).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(coachHarnessesResultSchema)),
          )
        }
      }
      return yield* Effect.sync(() => {
        if (reads.scanStatus && state.revisions.scanStatus === baseline.scanStatus) {
          state.scanStatus = reads.scanStatus
          state.revisions.scanStatus++
        }
        if (reads.scanActivity && state.revisions.scanActivity === baseline.scanActivity) {
          state.scanActivity = reads.scanActivity
          state.revisions.scanActivity++
        }
        if (reads.currency && state.revisions.currency === baseline.currency) {
          state.currency = reads.currency
          state.revisions.currency++
        }
        if (reads.updater && state.revisions.updater === baseline.updater) {
          state.updater = reads.updater
          state.revisions.updater++
        }
        if (reads.harnesses && state.revisions.harnesses === baseline.harnesses) {
          state.harnesses = reads.harnesses
          state.revisions.harnesses++
        }
        return { ...state, revisions: { ...state.revisions } }
      })
    }).pipe(
      Effect.provideContext(readerContext),
      Effect.catchCause(cause =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.fail(new LifecycleRpcError({ code: 'snapshot-failed', message: 'Lifecycle snapshot failed' })),
      ),
    )

  function events(
    role: 'app',
    categories?: readonly LifecycleAppEventCategory[],
  ): Stream.Stream<AppLifecycleFrame, LifecycleRpcError>
  function events(role: 'panel'): Stream.Stream<PanelLifecycleFrame, LifecycleRpcError>
  function events(role: 'beacon'): Stream.Stream<BeaconLifecycleFrame, LifecycleRpcError>
  function events(
    role: 'app' | 'panel' | 'beacon',
    categories?: readonly LifecycleAppEventCategory[],
  ): Stream.Stream<AppLifecycleFrame | PanelLifecycleFrame | BeaconLifecycleFrame, LifecycleRpcError>
  function events(
    role: Subscriber['role'],
    categories?: readonly LifecycleAppEventCategory[],
  ): Stream.Stream<AppLifecycleFrame | PanelLifecycleFrame | BeaconLifecycleFrame, LifecycleRpcError> {
    const selectedCategories = new Set(categories ?? ALL_CATEGORIES)
    return Stream.unwrap(
      Effect.gen(function* () {
        const queue = yield* Queue.bounded<LifecycleEnvelope, LifecycleRpcError>(capacity)
        const subscriber: Subscriber = { role, categories: selectedCategories, queue }
        subscribers.add(subscriber)
        yield* Effect.acquireRelease(Effect.void, () =>
          Effect.sync(() => {
            subscribers.delete(subscriber)
            Queue.shutdownUnsafe(queue)
          }),
        )
        const current = yield* snapshot(role, selectedCategories)
        const frame = buildFrame(current, role, selectedCategories)
        const stream = Stream.fromQueue(queue).pipe(
          Stream.filter(
            envelope => envelope.sequence > current.sequence && accepts(role, envelope.event, selectedCategories),
          ),
          Stream.map(envelope => eventFrame(envelope, role)),
        )
        return Stream.concat(Stream.make(frame), stream)
      }),
    )
  }

  const publish = (input: LifecyclePublishEvent): Effect.Effect<void> =>
    Effect.sync(() => {
      state.sequence++
      const event = applyEvent(state, input)
      const envelope: LifecycleEnvelope = {
        epoch: state.epoch,
        sequence: state.sequence,
        ledgerGeneration: state.ledgerGeneration,
        configRevision: state.configRevision,
        event,
      }
      for (const subscriber of subscribers) {
        if (!accepts(subscriber.role, event, subscriber.categories)) continue
        if (!Queue.offerUnsafe(subscriber.queue, envelope)) {
          subscribers.delete(subscriber)
          Queue.failCauseUnsafe(
            subscriber.queue,
            Cause.fail(new LifecycleRpcError({ code: 'lagged', message: 'Lifecycle subscriber fell behind' })),
          )
        }
      }
    })

  return {
    events,
    publish,
    currentConfigRevision: Effect.sync(() => state.configRevision),
    subscriberCount: Effect.sync(() => subscribers.size),
  }
})

export const lifecycleLayer = <R>(options: LifecycleHubOptions<R>): Layer.Layer<LifecycleHub, never, R> =>
  Layer.effect(LifecycleHub, makeLifecycleHub(options))

export const lifecycleHandlers = LifecycleRpcGroup.toLayer(
  Effect.gen(function* () {
    const hub = yield* LifecycleHub
    return {
      'app:events': ({ categories }) => hub.events('app', categories),
      'panel:events': () => hub.events('panel'),
      'beacon:events': () => hub.events('beacon'),
    }
  }),
)
