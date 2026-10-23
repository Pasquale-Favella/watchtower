import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import * as Reactivity from 'effect/reactivity/Reactivity'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createPlacementAtoms } from '../src/renderer/src/orb/placement-atoms.js'
import { createPanelAtoms, ORB_SCOPES } from '../src/renderer/src/orb/panel-atoms.js'
import { legacyRendererApi, RendererApi, RendererApiError } from '../src/renderer/src/shared/lib/renderer-api.js'
import type { OrbPlacement } from '../src/shared/schemas/orb.js'
import type { OverviewPayload } from '../src/shared/schemas/overview.js'

const registries: AtomRegistry.AtomRegistry[] = []
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose()
})

const expanded = { expanded: true, peek: false, horizontal: 'right', vertical: 'bottom' } satisfies OrbPlacement
const collapsed = { ...expanded, expanded: false } satisfies OrbPlacement

const payload: OverviewPayload = {
  kpis: {
    cost: 12,
    calls: 8,
    sessions: 2,
    inputTokens: 100,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    savingsUSD: 1,
    estimatedCostUSD: 12,
    oneShotRate: null,
    cacheHitPercent: 0,
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
    score: 0,
    grade: 'F',
    oneShotRate: null,
    retryTax: { totalUSD: 0, retries: 0, editTurns: 0, byModel: [] },
    routingWaste: { baselineModel: '', baselineCostPerEdit: 0, totalSavingsUSD: 0, byModel: [] },
    pricingCoverage: 0,
  },
  workflow: { corrections: 0, userTurns: 0, correctionRate: null, medianTimeToFirstEditMs: null, topReworkedFiles: [] },
  unpricedModels: [],
  localModelSavings: { totalUSD: 0, calls: 0, byModel: [], byProvider: [] },
}

function setup(overrides: Partial<RendererApi['Service']> = {}) {
  const registry = AtomRegistry.make()
  registries.push(registry)
  const factory = Atom.context()
  const layer = Layer.succeed(RendererApi, {
    ...legacyRendererApi,
    getOrbPlacement: () => Effect.succeed(collapsed),
    requestOrbPanel: request => Effect.succeed(request === 'fold' ? collapsed : expanded),
    getOverview: () => Effect.succeed(payload),
    ...overrides,
  })
  return { registry, factory, layer }
}

function readResult<A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<import('effect/reactivity/AsyncResult').AsyncResult<A, E>>,
) {
  return Effect.runPromise(AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }))
}

describe('orb placement atoms', () => {
  it('loads the current placement unless a newer placement event arrived', async () => {
    let finishRead!: (placement: OrbPlacement) => void
    const { registry, factory, layer } = setup({
      getOrbPlacement: () => Effect.promise(() => new Promise(resolve => (finishRead = resolve))),
    })
    const { placementAtom, syncPlacementAtom } = createPlacementAtoms(factory, layer)
    registry.set(syncPlacementAtom, undefined)
    const syncing = readResult(registry, syncPlacementAtom)
    registry.set(placementAtom, { ...expanded, peek: true })
    finishRead(collapsed)
    await syncing
    expect(registry.get(placementAtom)).toEqual({ ...expanded, peek: true })
  })

  it('sends one panel intent and mirrors the main process response', async () => {
    const requestOrbPanel = vi.fn((request: 'open' | 'fold') =>
      Effect.succeed(request === 'fold' ? collapsed : expanded),
    )
    const { registry, factory, layer } = setup({ requestOrbPanel })
    const { placementAtom, requestPlacementAtom } = createPlacementAtoms(factory, layer)
    registry.set(requestPlacementAtom, 'open')
    await readResult(registry, requestPlacementAtom)
    expect(requestOrbPanel).toHaveBeenCalledExactlyOnceWith('open')
    expect(registry.get(placementAtom)).toEqual(expanded)
  })

  it('lets a later event win over an in-flight panel command', async () => {
    let finishRequest!: (placement: OrbPlacement) => void
    const { registry, factory, layer } = setup({
      requestOrbPanel: () => Effect.promise(() => new Promise(resolve => (finishRequest = resolve))),
    })
    const { placementAtom, requestPlacementAtom } = createPlacementAtoms(factory, layer)
    registry.set(requestPlacementAtom, 'open')
    const request = readResult(registry, requestPlacementAtom)
    const latest = { ...collapsed, horizontal: 'left' } satisfies OrbPlacement
    registry.set(placementAtom, latest)
    finishRequest(expanded)
    await request
    expect(registry.get(placementAtom)).toEqual(latest)
  })
})

describe('orb panel atoms', () => {
  it('loads exactly the fixed today and 30-day scopes after selection', async () => {
    const getOverview = vi.fn((scope: { period: string }) => Effect.succeed(scope.period === 'today' ? payload : null))
    const { registry, factory, layer } = setup({ getOverview })
    const { orbTodayQuery, orbRecentQuery, loadOrbOverviewAtom } = createPanelAtoms(factory, layer)
    expect(registry.get(orbTodayQuery.resultAtom)._tag).toBe('Initial')
    expect(registry.get(orbRecentQuery.resultAtom)._tag).toBe('Initial')
    orbTodayQuery.pin(registry)
    orbRecentQuery.pin(registry)
    registry.set(loadOrbOverviewAtom, undefined)
    await readResult(registry, loadOrbOverviewAtom)
    expect(getOverview).toHaveBeenCalledTimes(2)
    expect(getOverview).toHaveBeenCalledWith(ORB_SCOPES.today)
    expect(getOverview).toHaveBeenCalledWith(ORB_SCOPES.recent)
    expect(registry.get(orbTodayQuery.resultAtom)._tag).toBe('Success')
    expect(registry.get(orbRecentQuery.resultAtom)._tag).toBe('Success')
  })

  it('completes readiness after null results or typed failures', async () => {
    const { registry, factory, layer } = setup({
      getOverview: scope =>
        scope.period === 'today'
          ? Effect.succeed(null)
          : Effect.fail(new RendererApiError({ operation: 'overview', message: 'Unavailable' })),
    })
    const { orbTodayQuery, orbRecentQuery, loadOrbOverviewAtom, orbOverviewLoadedAtom } = createPanelAtoms(
      factory,
      layer,
    )
    orbTodayQuery.pin(registry)
    orbRecentQuery.pin(registry)
    registry.set(loadOrbOverviewAtom, undefined)
    await readResult(registry, loadOrbOverviewAtom)
    expect(registry.get(orbTodayQuery.resultAtom)._tag).toBe('Success')
    expect(registry.get(orbRecentQuery.resultAtom)._tag).toBe('Failure')
    expect(registry.get(orbOverviewLoadedAtom)).toBe(true)
  })

  it('reloads only selected scopes when ledger or pricing data changes', async () => {
    const getOverview = vi.fn(() => Effect.succeed(payload))
    const { registry, factory, layer } = setup({ getOverview })
    const { orbTodayQuery, orbRecentQuery, loadOrbOverviewAtom } = createPanelAtoms(factory, layer)
    orbTodayQuery.pin(registry)
    orbRecentQuery.pin(registry)
    registry.set(loadOrbOverviewAtom, undefined)
    await readResult(registry, loadOrbOverviewAtom)
    expect(getOverview).toHaveBeenCalledTimes(2)
    const invalidate = factory(layer).fn<undefined>()(() => Reactivity.invalidate(['ledger', 'pricing']))
    registry.set(invalidate, undefined)
    await readResult(registry, invalidate)
    await vi.waitFor(() => expect(getOverview).toHaveBeenCalledTimes(4))
  })
})
