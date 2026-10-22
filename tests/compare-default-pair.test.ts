import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createCompareAtoms, pairFromPayload } from '../src/renderer/src/features/compare/atoms.js'
import type { ComparePair, ComparePayload } from '../src/shared/schemas/compare.js'
import type { OverviewScope } from '../src/shared/schemas/overview.js'

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

function stubCompare(getCompare: (scope: OverviewScope, pair?: ComparePair) => Promise<ComparePayload | null>): void {
  vi.stubGlobal('window', { api: { getCompare: vi.fn(getCompare) } })
}

const registries: AtomRegistry.AtomRegistry[] = []
function setup() {
  const registry = AtomRegistry.make()
  registries.push(registry)
  const { compareQuery } = createCompareAtoms(Atom.context())
  compareQuery.pin(registry)
  return { registry, compareQuery }
}
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose()
  vi.unstubAllGlobals()
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

describe('Compare default pair', () => {
  it('accepts the server-selected pair and refreshes with it after one default fetch', async () => {
    const getCompare = vi.fn(async () => defaultPayload)
    stubCompare(getCompare)
    const { registry, compareQuery } = setup()
    const scope = { period: 'week' } satisfies OverviewScope
    registry.set(compareQuery.requestAtom, { scope })
    await settle(registry, compareQuery)
    expect(getCompare).toHaveBeenCalledExactlyOnceWith(scope, undefined)
    expect(pairFromPayload(AsyncResult.getOrThrow(registry.get(compareQuery.resultAtom)))).toEqual({
      modelA: 'model-a',
      modelB: 'model-b',
    })
    registry.set(compareQuery.refreshAtom, undefined)
    await vi.waitFor(() => expect(getCompare).toHaveBeenCalledTimes(2))
    await settle(registry, compareQuery)
    expect(getCompare).toHaveBeenNthCalledWith(2, scope, { modelA: 'model-a', modelB: 'model-b' })
  })

  it('keeps explicit pairs across pair changes and server fallback reports', async () => {
    const getCompare = vi.fn(async () => defaultPayload)
    stubCompare(getCompare)
    const { registry, compareQuery } = setup()
    const scope = { period: 'lifetime' } satisfies OverviewScope
    const firstPair = { modelA: 'missing-model', modelB: 'model-b' }
    const nextPair = { modelA: 'model-b', modelB: 'model-a' }
    registry.set(compareQuery.requestAtom, { scope, pair: firstPair })
    await settle(registry, compareQuery)
    expect(registry.get(compareQuery.requestAtom)?.pair).toEqual(firstPair)
    registry.set(compareQuery.requestAtom, { scope, pair: nextPair })
    expect(registry.get(compareQuery.resultAtom)._tag).toBe('Initial')
    await settle(registry, compareQuery)
    expect(getCompare).toHaveBeenNthCalledWith(1, scope, firstPair)
    expect(getCompare).toHaveBeenNthCalledWith(2, scope, nextPair)
    expect(registry.get(compareQuery.requestAtom)?.pair).toEqual(nextPair)
  })

  it('does not invent a pair for null payloads or fetch errors', async () => {
    const getCompare = vi.fn().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('IPC unavailable'))
    stubCompare(getCompare)
    const { registry, compareQuery } = setup()
    registry.set(compareQuery.requestAtom, { scope: { period: 'today' } })
    await settle(registry, compareQuery)
    expect(pairFromPayload(AsyncResult.getOrThrow(registry.get(compareQuery.resultAtom)))).toBeUndefined()
    registry.set(compareQuery.refreshAtom, undefined)
    await vi.waitFor(() => expect(registry.get(compareQuery.resultAtom)._tag).toBe('Failure'))
    expect(registry.get(compareQuery.requestAtom)?.pair).toBeUndefined()
  })

  it('does not promote an outdated default response after the scope changes', async () => {
    const requests: Array<{ resolve: (payload: ComparePayload) => void }> = []
    stubCompare(() => new Promise(resolve => requests.push({ resolve })))
    const { registry, compareQuery } = setup()
    registry.set(compareQuery.requestAtom, { scope: { period: 'week' } })
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    const currentScope = { period: 'today' } satisfies OverviewScope
    registry.set(compareQuery.requestAtom, { scope: currentScope })
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    requests[1]?.resolve(alternatePayload)
    await settle(registry, compareQuery)
    requests[0]?.resolve(defaultPayload)
    await Promise.resolve()
    const payload = AsyncResult.getOrThrow(registry.get(compareQuery.resultAtom))
    expect(registry.get(compareQuery.requestAtom)?.scope).toEqual(currentScope)
    expect(pairFromPayload(payload)).toEqual({ modelA: 'model-b', modelB: 'model-a' })
    expect(payload).toEqual(alternatePayload)
  })
})
