import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useCompareStore } from '../src/renderer/src/features/compare/store.js'
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

beforeEach(() => {
  useCompareStore.setState(useCompareStore.getInitialState(), true)
  vi.unstubAllGlobals()
})

describe('Compare default pair', () => {
  it('accepts the server-selected pair and reloads with it after one default fetch', async () => {
    const getCompare = vi.fn(async () => defaultPayload)
    stubCompare(getCompare)
    const scope = { period: 'week' } satisfies OverviewScope

    await useCompareStore.getState().load(scope)

    expect(getCompare).toHaveBeenCalledTimes(1)
    expect(getCompare).toHaveBeenNthCalledWith(1, scope, undefined)
    expect(useCompareStore.getState().pair).toEqual({ modelA: 'model-a', modelB: 'model-b' })
    expect(useCompareStore.getState().data).toEqual(defaultPayload)

    await useCompareStore.getState().reload()

    expect(getCompare).toHaveBeenCalledTimes(2)
    expect(getCompare).toHaveBeenNthCalledWith(2, scope, { modelA: 'model-a', modelB: 'model-b' })
  })

  it('keeps explicitly requested pairs across pair changes and server fallback reports', async () => {
    const getCompare = vi.fn(async () => defaultPayload)
    stubCompare(getCompare)
    const scope = { period: 'lifetime' } satisfies OverviewScope
    const firstPair = { modelA: 'missing-model', modelB: 'model-b' }
    const nextPair = { modelA: 'model-b', modelB: 'model-a' }

    await useCompareStore.getState().load(scope, firstPair)
    expect(useCompareStore.getState().pair).toEqual(firstPair)
    expect(useCompareStore.getState().data?.report?.modelA.model).toBe('model-a')

    await useCompareStore.getState().load(scope, nextPair)

    expect(getCompare).toHaveBeenNthCalledWith(1, scope, firstPair)
    expect(getCompare).toHaveBeenNthCalledWith(2, scope, nextPair)
    expect(useCompareStore.getState().pair).toEqual(nextPair)
  })

  it('does not invent a pair for null payloads or fetch errors', async () => {
    const getCompare = vi.fn().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('IPC unavailable'))
    stubCompare(getCompare)
    const scope = { period: 'today' } satisfies OverviewScope

    await useCompareStore.getState().load(scope)
    expect(useCompareStore.getState().pair).toBeUndefined()
    expect(useCompareStore.getState().data).toBeNull()

    await useCompareStore.getState().load(scope)
    expect(useCompareStore.getState().pair).toBeUndefined()
    expect(useCompareStore.getState().error).toBe('IPC unavailable')
  })

  it('does not promote an outdated default response after the scope changes', async () => {
    const requests: Array<{ resolve: (payload: ComparePayload) => void }> = []
    stubCompare(
      () =>
        new Promise(resolve => {
          requests.push({ resolve })
        }),
    )
    const oldLoad = useCompareStore.getState().load({ period: 'week' })
    const currentScope = { period: 'today' } satisfies OverviewScope
    const currentLoad = useCompareStore.getState().load(currentScope)

    const currentRequest = requests.at(1)
    expect(currentRequest).toBeDefined()
    currentRequest?.resolve(alternatePayload)
    await currentLoad
    const outdatedRequest = requests.at(0)
    expect(outdatedRequest).toBeDefined()
    outdatedRequest?.resolve(defaultPayload)
    await oldLoad

    expect(useCompareStore.getState().scope).toEqual(currentScope)
    expect(useCompareStore.getState().pair).toEqual({ modelA: 'model-b', modelB: 'model-a' })
    expect(useCompareStore.getState().data).toEqual(alternatePayload)
  })
})
