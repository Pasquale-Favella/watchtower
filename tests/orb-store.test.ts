import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import * as AtomRpc from 'effect/reactivity/AtomRpc'
import * as Reactivity from 'effect/reactivity/Reactivity'
import * as RpcTest from 'effect/rpc/RpcTest'
import * as Stream from 'effect/Stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { restartRpcQuery } from '../src/renderer/src/app/atoms/rpc-query.js'
import { scanStateAtom } from '../src/renderer/src/app/atoms/scan.js'
import type { PanelOverviewQuery } from '../src/renderer/src/orb/panel-atoms.js'
import { createPanelAtoms, createPanelScanCommandAtoms, ORB_SCOPES } from '../src/renderer/src/orb/panel-atoms.js'
import { applyPanelLifecycleFrame, panelEventsReadyAtom } from '../src/renderer/src/orb/panel-wiring.js'
import { createPlacementAtoms } from '../src/renderer/src/orb/placement-atoms.js'
import { PanelRpcGroup } from '../src/shared/rpc/application.js'
import { AnalyticsRpcError } from '../src/shared/rpc/errors.js'
import { NativeRpcError } from '../src/shared/rpc/native.js'
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

function setup() {
  const registry = AtomRegistry.make()
  registries.push(registry)
  const factory = Atom.context()
  return { registry, factory }
}

function readResult<A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<import('effect/reactivity/AsyncResult').AsyncResult<A, E>>,
) {
  return Effect.runPromise(AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }))
}

function panelClient(
  factory: Atom.RegistryRuntimeFactory,
  getOverview: (scope: { period: string }) => Effect.Effect<OverviewPayload | null, AnalyticsRpcError>,
  startScan: () => Effect.Effect<
    { ok: boolean; aborted?: boolean; alreadyRunning?: boolean; error?: string },
    NativeRpcError
  > = () => Effect.succeed({ ok: true }),
) {
  const handlers = PanelRpcGroup.toLayer(
    PanelRpcGroup.of({
      'overview:query': ({ scope }) => getOverview(scope),
      'scan:start': () => startScan(),
      'panel:events': () => Stream.empty,
      'shell:events': () => Stream.empty,
      'shell:notice': () => Effect.void,
      'shell:open-external': () => Effect.void,
      'shell:open-settings': () => Effect.succeed(false),
      'orb:placement': () => Effect.succeed(collapsed),
      'orb:command': command =>
        Effect.succeed(command._tag === 'Panel' ? (command.request === 'fold' ? collapsed : expanded) : null),
    }),
  )
  return AtomRpc.Service<object>()('test/OrbPanelRpc', {
    group: PanelRpcGroup,
    protocol: Layer.empty,
    runtime: factory,
    makeEffect: RpcTest.makeClient(PanelRpcGroup, { flatten: true }).pipe(Effect.provide(handlers)),
  })
}

function panelQuery(
  factory: Atom.RegistryRuntimeFactory,
  getOverview: (scope: { period: string }) => Effect.Effect<OverviewPayload | null, AnalyticsRpcError>,
): PanelOverviewQuery {
  const client = panelClient(factory, getOverview)
  return (scope, selectionId) =>
    client.query('overview:query', { scope }, { serializationKey: selectionId, reactivityKeys: ['ledger', 'pricing'] })
}

describe('orb placement atoms', () => {
  it('loads the current placement unless a newer placement event arrived', async () => {
    let finishRead!: (placement: OrbPlacement) => void
    const { registry, factory } = setup()
    const { placementAtom, syncPlacementAtom } = createPlacementAtoms(
      factory(Layer.empty),
      Effect.promise(() => new Promise(resolve => (finishRead = resolve))),
      () => Effect.succeed(collapsed),
    )
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
    const { registry, factory } = setup()
    const { placementAtom, requestPlacementAtom } = createPlacementAtoms(
      factory(Layer.empty),
      Effect.succeed(collapsed),
      requestOrbPanel,
    )
    registry.set(requestPlacementAtom, 'open')
    await readResult(registry, requestPlacementAtom)
    expect(requestOrbPanel).toHaveBeenCalledExactlyOnceWith('open')
    expect(registry.get(placementAtom)).toEqual(expanded)
  })

  it('lets a later event win over an in-flight panel command', async () => {
    let finishRequest!: (placement: OrbPlacement) => void
    const { registry, factory } = setup()
    const { placementAtom, requestPlacementAtom } = createPlacementAtoms(
      factory(Layer.empty),
      Effect.succeed(collapsed),
      () => Effect.promise(() => new Promise(resolve => (finishRequest = resolve))),
    )
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
    const { registry, factory } = setup()
    const { orbTodayQuery, orbRecentQuery, loadOrbOverviewAtom } = createPanelAtoms(
      factory,
      panelQuery(factory, getOverview),
    )
    expect(registry.get(orbTodayQuery.resultAtom)._tag).toBe('Initial')
    expect(registry.get(orbRecentQuery.resultAtom)._tag).toBe('Initial')
    orbTodayQuery.pin(registry)
    orbRecentQuery.pin(registry)
    registry.set(loadOrbOverviewAtom, undefined)
    await readResult(registry, loadOrbOverviewAtom)
    expect(getOverview).toHaveBeenCalledTimes(2)
    expect(getOverview.mock.calls.map(([scope]) => scope)).toEqual([ORB_SCOPES.today, ORB_SCOPES.recent])
    expect(registry.get(orbTodayQuery.resultAtom)._tag).toBe('Success')
    expect(registry.get(orbRecentQuery.resultAtom)._tag).toBe('Success')
  })

  it('completes readiness after null results or typed failures', async () => {
    const { registry, factory } = setup()
    const getOverview = (scope: { period: string }) =>
      scope.period === 'today'
        ? Effect.succeed(null)
        : Effect.fail(new AnalyticsRpcError({ code: 'unavailable', message: 'Analytics service unavailable' }))
    const { orbTodayQuery, orbRecentQuery, loadOrbOverviewAtom, orbOverviewLoadedAtom } = createPanelAtoms(
      factory,
      panelQuery(factory, getOverview),
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
    const { registry, factory } = setup()
    const { orbTodayQuery, orbRecentQuery, loadOrbOverviewAtom } = createPanelAtoms(
      factory,
      panelQuery(factory, getOverview),
    )
    orbTodayQuery.pin(registry)
    orbRecentQuery.pin(registry)
    registry.set(loadOrbOverviewAtom, undefined)
    await readResult(registry, loadOrbOverviewAtom)
    expect(getOverview).toHaveBeenCalledTimes(2)
    const invalidate = factory(Layer.empty).fn<undefined>()(() => Reactivity.invalidate(['ledger', 'pricing']))
    registry.set(invalidate, undefined)
    await readResult(registry, invalidate)
    await vi.waitFor(() => expect(getOverview).toHaveBeenCalledTimes(4))
  })

  it('discards reset payloads and fences late in-flight scope results', async () => {
    const oldResults = new Map<string, (value: OverviewPayload | null) => void>()
    const reads = new Map<string, number>()
    const fresh = { ...payload, kpis: { ...payload.kpis, cost: 24 } }
    const stale = { ...payload, kpis: { ...payload.kpis, cost: 99 } }
    const getOverview = (scope: { period: string }) =>
      Effect.suspend(() => {
        const count = (reads.get(scope.period) ?? 0) + 1
        reads.set(scope.period, count)
        if (count === 1)
          return Effect.promise(
            () => new Promise<OverviewPayload | null>(resolve => oldResults.set(scope.period, resolve)),
          )
        return Effect.succeed(fresh)
      })
    const { registry, factory } = setup()
    const queries = createPanelAtoms(factory, panelQuery(factory, getOverview))
    const unpins = [queries.orbTodayQuery.pin(registry), queries.orbRecentQuery.pin(registry)]
    try {
      registry.set(queries.loadOrbOverviewAtom, undefined)
      const loading = readResult(registry, queries.loadOrbOverviewAtom)
      await vi.waitFor(() => expect([...reads.values()].reduce((sum, count) => sum + count, 0)).toBe(2))
      const cursor = { epoch: 'epoch-1', sequence: 0, generation: 0 }
      const reset = {
        _tag: 'Event',
        envelope: {
          epoch: 'epoch-1',
          sequence: 1,
          ledgerGeneration: 1,
          configRevision: 0,
          event: { _tag: 'LedgerReset', ledgerGeneration: 1 },
        },
      } as const
      await Effect.runPromise(
        applyPanelLifecycleFrame(reset, cursor, registry, {
          reset: owner => {
            restartRpcQuery(owner, queries.orbTodayQuery)
            restartRpcQuery(owner, queries.orbRecentQuery)
          },
        }).pipe(Effect.provide(Reactivity.layer)),
      )
      await vi.waitFor(() => expect([...reads.values()].reduce((sum, count) => sum + count, 0)).toBe(4))
      await vi.waitFor(() =>
        expect(registry.get(queries.orbTodayQuery.resultAtom)).toMatchObject({
          _tag: 'Success',
          value: { kpis: { cost: 24 } },
        }),
      )
      oldResults.get('today')?.(stale)
      oldResults.get('30days')?.(stale)
      await loading
      await vi.waitFor(() =>
        expect(registry.get(queries.orbTodayQuery.resultAtom)).toMatchObject({
          _tag: 'Success',
          value: { kpis: { cost: 24 } },
        }),
      )
    } finally {
      unpins.forEach(unpin => unpin())
    }
  })

  it('discards current payloads when a reconnect snapshot changes epoch', async () => {
    let reads = 0
    const updated = { ...payload, kpis: { ...payload.kpis, cost: 37 } }
    const getOverview = vi.fn(() => Effect.succeed(++reads <= 2 ? payload : updated))
    const { registry, factory } = setup()
    const queries = createPanelAtoms(factory, panelQuery(factory, getOverview))
    const unpins = [queries.orbTodayQuery.pin(registry), queries.orbRecentQuery.pin(registry)]
    try {
      registry.set(queries.loadOrbOverviewAtom, undefined)
      await readResult(registry, queries.loadOrbOverviewAtom)
      expect(registry.get(queries.orbTodayQuery.resultAtom)).toMatchObject({ value: { kpis: { cost: 12 } } })

      const cursor = { epoch: 'epoch-a', sequence: 8, generation: 0 }
      const reset = vi.fn(owner => {
        restartRpcQuery(owner, queries.orbTodayQuery)
        restartRpcQuery(owner, queries.orbRecentQuery)
      })
      await Effect.runPromise(
        applyPanelLifecycleFrame(
          {
            _tag: 'Snapshot',
            role: 'panel',
            state: {
              epoch: 'epoch-b',
              sequence: 0,
              hasScanned: true,
              scanActivity: { scanning: false, progress: null, error: null },
              currency: { code: 'USD', symbol: '$', rate: 1 },
              resetGeneration: 0,
            },
          },
          cursor,
          registry,
          { reset },
        ).pipe(Effect.provide(Reactivity.layer)),
      )
      expect(reset).toHaveBeenCalledExactlyOnceWith(registry)
      expect(cursor).toEqual({ epoch: 'epoch-b', sequence: 0, generation: 0 })
      await vi.waitFor(() =>
        expect(registry.get(queries.orbTodayQuery.resultAtom)).toMatchObject({
          _tag: 'Success',
          value: { kpis: { cost: 37 } },
        }),
      )
      expect(getOverview).toHaveBeenCalledTimes(4)
    } finally {
      unpins.forEach(unpin => unpin())
    }
  })

  it('admits one panel scan command and treats the global already-running result as success', async () => {
    let finishScan!: (result: { ok: boolean; alreadyRunning: boolean }) => void
    const startScan = vi.fn(() =>
      Effect.promise(() => new Promise<{ ok: boolean; alreadyRunning: boolean }>(resolve => (finishScan = resolve))),
    )
    const { registry, factory } = setup()
    const client = panelClient(factory, () => Effect.succeed(null), startScan)
    const scanRpc = client.mutation('scan:start')
    const command = createPanelScanCommandAtoms(client.runtime, get => get.setResult(scanRpc, { payload: {} }))

    registry.set(command.startScanAtom, undefined)
    const firstAdmission = readResult(registry, command.startScanAtom)
    await vi.waitFor(() => expect(startScan).toHaveBeenCalledTimes(1))
    registry.set(command.startScanAtom, undefined)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(startScan).toHaveBeenCalledExactlyOnceWith()

    finishScan({ ok: false, alreadyRunning: true })
    await firstAdmission
    expect(registry.get(command.errorAtom)).toBeNull()
    expect(registry.get(command.pendingAtom)).toBe(false)
    expect(registry.get(scanStateAtom).scanning).toBe(false)
  })

  it('reports a failed native command once and does not replay it after state changes', async () => {
    let failScan!: () => void
    const startScan = vi.fn(() =>
      Effect.callback<{ ok: boolean }, NativeRpcError>(resume => {
        failScan = () =>
          resume(Effect.fail(new NativeRpcError({ code: 'operation-failed', message: 'Native operation failed' })))
        return Effect.void
      }),
    )
    const { registry, factory } = setup()
    const client = panelClient(factory, () => Effect.succeed(null), startScan)
    const scanRpc = client.mutation('scan:start')
    const command = createPanelScanCommandAtoms(client.runtime, get => get.setResult(scanRpc, { payload: {} }))
    registry.set(command.startScanAtom, undefined)
    const pending = readResult(registry, command.startScanAtom)
    await vi.waitFor(() => expect(startScan).toHaveBeenCalledTimes(1))
    registry.set(panelEventsReadyAtom, 'failed')
    registry.set(panelEventsReadyAtom, 'ready')
    registry.set(scanStateAtom, { ...registry.get(scanStateAtom), scanning: true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(startScan).toHaveBeenCalledExactlyOnceWith()
    failScan()
    await pending

    expect(startScan).toHaveBeenCalledExactlyOnceWith()
    expect(registry.get(command.errorAtom)).toBe('Could not start a scan. Check the connection and try again.')
    expect(registry.get(scanStateAtom).scanning).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(startScan).toHaveBeenCalledExactlyOnceWith()
    expect(registry.get(command.errorAtom)).not.toBeNull()
  })
})
