import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createScopedDataStore } from '../src/renderer/src/app/stores/data-store.js'
import { useScanStore } from '../src/renderer/src/app/stores/scan-store.js'
import { useOverviewStore } from '../src/renderer/src/features/overview/store.js'
import { useSessionsStore } from '../src/renderer/src/features/sessions/store.js'
import { usePullRequestsStore } from '../src/renderer/src/features/pull-requests/store.js'
import { useSpendStore } from '../src/renderer/src/features/spend/store.js'
import { useOptimizeStore } from '../src/renderer/src/features/optimize/store.js'
import { useModelsStore } from '../src/renderer/src/features/models/store.js'
import { useCompareStore } from '../src/renderer/src/features/compare/store.js'

/** Stub the preload surface for the fetch wrappers' IPC-call sites. */
function mockWindow(api: unknown): void {
  ;(globalThis as { window?: unknown }).window = { api }
}

const statusScanned = {
  scanned: true,
  metadata: {
    scanId: 'scan-1',
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:00:01Z',
    portedFiles: 1,
    unchangedFiles: 0,
    failedFiles: 0,
    perProvider: [{ provider: 'openai', ported: 1, unchanged: 0, failed: 0, unparsed: 0 }],
    aborted: false,
  },
}

const analytics = {
  providers: [],
  models: [],
  categories: [],
  skills: [],
  subagents: [],
}

const stores = [
  useOverviewStore,
  useSessionsStore,
  usePullRequestsStore,
  useSpendStore,
  useOptimizeStore,
  useModelsStore,
  useCompareStore,
]

beforeEach(() => {
  useScanStore.setState(useScanStore.getInitialState(), true)
  for (const store of stores) store.setState(store.getInitialState(), true)
})

describe('createScopedDataStore — SWR semantics (ADR 0011)', () => {
  type Pending = { resolve: (r: { ok: true; data: { n: number } }) => void }
  const deferred = (resolvers: Pending[]) => (): Promise<{ ok: true; data: { n: number } }> =>
    new Promise(resolve => { resolvers.push({ resolve }) })

  it('loads a scope to ready', async () => {
    const useStore = createScopedDataStore<{ n: number }>(scope => Promise.resolve({ ok: true, data: { n: scope.period.length } }))
    await useStore.getState().load({ period: 'week' })
    const s = useStore.getState()
    expect(s.status).toBe('ready')
    expect(s.data).toEqual({ n: 4 })
    expect(s.dataKey).toBe(JSON.stringify({ period: 'week' }))
  })

  it('keeps last-known data while a same-scope refetch is in flight (stale-while-revalidate)', async () => {
    const resolvers: Pending[] = []
    const useSwr = createScopedDataStore<{ n: number }>(deferred(resolvers))

    const first = useSwr.getState().load({ period: 'week' })
    resolvers[0]!.resolve({ ok: true, data: { n: 1 } })
    await first
    expect(useSwr.getState().data).toEqual({ n: 1 })
    expect(useSwr.getState().status).toBe('ready')

    const second = useSwr.getState().load({ period: 'week' })
    // Same scope: the old payload must stay visible while the fetch is in flight.
    expect(useSwr.getState().data).toEqual({ n: 1 })
    expect(useSwr.getState().status).toBe('ready')
    expect(useSwr.getState().error).toBeNull()

    resolvers[1]!.resolve({ ok: true, data: { n: 2 } })
    await second
    expect(useSwr.getState().data).toEqual({ n: 2 })
  })

  it('clears to a fresh load when the scope changes', async () => {
    const resolvers: Pending[] = []
    const useStore = createScopedDataStore<{ n: number }>(deferred(resolvers))

    const first = useStore.getState().load({ period: 'week' })
    resolvers[0]!.resolve({ ok: true, data: { n: 4 } })
    await first

    const second = useStore.getState().load({ period: '30days' })
    expect(useStore.getState().data).toBeNull()
    expect(useStore.getState().status).toBe('loading')

    resolvers[1]!.resolve({ ok: true, data: { n: 6 } })
    await second
    expect(useStore.getState().data).toEqual({ n: 6 })
  })

  it('drops an out-of-order response for a superseded scope', async () => {
    const resolvers: Pending[] = []
    const useStore = createScopedDataStore<{ n: number }>(deferred(resolvers))

    const loadWeek = useStore.getState().load({ period: 'week' })
    const loadMonth = useStore.getState().load({ period: 'month' })
    resolvers[1]!.resolve({ ok: true, data: { n: 6 } })
    await loadMonth
    resolvers[0]!.resolve({ ok: true, data: { n: 4 } })
    await loadWeek

    expect(useStore.getState().data).toEqual({ n: 6 })
  })

  it('surfaces a fetch error for a scope change', async () => {
    const useStore = createScopedDataStore<{ n: number }>(() => Promise.resolve({ ok: false, error: 'nope' }))
    await useStore.getState().load({ period: 'week' })
    const s = useStore.getState()
    expect(s.status).toBe('ready')
    expect(s.error).toBe('nope')
    expect(s.data).toBeNull()
  })

  it('reload() refetches the stored scope; clear() resets', async () => {
    let calls = 0
    const useStore = createScopedDataStore<{ n: number }>(() =>
      Promise.resolve({ ok: true, data: { n: ++calls } }))
    await useStore.getState().load({ period: 'week' })
    await useStore.getState().reload()
    expect(useStore.getState().data).toEqual({ n: 2 })

    useStore.getState().clear()
    const s = useStore.getState()
    expect(s.data).toBeNull()
    expect(s.status).toBe('idle')
    expect(s.dataKey).toBe('')
  })
})

describe('feature data stores wire the frozen wire contract (ADR 0005)', () => {
  const overviewPayload = {
    kpis: {
      cost: 1, calls: 2, sessions: 3, inputTokens: 4, outputTokens: 5,
      cacheReadTokens: 6, cacheWriteTokens: 7, savingsUSD: 8, estimatedCostUSD: 9,
      oneShotRate: null, cacheHitPercent: 10,
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
      score: 80, grade: 'B', oneShotRate: null,
      retryTax: { totalUSD: 0, retries: 0, editTurns: 0, byModel: [] },
      routingWaste: { baselineModel: 'x', baselineCostPerEdit: 0, totalSavingsUSD: 0, byModel: [] },
      pricingCoverage: 1,
    },
    workflow: {
      corrections: 0, userTurns: 0, correctionRate: null, medianTimeToFirstEditMs: null,
      topReworkedFiles: [],
    },
    unpricedModels: [],
    localModelSavings: { totalUSD: 0, calls: 0, byModel: [], byProvider: [] },
  }

  it('overview store fetches via getOverview and keeps the payload on a same-scope reload', async () => {
    const getOverview = vi.fn(() => Promise.resolve(overviewPayload))
    mockWindow({ getOverview })
    await useOverviewStore.getState().load({ period: 'week', provider: 'openai' })
    expect(getOverview).toHaveBeenCalledWith({ period: 'week', provider: 'openai' })
    expect(useOverviewStore.getState().data).toEqual(overviewPayload)
    expect(useOverviewStore.getState().status).toBe('ready')

    await useOverviewStore.getState().reload()
    expect(useOverviewStore.getState().data).toEqual(overviewPayload)
    expect(getOverview).toHaveBeenCalledTimes(2)
  })

  it('sessions store loads rows by scope and detail by id', async () => {
    const getSessionRows = vi.fn(() => Promise.resolve([]))
    const getSession = vi.fn(() => Promise.resolve(null))
    mockWindow({ getSessionRows, getSession })

    await useSessionsStore.getState().load({ period: 'today' })
    expect(useSessionsStore.getState().data).toEqual([])
    expect(useSessionsStore.getState().status).toBe('ready')
    expect(getSessionRows).toHaveBeenCalledWith({ period: 'today' })

    await useSessionsStore.getState().loadSession('abc')
    expect(useSessionsStore.getState().sessionStatus).toBe('ready')
    expect(useSessionsStore.getState().session).toBeNull()
    expect(getSession).toHaveBeenCalledWith('abc')

    useSessionsStore.getState().clearSession()
    expect(useSessionsStore.getState().sessionStatus).toBe('idle')
  })

  it('pull requests store fetches via getPullRequests', async () => {
    mockWindow({ getPullRequests: () => Promise.resolve(null) })
    await usePullRequestsStore.getState().load({ period: 'all' })
    expect(usePullRequestsStore.getState().status).toBe('ready')
    expect(usePullRequestsStore.getState().data).toBeNull()
  })

  it('spend store fetches via getSpend', async () => {
    mockWindow({ getSpend: () => Promise.resolve(null) })
    await useSpendStore.getState().load({ period: 'lifetime' })
    expect(useSpendStore.getState().status).toBe('ready')
  })

  it('optimize store fetches waste and yieldData via getOptimize/getYield', async () => {
    const getOptimize = vi.fn(() => Promise.resolve(null))
    const getYield = vi.fn(() => Promise.resolve(null))
    mockWindow({ getOptimize, getYield })
    await useOptimizeStore.getState().waste.load({ period: 'today' })
    await useOptimizeStore.getState().yieldData.load({ period: 'today' })
    expect(getOptimize).toHaveBeenCalledWith({ period: 'today' })
    expect(getYield).toHaveBeenCalledWith({ period: 'today' })
  })

  it('models store fetches via getModels', async () => {
    mockWindow({ getModels: () => Promise.resolve(null) })
    await useModelsStore.getState().load({ period: '30days' })
    expect(useModelsStore.getState().status).toBe('ready')
  })

  it('compare store fetches with the pair and treats a pair change as a fresh load', async () => {
    const getCompare = vi.fn(() => Promise.resolve(null))
    mockWindow({ getCompare })

    await useCompareStore.getState().load({ period: 'today' }, { modelA: 'a', modelB: 'b' })
    expect(getCompare).toHaveBeenCalledWith({ period: 'today' }, { modelA: 'a', modelB: 'b' })
    expect(useCompareStore.getState().status).toBe('ready')

    useCompareStore.getState().load({ period: 'today' }, { modelA: 'a', modelB: 'c' })
    expect(useCompareStore.getState().data).toBeNull()
    expect(useCompareStore.getState().status).toBe('loading')
  })
})

describe('shared refresh tick (ADR 0011)', () => {
  it('reloads every loaded data store when a change completes', async () => {
    const getOverview = vi.fn(() => Promise.resolve(null))
    mockWindow({
      getScanStatus: () => Promise.resolve(statusScanned),
      getAnalytics: () => Promise.resolve(analytics),
      getOverview,
    })

    await useOverviewStore.getState().load({ period: 'week' })
    expect(getOverview).toHaveBeenCalledTimes(1)

    await useScanStore.getState().applyChange()

    expect(getOverview).toHaveBeenCalledTimes(2)
    expect(useOverviewStore.getState().status).toBe('ready')
  })

  it('does not spuriously fetch a store that has never been loaded', async () => {
    const getSpend = vi.fn(() => Promise.resolve(null))
    mockWindow({
      getScanStatus: () => Promise.resolve(statusScanned),
      getAnalytics: () => Promise.resolve(analytics),
      getSpend,
    })
    await useScanStore.getState().applyChange()
    expect(getSpend).not.toHaveBeenCalled()
  })

  it('optimize store refetches both slices (waste + yieldData) on a change', async () => {
    const getOptimize = vi.fn(() => Promise.resolve(null))
    const getYield = vi.fn(() => Promise.resolve(null))
    mockWindow({
      getScanStatus: () => Promise.resolve(statusScanned),
      getAnalytics: () => Promise.resolve(analytics),
      getOptimize,
      getYield,
    })

    await useOptimizeStore.getState().waste.load({ period: 'week' })
    await useOptimizeStore.getState().yieldData.load({ period: 'week' })
    expect(getOptimize).toHaveBeenCalledTimes(1)
    expect(getYield).toHaveBeenCalledTimes(1)

    await useScanStore.getState().applyChange()
    expect(getOptimize).toHaveBeenCalledTimes(2)
    expect(getYield).toHaveBeenCalledTimes(2)
  })
})
