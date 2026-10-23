import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { RpcClient } from 'effect/rpc'
import type { RpcClientError } from 'effect/rpc/RpcClientError'
import * as Schema from 'effect/Schema'

import { ApplicationRpcGroup } from '../../../../shared/rpc/application.js'
import type { RpcBridge } from '../../../../shared/rpc/bridge.js'
import { AnalyticsRpcError, ConfigRpcError } from '../../../../shared/rpc/errors.js'
import { clientProtocolLayer } from '../../../../shared/rpc/port-protocol.js'
import type { ComparePair } from '../../../../shared/schemas/compare.js'
import type { OverviewScope } from '../../../../shared/schemas/overview.js'
import type { SkillsThresholds } from '../../../../shared/schemas/skills.js'
import { legacyRendererApi, RendererApi, RendererApiError } from './renderer-api.js'
import { rpcMessagePortFromBridge } from './rpc-port.js'

type RpcFunction<Args extends unknown[], A, E> = (...args: Args) => Effect.Effect<A, E>

const safeRpcErrorMessage = (error: unknown): string => {
  if (Schema.is(AnalyticsRpcError)(error) || Schema.is(ConfigRpcError)(error)) return error.message
  return 'Unable to reach the application.'
}

const method =
  <Args extends unknown[], A, E>(
    operation: string,
    call: RpcFunction<Args, A, E> | undefined,
  ): RpcFunction<Args, A, RendererApiError> =>
  (...args) => {
    if (!call) return Effect.fail(new RendererApiError({ operation, message: 'Unable to reach the application.' }))
    return call(...args).pipe(
      Effect.mapError(error => new RendererApiError({ operation, message: safeRpcErrorMessage(error) })),
    )
  }

/** Builds the renderer service with RPC-backed analytics/config calls and explicit legacy adapters elsewhere. */
export const rendererRpcApiLayer = (bridge: RpcBridge): Layer.Layer<RendererApi> =>
  Layer.effect(
    RendererApi,
    Effect.gen(function* () {
      const connection = yield* Effect.tryPromise({
        try: () => bridge.connect(),
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (connection?._tag !== 'Connected') return { ...legacyRendererApi, ...rpcMethods(undefined) }

      const protocol = yield* Layer.build(clientProtocolLayer(rpcMessagePortFromBridge(bridge, connection.generation)))
      const client = yield* RpcClient.make(ApplicationRpcGroup).pipe(
        Effect.provideService(RpcClient.Protocol, Context.get(protocol, RpcClient.Protocol)),
      )
      return { ...legacyRendererApi, ...rpcMethods(client) }
    }),
  )

const rpcMethods = (client: RpcClient.FromGroup<typeof ApplicationRpcGroup, RpcClientError> | undefined) => ({
  getScanStatus: method('store:status', client && (() => client['store:status'](undefined))),
  getViews: method('store:views', client && (() => client['store:views'](undefined))),
  getProjects: method('store:projects', client && (() => client['store:projects'](undefined))),
  getSessions: method(
    'store:sessions',
    client && ((filter: Parameters<typeof legacyRendererApi.getSessions>[0]) => client['store:sessions']({ filter })),
  ),
  getSession: method(
    'store:session',
    client && ((sessionId: string, sourceId?: number) => client['store:session']({ sessionId, sourceId })),
  ),
  getAnalytics: method('store:analytics', client && (() => client['store:analytics'](undefined))),
  getOverview: method('overview:query', client && ((scope: OverviewScope) => client['overview:query']({ scope }))),
  getSessionRows: method('sessions:view', client && ((scope: OverviewScope) => client['sessions:view']({ scope }))),
  getPullRequests: method(
    'pullRequests:view',
    client && ((scope: OverviewScope) => client['pullRequests:view']({ scope })),
  ),
  getSpend: method('spend:view', client && ((scope: OverviewScope) => client['spend:view']({ scope }))),
  getModels: method('models:view', client && ((scope: OverviewScope) => client['models:view']({ scope }))),
  getCompare: method(
    'compare:view',
    client && ((scope: OverviewScope, pair?: ComparePair) => client['compare:view']({ scope, pair })),
  ),
  getOptimize: method('optimize:view', client && ((scope: OverviewScope) => client['optimize:view']({ scope }))),
  getYield: method('optimize:yield', client && ((scope: OverviewScope) => client['optimize:yield']({ scope }))),
  getSkills: method(
    'skills:view',
    client && ((scope: OverviewScope, thresholds?: SkillsThresholds) => client['skills:view']({ scope, thresholds })),
  ),
  search: method('store:search', client && ((query: string) => client['store:search']({ query }))),
  getModelAliases: method('models:getAliases', client && (() => client['models:getAliases'](undefined))),
  addModelAlias: method(
    'models:addAlias',
    client && ((model: string, aliasOf: string) => client['models:addAlias']({ model, aliasOf })),
  ),
  removeModelAlias: method(
    'models:removeAlias',
    client && ((model: string) => client['models:removeAlias']({ model })),
  ),
  getPriceOverrides: method(
    'models:getPriceOverrides',
    client && (() => client['models:getPriceOverrides'](undefined)),
  ),
  setModelPrice: method(
    'models:setPrice',
    client &&
      ((model: string, inputPricePerMillion: number, outputPricePerMillion: number) =>
        client['models:setPrice']({ model, inputPricePerMillion, outputPricePerMillion })),
  ),
  removePriceOverride: method(
    'models:removePriceOverride',
    client && ((model: string) => client['models:removePriceOverride']({ model })),
  ),
  getCadence: method('cadence:get', client && (() => client['cadence:get'](undefined))),
  setCadence: method('cadence:set', client && ((value: string) => client['cadence:set']({ value }))),
  getCurrency: method('currency:get', client && (() => client['currency:get'](undefined))),
  setCurrency: method('currency:set', client && ((code: string) => client['currency:set']({ code }))),
  getCurrencies: method('currency:list', client && (() => client['currency:list'](undefined))),
  getSettings: method('settings:info', client && (() => client['settings:info'](undefined))),
  clearData: method('settings:clear', client && (() => client['settings:clear'](undefined))),
  refreshPricing: method('pricing:refresh', client && (() => client['pricing:refresh'](undefined))),
})
