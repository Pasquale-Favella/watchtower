import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import * as AtomRpc from 'effect/reactivity/AtomRpc'
import * as Reactivity from 'effect/reactivity/Reactivity'
import * as RpcGroup from 'effect/rpc/RpcGroup'
import * as RpcTest from 'effect/rpc/RpcTest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { restartRpcQuery } from '../src/renderer/src/app/atoms/rpc-query.js'
import { createModelsAtoms } from '../src/renderer/src/features/models/atoms.js'
import { createOptimizeAtoms } from '../src/renderer/src/features/optimize/atoms.js'
import { createOverviewAtoms } from '../src/renderer/src/features/overview/atoms.js'
import { createPullRequestsAtoms } from '../src/renderer/src/features/pull-requests/atoms.js'
import { createSessionsAtoms } from '../src/renderer/src/features/sessions/atoms.js'
import { createSpendAtoms } from '../src/renderer/src/features/spend/atoms.js'
import { RendererApi } from '../src/renderer/src/shared/lib/renderer-api.js'
import { GetOverview } from '../src/shared/rpc/analytics.js'
import { AnalyticsRpcError } from '../src/shared/rpc/errors.js'
import type { OverviewScope } from '../src/shared/schemas/overview.js'
import type { OverviewPayload } from '../src/shared/schemas/overview.js'

const registries: AtomRegistry.AtomRegistry[] = []
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose()
  vi.unstubAllGlobals()
})

const OverviewGroup = RpcGroup.make(GetOverview)

function makeOverviewClient(factory: Atom.RegistryRuntimeFactory, getOverview: (scope: OverviewScope) => unknown) {
  const handlers = OverviewGroup.toLayer(
    OverviewGroup.of({
      'overview:query': ({ scope }) =>
        Effect.tryPromise({
          try: () => Promise.resolve(getOverview(scope) as OverviewPayload | null),
          catch: () => new AnalyticsRpcError({ code: 'unavailable', message: 'Analytics service unavailable' }),
        }),
    }),
  )
  return AtomRpc.Service<object>()('test/OverviewRpc', {
    group: OverviewGroup,
    protocol: Layer.empty,
    runtime: factory,
    makeEffect: RpcTest.makeClient(OverviewGroup, { flatten: true }).pipe(Effect.provide(handlers)),
  })
}

function setup(api: unknown, getOverview?: (scope: OverviewScope) => unknown) {
  vi.stubGlobal('window', { api })
  const registry = AtomRegistry.make()
  registries.push(registry)
  const factory = Atom.context()
  const overviewClient = getOverview === undefined ? undefined : makeOverviewClient(factory, getOverview)
  return {
    registry,
    ...createOverviewAtoms(
      overviewClient &&
        ((scope, selectionId) =>
          overviewClient.query(
            'overview:query',
            { scope },
            { serializationKey: selectionId, reactivityKeys: ['ledger', 'pricing'] },
          )),
    ),
    ...createSessionsAtoms(factory),
    ...createPullRequestsAtoms(factory),
    ...createSpendAtoms(factory),
    ...createOptimizeAtoms(factory),
    ...createModelsAtoms(factory),
    invalidate: factory(RendererApi.layer).fn(() => Reactivity.invalidate(['ledger', 'pricing'])),
  }
}

async function ready<A, E>(registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) {
  await vi.waitFor(() => expect(registry.get(atom)).toMatchObject({ _tag: 'Success', waiting: false }))
  return AsyncResult.getOrThrow(registry.get(atom))
}

const overviewPayload = {
  kpis: {
    cost: 1,
    calls: 2,
    sessions: 3,
    inputTokens: 4,
    outputTokens: 5,
    cacheReadTokens: 6,
    cacheWriteTokens: 7,
    savingsUSD: 8,
    estimatedCostUSD: 9,
    oneShotRate: null,
    cacheHitPercent: 10,
  },
  daily: [],
  dataStart: null,
  models: [],
  activities: [],
  tools: [],
  mcpServers: [],
  skills: [],
  subagents: [],
  efficiency: {
    score: 80,
    grade: 'B',
    oneShotRate: null,
    retryTax: { totalUSD: 0, retries: 0, editTurns: 0, byModel: [] },
    routingWaste: { baselineModel: 'x', baselineCostPerEdit: 0, totalSavingsUSD: 0, byModel: [] },
    pricingCoverage: 1,
  },
  workflow: {
    corrections: 0,
    userTurns: 0,
    correctionRate: null,
    medianTimeToFirstEditMs: null,
    topReworkedFiles: [],
  },
  unpricedModels: [],
  localModelSavings: { totalUSD: 0, calls: 0, byModel: [], byProvider: [] },
}

describe('native analytics queries preserve the shared wire contract', () => {
  it('loads Overview by Scope and keeps the payload during same-key invalidation', async () => {
    const getOverview = vi.fn(() => Promise.resolve(overviewPayload))
    const { registry, overviewQuery, invalidate } = setup({ getOverview }, getOverview)
    const scope: OverviewScope = { period: 'week', provider: 'openai' }
    registry.set(overviewQuery.requestAtom, scope)
    overviewQuery.pin(registry)
    expect(await ready(registry, overviewQuery.resultAtom)).toEqual(overviewPayload)
    expect(getOverview).toHaveBeenCalledWith(scope)
    registry.set(invalidate, undefined)
    expect(AsyncResult.value(registry.get(overviewQuery.resultAtom))).toMatchObject({ value: overviewPayload })
    await vi.waitFor(() => expect(getOverview).toHaveBeenCalledTimes(2))
    expect(await ready(registry, overviewQuery.resultAtom)).toEqual(overviewPayload)
  })

  it('retains Overview data with its typed RPC error when a refresh fails', async () => {
    let calls = 0
    const { registry, overviewQuery } = setup({}, () => {
      calls += 1
      return calls === 1 ? overviewPayload : Promise.reject(new Error('overview unavailable'))
    })
    registry.set(overviewQuery.requestAtom, { period: 'week' })
    overviewQuery.pin(registry)
    expect(await ready(registry, overviewQuery.resultAtom)).toEqual(overviewPayload)

    registry.set(overviewQuery.refreshAtom, undefined)
    await vi.waitFor(() => {
      const result = registry.get(overviewQuery.resultAtom)
      expect(result._tag).toBe('Failure')
      if (AsyncResult.isFailure(result)) {
        expect(Option.getOrThrow(result.previousSuccess).value).toEqual(overviewPayload)
        expect(String(result.cause)).toContain('AnalyticsRpcError')
      }
    })
  })

  it('starts at Initial and gives A/B/A plus reset fresh Overview selections', async () => {
    const pending: Array<(value: unknown) => void> = []
    const calls: string[] = []
    const { registry, overviewQuery } = setup({}, scope => {
      calls.push(scope.period)
      return new Promise(resolve => pending.push(resolve))
    })
    overviewQuery.pin(registry)
    expect(registry.get(overviewQuery.resultAtom)._tag).toBe('Initial')

    registry.set(overviewQuery.requestAtom, { period: 'today' })
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    pending[0](overviewPayload)
    expect(await ready(registry, overviewQuery.resultAtom)).toEqual(overviewPayload)

    registry.set(overviewQuery.requestAtom, { period: 'week' })
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    registry.set(overviewQuery.requestAtom, { period: 'today' })
    await vi.waitFor(() => expect(pending).toHaveLength(3))
    pending[1]({ kpis: 'late' })
    expect(registry.get(overviewQuery.resultAtom)._tag).toBe('Initial')
    pending[2](overviewPayload)
    expect(await ready(registry, overviewQuery.resultAtom)).toEqual(overviewPayload)
    expect(calls).toEqual(['today', 'week', 'today'])

    restartRpcQuery(registry, overviewQuery)
    await vi.waitFor(() => expect(pending).toHaveLength(4))
    pending[3](null)
    expect(await ready(registry, overviewQuery.resultAtom)).toBeNull()
  })

  it('forwards rows Scope and detail source identity independently', async () => {
    const getSessionRows = vi.fn(() => Promise.resolve([]))
    const getSession = vi.fn(() => Promise.resolve(null))
    const { registry, sessionRowsQuery, sessionQuery } = setup({ getSessionRows, getSession })
    registry.set(sessionRowsQuery.requestAtom, { period: 'today' })
    sessionRowsQuery.pin(registry)
    expect(await ready(registry, sessionRowsQuery.resultAtom)).toEqual([])
    registry.set(sessionQuery.requestAtom, { sessionId: 'abc', sourceId: 2 })
    sessionQuery.pin(registry)
    expect(await ready(registry, sessionQuery.resultAtom)).toBeNull()
    expect(getSessionRows).toHaveBeenCalledWith({ period: 'today' })
    expect(getSession).toHaveBeenCalledWith('abc', 2)
    registry.set(sessionQuery.resetAtom, undefined)
    expect(registry.get(sessionQuery.resultAtom)._tag).toBe('Initial')
  })

  it('keeps unopened sections lazy and refreshes each activated slice once', async () => {
    const getSpend = vi.fn(() => Promise.resolve(null))
    const getOptimize = vi.fn(() => Promise.resolve(null))
    const getYield = vi.fn(() => Promise.resolve(null))
    const { registry, optimizeQuery, yieldQuery, invalidate } = setup({ getSpend, getOptimize, getYield })
    registry.set(optimizeQuery.requestAtom, { period: 'week' })
    optimizeQuery.pin(registry)
    await ready(registry, optimizeQuery.resultAtom)
    registry.set(invalidate, undefined)
    await vi.waitFor(() => expect(getOptimize).toHaveBeenCalledTimes(2))
    expect(getYield).not.toHaveBeenCalled()
    expect(getSpend).not.toHaveBeenCalled()
    registry.set(yieldQuery.requestAtom, { period: 'week' })
    yieldQuery.pin(registry)
    await ready(registry, yieldQuery.resultAtom)
    registry.set(invalidate, undefined)
    await vi.waitFor(() => {
      expect(getOptimize).toHaveBeenCalledTimes(3)
      expect(getYield).toHaveBeenCalledTimes(2)
    })
    expect(getSpend).not.toHaveBeenCalled()
  })

  it('uses the correct operations for Pull Requests, Spend and Models', async () => {
    const getPullRequests = vi.fn(() => Promise.resolve(null))
    const getSpend = vi.fn(() => Promise.resolve(null))
    const getModels = vi.fn(() => Promise.resolve(null))
    const { registry, pullRequestsQuery, spendQuery, modelsQuery } = setup({ getPullRequests, getSpend, getModels })
    for (const query of [pullRequestsQuery, spendQuery, modelsQuery]) {
      registry.set(query.requestAtom, { period: '30days' })
      query.pin(registry)
      expect(await ready<unknown, unknown>(registry, query.resultAtom)).toBeNull()
    }
    for (const operation of [getPullRequests, getSpend, getModels])
      expect(operation).toHaveBeenCalledWith({ period: '30days' })
  })

  it('exposes failed overview RPC calls as query failures', async () => {
    const { registry, overviewQuery } = setup(
      { getOverview: () => Promise.reject(new Error('overview unavailable')) },
      () => Promise.reject(new Error('overview unavailable')),
    )
    registry.set(overviewQuery.requestAtom, { period: 'today' })
    overviewQuery.pin(registry)
    await vi.waitFor(() => {
      const result = registry.get(overviewQuery.resultAtom)
      expect(result._tag).toBe('Failure')
      if (AsyncResult.isFailure(result)) expect(String(result.cause)).toContain('AnalyticsRpcError')
    })
  })
})
