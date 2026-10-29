import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRpc from 'effect/reactivity/AtomRpc'
import * as RpcTest from 'effect/rpc/RpcTest'

import { AnalyticsRpcGroup } from '../src/shared/rpc/analytics.js'
import { AnalyticsRpcError } from '../src/shared/rpc/errors.js'
import type { ComparePair, ComparePayload } from '../src/shared/schemas/compare.js'
import type { ModelsPayload } from '../src/shared/schemas/models.js'
import type { OptimizePayload } from '../src/shared/schemas/optimize.js'
import type { OverviewPayload, OverviewScope } from '../src/shared/schemas/overview.js'
import type { PullRequestsPayload } from '../src/shared/schemas/pull-requests.js'
import type { SkillsPayload, SkillsThresholds } from '../src/shared/schemas/skills.js'
import type { SpendPayload } from '../src/shared/schemas/spend.js'
import type { SearchHit, SessionDetail, SessionRow } from '../src/shared/schemas/views.js'
import type { YieldPayload } from '../src/shared/schemas/yield.js'

export interface AnalyticsRpcTestHandlers {
  readonly overview?: (scope: OverviewScope) => Promise<OverviewPayload | null>
  readonly compare?: (scope: OverviewScope, pair?: ComparePair) => Promise<ComparePayload | null>
  readonly sessionRows?: (scope: OverviewScope) => Promise<SessionRow[]>
  readonly session?: (request: {
    readonly sessionId: string
    readonly sourceId?: number
  }) => Promise<SessionDetail | null>
  readonly pullRequests?: (scope: OverviewScope) => Promise<PullRequestsPayload | null>
  readonly spend?: (scope: OverviewScope) => Promise<SpendPayload | null>
  readonly models?: (scope: OverviewScope) => Promise<ModelsPayload | null>
  readonly optimize?: (scope: OverviewScope) => Promise<OptimizePayload | null>
  readonly yield?: (scope: OverviewScope) => Promise<YieldPayload | null>
  readonly skills?: (scope: OverviewScope, thresholds?: SkillsThresholds) => Promise<SkillsPayload | null>
  readonly search?: (query: string) => Promise<SearchHit[]>
}

const unavailable = () => new AnalyticsRpcError({ code: 'unavailable', message: 'Analytics service unavailable' })
const fromPromise = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: unavailable })

/** Runs real AnalyticsRpcGroup handlers through AtomRpc and RpcTest in renderer query tests. */
export function makeAnalyticsRpcTestClient(
  runtime: Atom.RegistryRuntimeFactory,
  overrides: AnalyticsRpcTestHandlers = {},
) {
  const handlers = AnalyticsRpcGroup.toLayer(
    AnalyticsRpcGroup.of({
      'store:views': () => Effect.succeed(null),
      'store:projects': () => Effect.succeed([]),
      'store:sessions': () => Effect.succeed([]),
      'store:session': request => fromPromise(() => overrides.session?.(request) ?? Promise.resolve(null)),
      'store:analytics': () => Effect.succeed(null),
      'overview:query': ({ scope }) => fromPromise(() => overrides.overview?.(scope) ?? Promise.resolve(null)),
      'sessions:view': ({ scope }) => fromPromise(() => overrides.sessionRows?.(scope) ?? Promise.resolve([])),
      'pullRequests:view': ({ scope }) => fromPromise(() => overrides.pullRequests?.(scope) ?? Promise.resolve(null)),
      'spend:view': ({ scope }) => fromPromise(() => overrides.spend?.(scope) ?? Promise.resolve(null)),
      'models:view': ({ scope }) => fromPromise(() => overrides.models?.(scope) ?? Promise.resolve(null)),
      'compare:view': ({ scope, pair }) => fromPromise(() => overrides.compare?.(scope, pair) ?? Promise.resolve(null)),
      'optimize:view': ({ scope }) => fromPromise(() => overrides.optimize?.(scope) ?? Promise.resolve(null)),
      'optimize:yield': ({ scope }) => fromPromise(() => overrides.yield?.(scope) ?? Promise.resolve(null)),
      'skills:view': ({ scope, thresholds }) =>
        fromPromise(() => overrides.skills?.(scope, thresholds) ?? Promise.resolve(null)),
      'store:search': ({ query }) => fromPromise(() => overrides.search?.(query) ?? Promise.resolve([])),
    }),
  )
  return AtomRpc.Service<object>()('test/AnalyticsRpc', {
    group: AnalyticsRpcGroup,
    protocol: Layer.empty,
    runtime,
    makeEffect: RpcTest.makeClient(AnalyticsRpcGroup, { flatten: true }).pipe(Effect.provide(handlers)),
  })
}
