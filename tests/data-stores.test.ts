import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import * as Reactivity from 'effect/reactivity/Reactivity'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createModelsAtoms } from '../src/renderer/src/features/models/atoms.js'
import { createOptimizeAtoms } from '../src/renderer/src/features/optimize/atoms.js'
import { createOverviewAtoms } from '../src/renderer/src/features/overview/atoms.js'
import { createPullRequestsAtoms } from '../src/renderer/src/features/pull-requests/atoms.js'
import { createSessionsAtoms } from '../src/renderer/src/features/sessions/atoms.js'
import { createSpendAtoms } from '../src/renderer/src/features/spend/atoms.js'
import { RendererApi } from '../src/renderer/src/shared/lib/renderer-api.js'
import type { OverviewScope } from '../src/shared/schemas/overview.js'

const registries: AtomRegistry.AtomRegistry[] = []
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose()
  vi.unstubAllGlobals()
})

function setup(api: unknown) {
  vi.stubGlobal('window', { api })
  const registry = AtomRegistry.make()
  registries.push(registry)
  const factory = Atom.context()
  return {
    registry,
    ...createOverviewAtoms(factory),
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
    const { registry, overviewQuery, invalidate } = setup({ getOverview })
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

  it('exposes malformed analytics payloads as typed failures', async () => {
    const { registry, overviewQuery } = setup({ getOverview: () => Promise.resolve({ kpis: 'invalid' }) })
    registry.set(overviewQuery.requestAtom, { period: 'today' })
    overviewQuery.pin(registry)
    await vi.waitFor(() => expect(registry.get(overviewQuery.resultAtom)._tag).toBe('Failure'))
  })
})
