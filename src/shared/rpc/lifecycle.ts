import { Rpc, RpcGroup } from 'effect/rpc'
import * as Schema from 'effect/Schema'

import { coachHarnessesResultSchema } from '@/shared/schemas/agents.js'
import { activeCurrencySchema } from '@/shared/schemas/fx.js'
import { scanStatusSchema, storeChangedMessageSchema } from '@/shared/schemas/ipc.js'
import { scanProgressSchema } from '@/shared/schemas/scan.js'
import { updateStatusSchema } from '@/shared/schemas/updates.js'

const writable = Schema.mutableKey
const revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const lifecycleScanActivitySchema = Schema.Struct({
  scanning: writable(Schema.Boolean),
  progress: writable(Schema.NullOr(scanProgressSchema)),
  error: writable(Schema.NullOr(Schema.String)),
})
export type LifecycleScanActivity = Schema.Schema.Type<typeof lifecycleScanActivitySchema>

const snapshotVersionFields = {
  epoch: writable(Schema.String),
  sequence: writable(revision),
}

const appSnapshotVersionFields = {
  ...snapshotVersionFields,
  ledgerGeneration: writable(revision),
}

export const appLifecycleSnapshotSchema = Schema.Struct({
  ...appSnapshotVersionFields,
  configRevision: writable(revision),
  scanStatus: writable(Schema.optional(scanStatusSchema)),
  scanActivity: writable(Schema.optional(lifecycleScanActivitySchema)),
  currency: writable(Schema.optional(activeCurrencySchema)),
  updater: writable(Schema.optional(updateStatusSchema)),
  harnesses: writable(Schema.optional(coachHarnessesResultSchema)),
})
export type AppLifecycleSnapshot = Schema.Schema.Type<typeof appLifecycleSnapshotSchema>

export const panelLifecycleSnapshotSchema = Schema.Struct({
  ...snapshotVersionFields,
  hasScanned: writable(Schema.Boolean),
  scanActivity: writable(lifecycleScanActivitySchema),
  currency: writable(activeCurrencySchema),
  resetGeneration: writable(revision),
})
export type PanelLifecycleSnapshot = Schema.Schema.Type<typeof panelLifecycleSnapshotSchema>

export const beaconLifecycleSnapshotSchema = Schema.Struct({
  ...snapshotVersionFields,
  scanActivity: writable(lifecycleScanActivitySchema),
})
export type BeaconLifecycleSnapshot = Schema.Schema.Type<typeof beaconLifecycleSnapshotSchema>

export const lifecycleEventSchema = Schema.Union([
  Schema.Struct({ _tag: writable(Schema.Literal('ScanProgress')), progress: writable(scanProgressSchema) }),
  Schema.Struct({ _tag: writable(Schema.Literal('ScanError')), message: writable(Schema.String) }),
  Schema.Struct({ _tag: writable(Schema.Literal('ScanIdle')) }),
  Schema.Struct({ _tag: writable(Schema.Literal('StoreChanged')), metadata: writable(storeChangedMessageSchema) }),
  Schema.Struct({ _tag: writable(Schema.Literal('ConfigChanged')), configRevision: writable(revision) }),
  Schema.Struct({ _tag: writable(Schema.Literal('CurrencyChanged')), currency: writable(activeCurrencySchema) }),
  Schema.Struct({ _tag: writable(Schema.Literal('UpdateChanged')), status: writable(updateStatusSchema) }),
  Schema.Struct({ _tag: writable(Schema.Literal('HarnessesChanged')), rows: writable(coachHarnessesResultSchema) }),
  Schema.Struct({ _tag: writable(Schema.Literal('LedgerReset')), ledgerGeneration: writable(revision) }),
])
export type LifecycleEvent = Schema.Schema.Type<typeof lifecycleEventSchema>

export const panelLifecycleEventSchema = Schema.Union([
  Schema.Struct({ _tag: writable(Schema.Literal('ScanProgress')), progress: writable(scanProgressSchema) }),
  Schema.Struct({ _tag: writable(Schema.Literal('ScanError')), message: writable(Schema.String) }),
  Schema.Struct({ _tag: writable(Schema.Literal('ScanIdle')) }),
  Schema.Struct({ _tag: writable(Schema.Literal('LedgerChanged')) }),
  Schema.Struct({ _tag: writable(Schema.Literal('ConfigChanged')), configRevision: writable(revision) }),
  Schema.Struct({ _tag: writable(Schema.Literal('CurrencyChanged')), currency: writable(activeCurrencySchema) }),
  Schema.Struct({ _tag: writable(Schema.Literal('LedgerReset')), ledgerGeneration: writable(revision) }),
])
export type PanelLifecycleEvent = Schema.Schema.Type<typeof panelLifecycleEventSchema>

export const beaconLifecycleEventSchema = Schema.Union([
  Schema.Struct({ _tag: writable(Schema.Literal('ScanProgress')), progress: writable(scanProgressSchema) }),
  Schema.Struct({ _tag: writable(Schema.Literal('ScanError')), message: writable(Schema.String) }),
  Schema.Struct({ _tag: writable(Schema.Literal('ScanIdle')) }),
])
export type BeaconLifecycleEvent = Schema.Schema.Type<typeof beaconLifecycleEventSchema>

export type LifecycleAppEventCategory = 'scan' | 'store' | 'reset' | 'config' | 'currency' | 'updates' | 'harnesses'
export const lifecycleAppEventCategorySchema = Schema.Literals([
  'scan',
  'store',
  'reset',
  'config',
  'currency',
  'updates',
  'harnesses',
])
export const appLifecycleRequestSchema = Schema.Struct({
  categories: writable(Schema.optional(Schema.mutable(Schema.Array(lifecycleAppEventCategorySchema)))),
  /** Version-only snapshots let metadata hydrate independently of event delivery. */
  snapshot: writable(Schema.optional(Schema.Literals(['versions', 'state']))),
})

const envelopeFields = {
  epoch: writable(Schema.String),
  sequence: writable(revision),
}

export const lifecycleEnvelopeSchema = Schema.Struct({
  ...envelopeFields,
  ledgerGeneration: writable(revision),
  configRevision: writable(revision),
  event: writable(lifecycleEventSchema),
})
export type LifecycleEnvelope = Schema.Schema.Type<typeof lifecycleEnvelopeSchema>

const panelLifecycleEnvelopeSchema = Schema.Struct({
  ...envelopeFields,
  ledgerGeneration: writable(revision),
  configRevision: writable(revision),
  event: writable(panelLifecycleEventSchema),
})
const beaconLifecycleEnvelopeSchema = Schema.Struct({
  ...envelopeFields,
  event: writable(beaconLifecycleEventSchema),
})

const snapshotFrame = <const Role extends 'app' | 'panel' | 'beacon', S extends Schema.Top>(role: Role, schema: S) =>
  Schema.Struct({
    _tag: writable(Schema.Literal('Snapshot')),
    role: writable(Schema.Literal(role)),
    state: writable(schema),
  })

const appEventFrame = Schema.Struct({
  _tag: writable(Schema.Literal('Event')),
  envelope: writable(lifecycleEnvelopeSchema),
})
const panelEventFrame = Schema.Struct({
  _tag: writable(Schema.Literal('Event')),
  envelope: writable(panelLifecycleEnvelopeSchema),
})
const beaconEventFrame = Schema.Struct({
  _tag: writable(Schema.Literal('Event')),
  envelope: writable(beaconLifecycleEnvelopeSchema),
})

export const appLifecycleFrameSchema = Schema.Union([snapshotFrame('app', appLifecycleSnapshotSchema), appEventFrame])
export const panelLifecycleFrameSchema = Schema.Union([
  snapshotFrame('panel', panelLifecycleSnapshotSchema),
  panelEventFrame,
])
export const beaconLifecycleFrameSchema = Schema.Union([
  snapshotFrame('beacon', beaconLifecycleSnapshotSchema),
  beaconEventFrame,
])
export type AppLifecycleFrame = Schema.Schema.Type<typeof appLifecycleFrameSchema>
export type PanelLifecycleFrame = Schema.Schema.Type<typeof panelLifecycleFrameSchema>
export type BeaconLifecycleFrame = Schema.Schema.Type<typeof beaconLifecycleFrameSchema>
export type LifecycleFrame = AppLifecycleFrame | PanelLifecycleFrame | BeaconLifecycleFrame

export class LifecycleRpcError extends Schema.TaggedError<LifecycleRpcError>()('LifecycleRpcError', {
  code: Schema.Literals(['snapshot-failed', 'lagged', 'resnapshot']),
  message: Schema.Literals([
    'Lifecycle snapshot failed',
    'Lifecycle subscriber fell behind',
    'Lifecycle state changed',
  ]),
}) {}

/** Role-specific lifecycle subscriptions. Snapshot is the first stream item. */
export const LifecycleRpcGroup = RpcGroup.make(
  Rpc.make('app:events', {
    payload: appLifecycleRequestSchema,
    success: appLifecycleFrameSchema,
    error: LifecycleRpcError,
    stream: true,
  }),
  Rpc.make('panel:events', { success: panelLifecycleFrameSchema, error: LifecycleRpcError, stream: true }),
  Rpc.make('beacon:events', { success: beaconLifecycleFrameSchema, error: LifecycleRpcError, stream: true }),
)
