import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { restartRpcQuery } from '../src/renderer/src/app/atoms/rpc-query.js'
import { createCompareAtoms, createCompareQuery, pairFromPayload } from '../src/renderer/src/features/compare/atoms.js'
import type { ComparePair, ComparePayload } from '../src/shared/schemas/compare.js'
import type { OverviewScope } from '../src/shared/schemas/overview.js'
import { makeAnalyticsRpcTestClient } from './analytics-rpc-test-helper.js'

const modelA = {
  model: 'model-a',
  displayName: 'Model A',
  calls: 1,
  costUSD: 2,
  outputTokens: 3,
  inputTokens: 4,
  cacheReadTokens: 5,
  totalTurns: 6,
  editTurns: 7,
  oneShotTurns: 8,
  retries: 9,
}

const modelB = { ...modelA, model: 'model-b', displayName: 'Model B' }

const defaultPayload: ComparePayload = {
  models: [modelA, modelB],
  report: { modelA, modelB, metrics: [], categories: [], workingStyle: [] },
}

const alternatePayload: ComparePayload = {
  models: [modelB, modelA],
  report: { modelA: modelB, modelB: modelA, metrics: [], categories: [], workingStyle: [] },
}

const registries: AtomRegistry.AtomRegistry[] = []
function setup(compare?: (scope: OverviewScope, pair?: ComparePair) => Promise<ComparePayload | null>) {
  const registry = AtomRegistry.make()
  registries.push(registry)
  const runtime = Atom.context()
  const client = makeAnalyticsRpcTestClient(runtime, { compare })
  const query = createCompareQuery(client.runtime, (scope, pair) =>
    Effect.flatMap(client, service => service('compare:view', pair === undefined ? { scope } : { scope, pair })),
  )
  const { compareQuery } = createCompareAtoms(query)
  return { registry, compareQuery }
}

afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose()
})

async function settle(
  registry: AtomRegistry.AtomRegistry,
  query: ReturnType<typeof createCompareAtoms>['compareQuery'],
) {
  await vi.waitFor(() => {
    const result = registry.get(query.resultAtom)
    expect(result._tag).not.toBe('Initial')
    expect(result.waiting).toBe(false)
  })
}

describe('native Compare query pair selection', () => {
  it('uses the server-selected pair for a same-selection refresh', async () => {
    const compare = vi.fn(async () => defaultPayload)
    const { registry, compareQuery } = setup(compare)
    const scope = { period: 'week' } satisfies OverviewScope
    registry.set(compareQuery.requestAtom, { scope })
    const unpin = compareQuery.pin(registry)
    await settle(registry, compareQuery)
    expect(compare).toHaveBeenCalledExactlyOnceWith(scope, undefined)
    expect(pairFromPayload(AsyncResult.getOrThrow(registry.get(compareQuery.resultAtom)))).toEqual({
      modelA: 'model-a',
      modelB: 'model-b',
    })

    unpin()
    compareQuery.pin(registry)
    registry.set(compareQuery.refreshAtom, undefined)
    await vi.waitFor(() => expect(compare).toHaveBeenCalledTimes(2))
    await settle(registry, compareQuery)
    expect(compare).toHaveBeenNthCalledWith(2, scope, { modelA: 'model-a', modelB: 'model-b' })
  })

  it('preserves explicit ordered pairs and gives A/B/A fresh selections', async () => {
    const requests: Array<{
      scope: OverviewScope
      pair: ComparePair | undefined
      resolve: (payload: ComparePayload) => void
    }> = []
    const compare = vi.fn(
      (scope: OverviewScope, pair?: ComparePair) =>
        new Promise<ComparePayload>(resolve => requests.push({ scope, pair, resolve })),
    )
    const { registry, compareQuery } = setup(compare)
    const scope = { period: 'lifetime' } satisfies OverviewScope
    const pairA = { modelA: 'model-a', modelB: 'model-b' }
    const pairB = { modelA: 'model-b', modelB: 'model-a' }
    const unpin = compareQuery.pin(registry)

    registry.set(compareQuery.requestAtom, { scope, pair: pairA })
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    requests[0]?.resolve(defaultPayload)
    await settle(registry, compareQuery)

    registry.set(compareQuery.requestAtom, { scope, pair: pairB })
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    registry.set(compareQuery.requestAtom, { scope, pair: pairA })
    await vi.waitFor(() => expect(requests).toHaveLength(3))
    requests[1]?.resolve(alternatePayload)
    expect(registry.get(compareQuery.resultAtom)._tag).toBe('Initial')
    requests[2]?.resolve(defaultPayload)
    await settle(registry, compareQuery)
    expect(requests.map(({ pair }) => pair)).toEqual([pairA, pairB, pairA])
    expect(pairFromPayload(AsyncResult.getOrThrow(registry.get(compareQuery.resultAtom)))).toEqual(pairA)

    unpin()
    registry.dispose()
  })

  it('reuses the selected server pair for refresh and retains SWR data on RPC failure', async () => {
    let calls = 0
    const compare = vi.fn(() => {
      calls += 1
      return calls === 1 ? Promise.resolve(defaultPayload) : Promise.reject(new Error('unavailable'))
    })
    const { registry, compareQuery } = setup(compare)
    const scope = { period: 'today' } satisfies OverviewScope
    registry.set(compareQuery.requestAtom, { scope })
    compareQuery.pin(registry)
    await settle(registry, compareQuery)

    registry.set(compareQuery.refreshAtom, undefined)
    await vi.waitFor(() => expect(registry.get(compareQuery.resultAtom)._tag).toBe('Failure'))
    const result = registry.get(compareQuery.resultAtom)
    expect(compare).toHaveBeenNthCalledWith(1, scope, undefined)
    expect(compare).toHaveBeenNthCalledWith(2, scope, { modelA: 'model-a', modelB: 'model-b' })
    expect(AsyncResult.isFailure(result)).toBe(true)
    if (AsyncResult.isFailure(result)) {
      expect(Option.getOrThrow(result.previousSuccess).value).toEqual(defaultPayload)
      expect(String(result.cause)).toContain('AnalyticsRpcError')
    }
    expect(registry.get(compareQuery.requestAtom)?.pair).toBeUndefined()
  })

  it('discards the prior scope default and reset starts a fresh server-selected request', async () => {
    const requests: Array<{
      scope: OverviewScope
      pair: ComparePair | undefined
      resolve: (payload: ComparePayload) => void
    }> = []
    const compare = vi.fn(
      (scope: OverviewScope, pair?: ComparePair) =>
        new Promise<ComparePayload>(resolve => requests.push({ scope, pair, resolve })),
    )
    const { registry, compareQuery } = setup(compare)
    const firstScope = { period: 'week' } satisfies OverviewScope
    const nextScope = { period: 'today' } satisfies OverviewScope
    registry.set(compareQuery.requestAtom, { scope: firstScope })
    compareQuery.pin(registry)
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    requests[0]?.resolve(defaultPayload)
    await settle(registry, compareQuery)

    registry.set(compareQuery.requestAtom, { scope: nextScope })
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    expect(requests.map(({ pair }) => pair)).toEqual([undefined, undefined])
    requests[1]?.resolve(alternatePayload)
    await settle(registry, compareQuery)
    expect(pairFromPayload(AsyncResult.getOrThrow(registry.get(compareQuery.resultAtom)))).toEqual({
      modelA: 'model-b',
      modelB: 'model-a',
    })

    restartRpcQuery(registry, compareQuery)
    await vi.waitFor(() => expect(requests).toHaveLength(3))
    expect(requests[2]?.scope).toEqual(nextScope)
    expect(requests[2]?.pair).toBeUndefined()
    requests[2]?.resolve(defaultPayload)
    await settle(registry, compareQuery)
  })

  it('does not invent a pair for null payloads or failed first requests', async () => {
    const compare = vi.fn().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('unavailable'))
    const { registry, compareQuery } = setup(compare)
    const scope = { period: 'today' } satisfies OverviewScope
    registry.set(compareQuery.requestAtom, { scope })
    compareQuery.pin(registry)
    await settle(registry, compareQuery)
    expect(pairFromPayload(AsyncResult.getOrThrow(registry.get(compareQuery.resultAtom)))).toBeUndefined()
    registry.set(compareQuery.refreshAtom, undefined)
    await vi.waitFor(() => expect(registry.get(compareQuery.resultAtom)._tag).toBe('Failure'))
    expect(compare).toHaveBeenNthCalledWith(1, scope, undefined)
    expect(compare).toHaveBeenNthCalledWith(2, scope, undefined)
    expect(registry.get(compareQuery.requestAtom)?.pair).toBeUndefined()
  })
})
