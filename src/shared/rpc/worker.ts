import { Rpc, RpcGroup } from 'effect/rpc'
import * as Schema from 'effect/Schema'

import { cadenceValueSchema } from '../schemas/cadence.js'
import { comparePairSchema, comparePayloadSchema } from '../schemas/compare.js'
import { exportResultSchema } from '../schemas/export.js'
import { activeCurrencySchema, currencyOptionsSchema } from '../schemas/fx.js'
import { pricingRefreshResultSchema, scanStatusSchema, settingsInfoSchema } from '../schemas/ipc.js'
import { ledgerMcpStartupModeSchema } from '../schemas/ledger-mcp.js'
import { modelAliasSchema, modelsPayloadSchema, priceOverrideSchema } from '../schemas/models.js'
import { optimizePayloadSchema } from '../schemas/optimize.js'
import { overviewPayloadSchema, overviewScopeSchema } from '../schemas/overview.js'
import { pullRequestsPayloadSchema } from '../schemas/pull-requests.js'
import { scanMetadataSchema, scanProgressSchema } from '../schemas/scan.js'
import { skillsDismissalRequestSchema, skillsPayloadSchema, skillsThresholdsSchema } from '../schemas/skills.js'
import { spendPayloadSchema } from '../schemas/spend.js'
import {
  analyticalViewsSchema,
  dashboardViewsSchema,
  projectRowSchema,
  searchHitSchema,
  sessionDetailRequestSchema,
  sessionDetailSchema,
  sessionRowSchema,
} from '../schemas/views.js'
import { yieldPayloadSchema } from '../schemas/yield.js'

/** Distinct ordinary requests admitted by the main-owned worker supervisor. */
export const WORKER_REQUEST_CAPACITY = 128

const writable = Schema.mutableKey
const nonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** Stable worker error categories. Messages are fixed safe text; causes,
 * paths, SQL details and operation arguments never cross this boundary. */
export class WorkerRpcError extends Schema.TaggedError<WorkerRpcError>()('WorkerRpcError', {
  code: Schema.Literals([
    'not-ready',
    'invalid-request',
    'unavailable',
    'query-failed',
    'command-failed',
    'conflict',
    'cancelled',
    'initialization-failed',
    'shutting-down',
    'unsupported-schema-version',
    'invalid-stored-data',
    'database-unavailable',
    'database-access-denied',
    'database-query-invalid',
    'database-operation-failed',
    'event-overflow',
  ]),
  message: Schema.Literal('The database worker operation failed.'),
  /** Present on an operation failure so the caller can apply preceding events
   * before observing the rejection. Lifecycle and stream errors may omit it. */
  eventSequence: Schema.optional(writable(nonNegativeInt)),
}) {}

/** Every unary ACK includes the highest worker event sequence emitted before
 * its handler completes. The main client must wait for its stream consumer to
 * apply that watermark before acknowledging the call to its caller. */
export const workerSuccessSchema = <S extends Schema.ConstraintDecoder<unknown>>(value: S) =>
  Schema.Struct({ value: writable(value), eventSequence: writable(nonNegativeInt) })

export type WorkerRpcSuccess<A> = { readonly value: A; readonly eventSequence: number }

const error = WorkerRpcError
const scopedRequest = Schema.Struct({ scope: overviewScopeSchema })
const compareRequest = Schema.Struct({ scope: overviewScopeSchema, pair: Schema.optional(comparePairSchema) })
const skillsRequest = Schema.Struct({
  scope: overviewScopeSchema,
  thresholds: Schema.optional(skillsThresholdsSchema),
})
const searchRequest = Schema.Struct({ query: Schema.String })
const sessionsFilter = Schema.Struct({
  project: Schema.optional(Schema.String),
  since: Schema.optional(Schema.String),
  until: Schema.optional(Schema.String),
})
const sessionsRequest = Schema.Struct({ filter: Schema.optional(sessionsFilter) })
const modelRequest = Schema.Struct({ model: Schema.String })
const cadenceRequest = Schema.Struct({ value: cadenceValueSchema })
const currencyRequest = Schema.Struct({ code: Schema.String })
const scanStartRequest = Schema.Struct({ provider: Schema.optional(Schema.String) })
const exportRequest = Schema.Struct({ outputPath: Schema.String })
const startupModeRequest = Schema.Struct({ mode: ledgerMcpStartupModeSchema })
const ok = Schema.Struct({ ok: writable(Schema.Literal(true)) })
const nullValue = Schema.Null
const booleanValue = Schema.Boolean
const safeScanFailureMessage = Schema.Literals(['The scan failed.', 'scan aborted'])
const projectRows = Schema.mutable(Schema.Array(projectRowSchema))
const sessionRows = Schema.mutable(Schema.Array(sessionRowSchema))
const aliases = Schema.mutable(Schema.Array(modelAliasSchema))
const priceOverrides = Schema.mutable(Schema.Array(priceOverrideSchema))
const searchHits = Schema.mutable(Schema.Array(searchHitSchema))
const scanResult = Schema.Struct({
  ok: writable(Schema.Boolean),
  aborted: writable(Schema.optional(Schema.Boolean)),
  alreadyRunning: writable(Schema.optional(Schema.Boolean)),
  error: writable(Schema.optional(safeScanFailureMessage)),
})

export const WorkerEventSchema = Schema.Union([
  /** First item on each event subscription; sequence zero is the barrier
   * confirming the server registered the consumer before readiness is read. */
  Schema.Struct({ event: Schema.Literal('worker:events-ready') }),
  Schema.Struct({ event: Schema.Literal('scan:progress'), manual: Schema.Boolean, progress: scanProgressSchema }),
  Schema.Struct({ event: Schema.Literal('scan:error'), manual: Schema.Boolean, message: safeScanFailureMessage }),
  Schema.Struct({ event: Schema.Literal('store:changed'), metadata: scanMetadataSchema }),
  Schema.Struct({ event: Schema.Literal('ledger:reset') }),
  Schema.Struct({ event: Schema.Literal('scan:idle') }),
  Schema.Struct({ event: Schema.Literal('config:changed') }),
  Schema.Struct({ event: Schema.Literal('currency:changed'), currency: activeCurrencySchema }),
  Schema.Struct({
    event: Schema.Literal('oplog'),
    level: Schema.Literals(['debug', 'info', 'warn', 'error']),
    logEvent: Schema.String,
    fields: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number])),
  }),
])
export type WorkerEvent = Schema.Schema.Type<typeof WorkerEventSchema>

/** Sequence zero is reserved for `worker:events-ready`; domain events begin at
 * one and increase monotonically for the lifetime of a worker generation. */
export const SequencedWorkerEventSchema = Schema.Struct({ sequence: nonNegativeInt, event: WorkerEventSchema })
export type SequencedWorkerEvent = Schema.Schema.Type<typeof SequencedWorkerEventSchema>

const unary = <S extends Schema.ConstraintDecoder<unknown>>(success: S) => ({
  success: workerSuccessSchema(success),
  error,
})

/** Internal main ↔ db-worker application contract. Every operation has a
 * schema-validated payload and result; no `{ op, args }` escape hatch exists. */
export const WorkerRpcGroup = RpcGroup.make(
  /** Succeeds only after worker runtime/context initialization has completed. */
  Rpc.make('worker:ready', unary(Schema.Literal(true))),

  Rpc.make('store:views', unary(Schema.NullOr(dashboardViewsSchema))),
  Rpc.make('store:projects', unary(projectRows)),
  Rpc.make('store:sessions', { payload: sessionsRequest, ...unary(sessionRows) }),
  Rpc.make('store:session', { payload: sessionDetailRequestSchema, ...unary(Schema.NullOr(sessionDetailSchema)) }),
  Rpc.make('store:analytics', unary(Schema.NullOr(analyticalViewsSchema))),
  Rpc.make('overview:query', { payload: scopedRequest, ...unary(Schema.NullOr(overviewPayloadSchema)) }),
  Rpc.make('sessions:view', { payload: scopedRequest, ...unary(sessionRows) }),
  Rpc.make('pullRequests:view', { payload: scopedRequest, ...unary(Schema.NullOr(pullRequestsPayloadSchema)) }),
  Rpc.make('spend:view', { payload: scopedRequest, ...unary(Schema.NullOr(spendPayloadSchema)) }),
  Rpc.make('models:view', { payload: scopedRequest, ...unary(Schema.NullOr(modelsPayloadSchema)) }),
  Rpc.make('compare:view', { payload: compareRequest, ...unary(Schema.NullOr(comparePayloadSchema)) }),
  Rpc.make('optimize:view', { payload: scopedRequest, ...unary(Schema.NullOr(optimizePayloadSchema)) }),
  Rpc.make('optimize:yield', { payload: scopedRequest, ...unary(Schema.NullOr(yieldPayloadSchema)) }),
  Rpc.make('skills:view', { payload: skillsRequest, ...unary(Schema.NullOr(skillsPayloadSchema)) }),
  Rpc.make('store:search', { payload: searchRequest, ...unary(searchHits) }),
  Rpc.make('export:csv', { payload: exportRequest, ...unary(exportResultSchema) }),
  Rpc.make('export:json', { payload: exportRequest, ...unary(exportResultSchema) }),

  Rpc.make('skills:dismiss', { payload: skillsDismissalRequestSchema, ...unary(ok) }),
  Rpc.make('models:addAlias', { payload: modelAliasSchema, ...unary(ok) }),
  Rpc.make('models:getAliases', unary(aliases)),
  Rpc.make('models:removeAlias', { payload: modelRequest, ...unary(ok) }),
  Rpc.make('models:getPriceOverrides', unary(priceOverrides)),
  Rpc.make('models:removePriceOverride', { payload: modelRequest, ...unary(ok) }),
  Rpc.make('models:setPrice', { payload: priceOverrideSchema, ...unary(ok) }),
  Rpc.make('ledger-mcp:startup:get', unary(ledgerMcpStartupModeSchema)),
  Rpc.make('ledger-mcp:startup:set', { payload: startupModeRequest, ...unary(ledgerMcpStartupModeSchema) }),

  Rpc.make('scan:start', { payload: scanStartRequest, ...unary(scanResult) }),
  Rpc.make('scan:active', unary(booleanValue)),
  Rpc.make('scan:abort', unary(nullValue)),
  Rpc.make('worker:shutdown', unary(nullValue)),
  Rpc.make('cadence:get', unary(cadenceValueSchema)),
  Rpc.make('cadence:set', { payload: cadenceRequest, ...unary(cadenceValueSchema) }),
  Rpc.make('store:status', unary(scanStatusSchema)),
  Rpc.make('settings:info', unary(settingsInfoSchema)),
  Rpc.make('settings:clear', unary(settingsInfoSchema)),
  Rpc.make('pricing:refresh', unary(pricingRefreshResultSchema)),
  Rpc.make('currency:get', unary(activeCurrencySchema)),
  Rpc.make('currency:set', { payload: currencyRequest, ...unary(activeCurrencySchema) }),
  Rpc.make('currency:list', unary(currencyOptionsSchema)),

  Rpc.make('worker:events', { success: SequencedWorkerEventSchema, error, stream: true }),
)
