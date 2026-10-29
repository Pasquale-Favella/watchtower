import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import * as Analytics from '../../../../shared/rpc/analytics.js'
import { ConfigRpcGroup, okResultSchema } from '../../../../shared/rpc/config.js'
import { AnalyticsRpcError, ConfigRpcError } from '../../../../shared/rpc/errors.js'
import { cadenceValueSchema } from '../../../../shared/schemas/cadence.js'
import { activeCurrencySchema, currencyOptionsSchema } from '../../../../shared/schemas/fx.js'
import { pricingRefreshResultSchema, scanStatusSchema, settingsInfoSchema } from '../../../../shared/schemas/ipc.js'
import { modelAliasSchema, priceOverrideSchema } from '../../../../shared/schemas/models.js'

export interface RpcDataWorker {
  readonly request: (operation: string, ...args: unknown[]) => Promise<unknown>
}

/** The worker remains the data owner; this adapter validates each returned representation. */
export function analyticsHandlers(worker: RpcDataWorker, role: 'app' | 'panel' = 'app') {
  function read<S extends Schema.ConstraintDecoder<unknown>>(schema: S, operation: string, ...args: unknown[]) {
    return Effect.tryPromise({
      try: () => worker.request(operation, ...args),
      catch: () => new AnalyticsRpcError({ code: 'query-failed', message: 'Analytics query failed' }),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError(() => new AnalyticsRpcError({ code: 'query-failed', message: 'Analytics query failed' })),
    )
  }
  return Analytics.AnalyticsRpcGroup.toLayer({
    'store:views': () => read(Analytics.GetViews.successSchema, 'store:views'),
    'store:projects': () => read(Analytics.GetProjects.successSchema, 'store:projects'),
    'store:sessions': ({ filter }) => read(Analytics.GetSessions.successSchema, 'store:sessions', filter),
    'store:session': ({ sessionId, sourceId }) =>
      sourceId === undefined
        ? read(Analytics.GetSession.successSchema, 'store:session', sessionId)
        : read(Analytics.GetSession.successSchema, 'store:session', sessionId, sourceId),
    'store:analytics': () => read(Analytics.GetAnalytics.successSchema, 'store:analytics'),
    'overview:query': ({ scope }) => {
      if (
        role === 'panel' &&
        ((scope.period !== 'today' && scope.period !== '30days') ||
          scope.provider !== undefined ||
          scope.range !== undefined)
      ) {
        return Effect.fail(new AnalyticsRpcError({ code: 'invalid-request', message: 'Invalid analytics request' }))
      }
      return read(Analytics.GetOverview.successSchema, 'overview:query', scope)
    },
    'sessions:view': ({ scope }) => read(Analytics.GetSessionRows.successSchema, 'sessions:view', scope),
    'pullRequests:view': ({ scope }) => read(Analytics.GetPullRequests.successSchema, 'pullRequests:view', scope),
    'spend:view': ({ scope }) => read(Analytics.GetSpend.successSchema, 'spend:view', scope),
    'models:view': ({ scope }) => read(Analytics.GetModels.successSchema, 'models:view', scope),
    'compare:view': ({ scope, pair }) => read(Analytics.GetCompare.successSchema, 'compare:view', scope, pair),
    'optimize:view': ({ scope }) => read(Analytics.GetOptimize.successSchema, 'optimize:view', scope),
    'optimize:yield': ({ scope }) => read(Analytics.GetYield.successSchema, 'optimize:yield', scope),
    'skills:view': ({ scope, thresholds }) => read(Analytics.GetSkills.successSchema, 'skills:view', scope, thresholds),
    'store:search': ({ query }) => read(Analytics.Search.successSchema, 'store:search', query),
  })
}

export function configHandlers<R>(
  worker: RpcDataWorker,
  configRevision: Effect.Effect<number, never, R>,
  ledgerGeneration: Effect.Effect<number, never, R> = Effect.succeed(0),
) {
  function request<S extends Schema.ConstraintDecoder<unknown>>(schema: S, operation: string, ...args: unknown[]) {
    return Effect.tryPromise({
      try: () => worker.request(operation, ...args),
      catch: () => new ConfigRpcError({ code: 'command-failed', message: 'Configuration command failed' }),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError(() => new ConfigRpcError({ code: 'command-failed', message: 'Configuration command failed' })),
    )
  }
  const ok = okResultSchema
  const write = Effect.fn('configHandlers.write')(function* (operation: string, ...args: unknown[]) {
    yield* request(ok, operation, ...args)
    // Worker events precede its acknowledgement on the same port. This revision
    // therefore includes this write, even when another window also changed config.
    return { ok: true as const, configRevision: yield* configRevision }
  })
  return ConfigRpcGroup.toLayer({
    'models:getAliases': () => request(Schema.mutable(Schema.Array(modelAliasSchema)), 'models:getAliases'),
    'models:addAlias': ({ model, aliasOf }) => write('models:addAlias', model, aliasOf),
    'models:removeAlias': ({ model }) => write('models:removeAlias', model),
    'models:getPriceOverrides': () =>
      request(Schema.mutable(Schema.Array(priceOverrideSchema)), 'models:getPriceOverrides'),
    'models:setPrice': ({ model, inputPricePerMillion, outputPricePerMillion }) =>
      write('models:setPrice', model, inputPricePerMillion, outputPricePerMillion),
    'models:removePriceOverride': ({ model }) => write('models:removePriceOverride', model),
    'cadence:get': () => request(cadenceValueSchema, 'cadence:get'),
    'cadence:set': ({ value }) => request(cadenceValueSchema, 'cadence:set', value),
    'currency:get': () => request(activeCurrencySchema, 'currency:get'),
    'currency:set': ({ code }) => request(activeCurrencySchema, 'currency:set', code),
    'currency:list': () => request(currencyOptionsSchema, 'currency:list'),
    'store:status': () => request(scanStatusSchema, 'store:status'),
    'settings:info': () => request(settingsInfoSchema, 'settings:info'),
    'settings:clear': () =>
      request(settingsInfoSchema, 'settings:clear').pipe(
        Effect.flatMap(settings =>
          Effect.map(ledgerGeneration, generation => ({ settings, ledgerGeneration: generation })),
        ),
      ),
    'pricing:refresh': () => request(pricingRefreshResultSchema, 'pricing:refresh'),
  })
}
