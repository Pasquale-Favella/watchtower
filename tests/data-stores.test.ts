import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import * as Reactivity from 'effect/reactivity/Reactivity'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { restartRpcQuery } from '../src/renderer/stores/atoms/rpc-query.js'
import { createModelsAtoms } from '../src/renderer/features/models/atoms.js'
import { createOptimizeAtoms } from '../src/renderer/features/optimize/atoms.js'
import { createOverviewAtoms } from '../src/renderer/features/overview/atoms.js'
import { createPullRequestsAtoms } from '../src/renderer/features/pull-requests/atoms.js'
import { createSessionsAtoms } from '../src/renderer/features/sessions/atoms.js'
import { createSpendAtoms } from '../src/renderer/features/spend/atoms.js'
import { sessionRequestKey } from '../src/renderer/shared/lib/query-keys.js'
import type { OverviewScope } from '../src/shared/schemas/overview.js'
import type { OverviewPayload } from '../src/shared/schemas/overview.js'
import { makeAnalyticsRpcTestClient } from './analytics-rpc-test-helper.js'

const registries: AtomRegistry.AtomRegistry[] = []
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose()
})

function setup(handlers: Parameters<typeof makeAnalyticsRpcTestClient>[1] = {}) {
  const factory = Atom.context()
  const registry = AtomRegistry.make()
  registries.push(registry)
  const client = makeAnalyticsRpcTestClient(factory, handlers)
  const queries = {
    overview: (scope: OverviewScope, selectionId: string) =>
      client.query(
        'overview:query',
        { scope },
        { serializationKey: selectionId, reactivityKeys: ['ledger', 'pricing'] },
      ),
    sessionRows: (scope: OverviewScope, selectionId: string) =>
      client.query(
        'sessions:view',
        { scope },
        { serializationKey: selectionId, reactivityKeys: ['ledger', 'pricing'] },
      ),
    session: (request: { readonly sessionId: string; readonly sourceId?: number }, selectionId: string) =>
      client.query('store:session', request, {
        serializationKey: selectionId,
        reactivityKeys: ['ledger', 'pricing'],
      }),
    pullRequests: (scope: OverviewScope, selectionId: string) =>
      client.query(
        'pullRequests:view',
        { scope },
        { serializationKey: selectionId, reactivityKeys: ['ledger', 'pricing'] },
      ),
    spend: (scope: OverviewScope, selectionId: string) =>
      client.query('spend:view', { scope }, { serializationKey: selectionId, reactivityKeys: ['ledger', 'pricing'] }),
    models: (scope: OverviewScope, selectionId: string) =>
      client.query('models:view', { scope }, { serializationKey: selectionId, reactivityKeys: ['ledger', 'pricing'] }),
    optimize: (scope: OverviewScope, selectionId: string) =>
      client.query(
        'optimize:view',
        { scope },
        { serializationKey: selectionId, reactivityKeys: ['ledger', 'pricing'] },
      ),
    yield: (scope: OverviewScope, selectionId: string) =>
      client.query(
        'optimize:yield',
        { scope },
        { serializationKey: selectionId, reactivityKeys: ['ledger', 'pricing'] },
      ),
  }
  return {
    registry,
    ...createOverviewAtoms(queries.overview),
    ...createSessionsAtoms(queries.sessionRows, queries.session),
    ...createPullRequestsAtoms(queries.pullRequests),
    ...createSpendAtoms(queries.spend),
    ...createOptimizeAtoms(queries.optimize, queries.yield),
    ...createModelsAtoms(queries.models),
    invalidate: factory(Layer.empty).fn(() => Reactivity.invalidate(['ledger', 'pricing'])),
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
} satisfies OverviewPayload

describe('native analytics queries preserve the shared wire contract', () => {
  it('loads Overview by Scope and keeps the payload during same-key invalidation', async () => {
    const getOverview = vi.fn(() => Promise.resolve(overviewPayload))
    const { registry, overviewQuery, invalidate } = setup({ overview: getOverview })
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
    const { registry, overviewQuery } = setup({
      overview: () => {
        calls += 1
        return calls === 1 ? Promise.resolve(overviewPayload) : Promise.reject(new Error('overview unavailable'))
      },
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
    const pending: Array<(value: OverviewPayload | null) => void> = []
    const calls: string[] = []
    const { registry, overviewQuery } = setup({
      overview: scope => {
        calls.push(scope.period)
        return new Promise(resolve => pending.push(resolve))
      },
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
    pending[1]({ kpis: 'late' } as unknown as OverviewPayload)
    expect(registry.get(overviewQuery.resultAtom)._tag).toBe('Initial')
    pending[2](overviewPayload)
    expect(await ready(registry, overviewQuery.resultAtom)).toEqual(overviewPayload)
    expect(calls).toEqual(['today', 'week', 'today'])

    restartRpcQuery(registry, overviewQuery)
    await vi.waitFor(() => expect(pending).toHaveLength(4))
    pending[3](null)
    expect(await ready(registry, overviewQuery.resultAtom)).toBeNull()
  })

  it('forwards rows Scope and preserves optional detail source identity', async () => {
    const getSessionRows = vi.fn(() => Promise.resolve([]))
    const getSession = vi.fn(() => Promise.resolve(null))
    const { registry, sessionRowsQuery, sessionQuery, invalidate } = setup({
      sessionRows: getSessionRows,
      session: getSession,
    })
    registry.set(sessionRowsQuery.requestAtom, { period: 'today' })
    sessionRowsQuery.pin(registry)
    expect(await ready(registry, sessionRowsQuery.resultAtom)).toEqual([])

    registry.set(sessionQuery.requestAtom, { sessionId: 'abc', sourceId: 2 })
    sessionQuery.pin(registry)
    expect(await ready(registry, sessionQuery.resultAtom)).toBeNull()
    expect(getSessionRows).toHaveBeenCalledWith({ period: 'today' })
    expect(getSession).toHaveBeenCalledWith({ sessionId: 'abc', sourceId: 2 })
    registry.set(invalidate, undefined)
    await vi.waitFor(() => expect(getSession).toHaveBeenCalledTimes(2))

    registry.set(sessionQuery.requestAtom, { sessionId: 'abc' })
    await ready(registry, sessionQuery.resultAtom)
    expect(getSession).toHaveBeenLastCalledWith({ sessionId: 'abc' })
    expect(sessionRequestKey({ sessionId: 'abc', sourceId: 0 })).not.toBe(sessionRequestKey({ sessionId: 'abc' }))
    registry.set(sessionQuery.resetAtom, undefined)
    expect(registry.get(sessionQuery.resultAtom)._tag).toBe('Initial')

    registry.set(sessionQuery.requestAtom, { sessionId: 'abc', sourceId: 0 })
    await vi.waitFor(() => expect(registry.get(sessionQuery.resultAtom)._tag).toBe('Failure'))
    expect(getSession).toHaveBeenCalledTimes(3)
  })

  it('keeps unopened sections lazy and refreshes each activated Optimize query independently', async () => {
    const getSpend = vi.fn(() => Promise.resolve(null))
    const getOptimize = vi.fn(() => Promise.resolve(null))
    const getYield = vi.fn(() => Promise.resolve(null))
    const { registry, optimizeQuery, yieldQuery, invalidate } = setup({
      spend: getSpend,
      optimize: getOptimize,
      yield: getYield,
    })
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
    const { registry, pullRequestsQuery, spendQuery, modelsQuery } = setup({
      pullRequests: getPullRequests,
      spend: getSpend,
      models: getModels,
    })
    for (const query of [pullRequestsQuery, spendQuery, modelsQuery]) {
      registry.set(query.requestAtom, { period: '30days' })
      query.pin(registry)
      expect(await ready<unknown, unknown>(registry, query.resultAtom)).toBeNull()
    }
    for (const operation of [getPullRequests, getSpend, getModels])
      expect(operation).toHaveBeenCalledWith({ period: '30days' })
  })

  it('exposes failed Overview RPC calls as typed query failures', async () => {
    const { registry, overviewQuery } = setup({ overview: () => Promise.reject(new Error('overview unavailable')) })
    registry.set(overviewQuery.requestAtom, { period: 'today' })
    overviewQuery.pin(registry)
    await vi.waitFor(() => {
      const result = registry.get(overviewQuery.resultAtom)
      expect(result._tag).toBe('Failure')
      if (AsyncResult.isFailure(result)) expect(String(result.cause)).toContain('AnalyticsRpcError')
    })
  })
})
