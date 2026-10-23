import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import * as Reactivity from 'effect/reactivity/Reactivity'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { configInvalidationRevisionAtom } from '../src/renderer/src/app/atoms/config-change.js'
import { pinWindowAtom, releaseWindowQueries } from '../src/renderer/src/app/hooks/use-remote-query.js'
import {
  createPricingAtoms,
  createPricingCommandFamily,
  KNOWN_MODELS_REQUEST,
  PRICING_REQUEST,
} from '../src/renderer/src/features/models/pricing-atoms.js'
import { legacyRendererApi, RendererApi, RendererApiError } from '../src/renderer/src/shared/lib/renderer-api.js'

const registries: AtomRegistry.AtomRegistry[] = []
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose()
})

type ApiOverrides = Partial<RendererApi['Service']>

function setup(overrides: ApiOverrides = {}) {
  const factory = Atom.context()
  const registry = AtomRegistry.make()
  registries.push(registry)
  const service = { ...legacyRendererApi, ...overrides }
  const layer = Layer.succeed(RendererApi, service)
  const eventAtom = factory(layer).fn<undefined>()((_, get) =>
    Effect.gen(function* () {
      yield* Reactivity.invalidate(['ledger', 'pricing'])
      get.registry.set(configInvalidationRevisionAtom, get.registry.get(configInvalidationRevisionAtom) + 1)
    }),
  )
  return { factory, registry, atoms: createPricingAtoms(factory, layer), eventAtom, layer }
}

async function dispatch<Arg, A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.AtomResultFn<Arg, A, E>,
  input: Arg,
): Promise<A> {
  return new Promise((resolve, reject) => {
    let unsubscribe: () => void = () => undefined
    unsubscribe = registry.subscribe(atom, result => {
      if (result.waiting || result._tag === 'Initial') return
      unsubscribe()
      if (result._tag === 'Success') resolve(result.value)
      else reject(result)
    })
    registry.set(atom, input)
  })
}

async function waitForSuccess<A>(registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<unknown>): Promise<A> {
  await vi.waitFor(() => expect(registry.get(atom)).toMatchObject({ _tag: 'Success', waiting: false }))
  return (registry.get(atom) as { value: A }).value
}

describe('pricing atoms', () => {
  it('loads aliases, overrides and lifetime models through the injected RendererApi', async () => {
    const alias = { model: 'foo', aliasOf: 'bar' }
    const override = { model: 'baz', inputPricePerMillion: 1, outputPricePerMillion: 2 }
    const priced = {
      provider: 'openai',
      model: 'p',
      modelDisplayName: 'P',
      category: null,
      inputTokens: 100,
      outputTokens: 100,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 200,
      costUSD: 1,
      savingsUSD: 0,
      savingsBaselineModel: '',
      calls: 1,
    }
    const unpriced = { ...priced, model: 'u', costUSD: 0 }
    const savings = { ...priced, model: 's', costUSD: 0, savingsUSD: 1 }
    const getModels = vi.fn((request: unknown) => {
      expect(request).toEqual(KNOWN_MODELS_REQUEST)
      return Effect.succeed({ byModel: [priced, unpriced, savings], byTask: [], audit: [] })
    })
    const { atoms, registry } = setup({
      getModelAliases: () => Effect.succeed([alias]),
      getPriceOverrides: () => Effect.succeed([override]),
      getModels,
    })

    registry.set(atoms.aliasesQuery.requestAtom, PRICING_REQUEST)
    registry.set(atoms.overridesQuery.requestAtom, PRICING_REQUEST)
    registry.set(atoms.knownModelsQuery.requestAtom, KNOWN_MODELS_REQUEST)
    const unpins = [
      atoms.aliasesQuery.pin(registry),
      atoms.overridesQuery.pin(registry),
      atoms.knownModelsQuery.pin(registry),
    ]
    try {
      await Promise.all([
        waitForSuccess(registry, atoms.aliasesQuery.resultAtom),
        waitForSuccess(registry, atoms.overridesQuery.resultAtom),
        waitForSuccess(registry, atoms.knownModelsQuery.resultAtom),
      ])
      expect(registry.get(atoms.aliasesQuery.resultAtom)).toMatchObject({ value: [alias] })
      expect(registry.get(atoms.overridesQuery.resultAtom)).toMatchObject({ value: [override] })
      expect(registry.get(atoms.knownModelsAtom)).toEqual([priced, unpriced, savings])
      expect(registry.get(atoms.unpricedModelsAtom)).toEqual([unpriced])
      expect(registry.get(atoms.pricedModelsAtom)).toEqual([priced])
      expect(getModels).toHaveBeenCalledTimes(1)
    } finally {
      unpins.forEach(unpin => unpin())
    }
  })

  it('keeps unopened pricing queries lazy and refreshes loaded lists on pricing invalidation', async () => {
    const getAliases = vi.fn(() => Effect.succeed([]))
    const getOverrides = vi.fn(() => Effect.succeed([]))
    const getModels = vi.fn(() => Effect.succeed({ byModel: [], byTask: [], audit: [] }))
    const { factory, atoms, registry } = setup({
      getModelAliases: getAliases,
      getPriceOverrides: getOverrides,
      getModels,
    })
    expect(getAliases).not.toHaveBeenCalled()
    expect(getOverrides).not.toHaveBeenCalled()
    expect(getModels).not.toHaveBeenCalled()

    registry.set(atoms.aliasesQuery.requestAtom, PRICING_REQUEST)
    const unpin = atoms.aliasesQuery.pin(registry)
    await waitForSuccess(registry, atoms.aliasesQuery.resultAtom)
    const invalidate = factory(RendererApi.layer).fn(() => Reactivity.invalidate(['pricing']))
    await dispatch(registry, invalidate, undefined)
    await vi.waitFor(() => expect(getAliases).toHaveBeenCalledTimes(2))
    expect(getOverrides).not.toHaveBeenCalled()
    expect(getModels).not.toHaveBeenCalled()
    unpin()
  })

  it('dispatches all config writes and clears their individual error state', async () => {
    const addModelAlias = vi.fn(() => Effect.succeed({ ok: true as const }))
    const removeModelAlias = vi.fn(() => Effect.succeed({ ok: true as const }))
    const setModelPrice = vi.fn(() => Effect.succeed({ ok: true as const }))
    const removePriceOverride = vi.fn(() => Effect.succeed({ ok: true as const }))
    const { atoms, registry, eventAtom } = setup({
      addModelAlias,
      removeModelAlias,
      setModelPrice,
      removePriceOverride,
    })
    registry.set(atoms.commandErrorsAtom, {
      addAlias: 'old',
      removeAlias: 'old',
      setOverride: 'old',
      removeOverride: 'old',
    })

    const finishWrite = async <Arg, A, E>(
      atom: Atom.AtomResultFn<Arg, A, E>,
      input: Arg,
      called: ReturnType<typeof vi.fn>,
    ) => {
      const pending = dispatch(registry, atom, input)
      await vi.waitFor(() => expect(called).toHaveBeenCalledTimes(1))
      await dispatch(registry, eventAtom, undefined)
      await pending
    }

    await finishWrite(atoms.addAliasAtom, { model: 'raw', aliasOf: 'target' }, addModelAlias)
    await finishWrite(atoms.removeAliasAtom, 'raw', removeModelAlias)
    await finishWrite(
      atoms.setOverrideAtom,
      {
        model: 'raw',
        inputPricePerMillion: 1,
        outputPricePerMillion: 2,
      },
      setModelPrice,
    )
    await finishWrite(atoms.removeOverrideAtom, 'raw', removePriceOverride)

    expect(addModelAlias).toHaveBeenCalledWith('raw', 'target')
    expect(removeModelAlias).toHaveBeenCalledWith('raw')
    expect(setModelPrice).toHaveBeenCalledWith('raw', 1, 2)
    expect(removePriceOverride).toHaveBeenCalledWith('raw')
    expect(registry.get(atoms.commandErrorsAtom)).toEqual({
      addAlias: null,
      removeAlias: null,
      setOverride: null,
      removeOverride: null,
    })
  })

  it('surfaces write failure without invalidating queries', async () => {
    const failure = new RendererApiError({ operation: 'models:addAlias', message: 'offline' })
    const getAliases = vi.fn(() => Effect.succeed([]))
    const { atoms, registry } = setup({
      addModelAlias: () => Effect.fail(failure),
      getModelAliases: getAliases,
    })
    const result = await dispatch(registry, atoms.addAliasAtom, { model: 'raw', aliasOf: 'target' })
    expect(result).toEqual({ ok: false, message: 'offline' })
    expect(registry.get(atoms.commandErrorsAtom).addAlias).toBe('offline')
    expect(getAliases).not.toHaveBeenCalled()
  })

  it('admits two alias writes without cancelling either command', async () => {
    const addModelAlias = vi.fn((model: string) =>
      model === 'two'
        ? Effect.fail(new RendererApiError({ operation: 'models:addAlias', message: 'second write failed' }))
        : Effect.succeed({ ok: true as const }),
    )
    const { factory, registry, eventAtom, layer } = setup({ addModelAlias })
    const firstCommands = createPricingCommandFamily(factory, layer)
    const secondCommands = createPricingCommandFamily(factory, layer)
    pinWindowAtom(registry, firstCommands.addAliasAtom)
    let unsubscribeFirst: () => void = () => undefined
    unsubscribeFirst = registry.subscribe(firstCommands.addAliasAtom, result => {
      if (result.waiting || result._tag === 'Initial') return
    })
    registry.set(firstCommands.addAliasAtom, { model: 'one', aliasOf: 'priced' })
    await vi.waitFor(() => expect(addModelAlias).toHaveBeenCalledTimes(1))
    unsubscribeFirst()
    const second = dispatch(registry, secondCommands.addAliasAtom, { model: 'two', aliasOf: 'priced' })
    await dispatch(registry, eventAtom, undefined)
    await vi.waitFor(() => expect(addModelAlias).toHaveBeenCalledTimes(2))
    await expect(second).resolves.toEqual({ ok: false, message: 'second write failed' })
    expect(registry.get(firstCommands.addAliasAtom)).toMatchObject({ _tag: 'Success', value: { ok: true } })
    releaseWindowQueries(registry)
    expect(addModelAlias).toHaveBeenNthCalledWith(1, 'one', 'priced')
    expect(addModelAlias).toHaveBeenNthCalledWith(2, 'two', 'priced')
  })

  it('waits for the config event and activated query refresh after the write is acknowledged', async () => {
    let finishRefresh: (() => void) | undefined
    const getAliases = vi
      .fn()
      .mockReturnValueOnce(Effect.succeed([]))
      .mockImplementationOnce(() =>
        Effect.promise(
          () => new Promise(resolve => (finishRefresh = () => resolve([{ model: 'raw', aliasOf: 'priced' }]))),
        ),
      )
    const addModelAlias = vi.fn(() => Effect.succeed({ ok: true as const }))
    const { atoms, registry, eventAtom } = setup({ addModelAlias, getModelAliases: getAliases })
    registry.set(atoms.aliasesQuery.requestAtom, PRICING_REQUEST)
    const unpin = atoms.aliasesQuery.pin(registry)
    try {
      await waitForSuccess(registry, atoms.aliasesQuery.resultAtom)
      let settled = false
      const write = dispatch(registry, atoms.addAliasAtom, { model: 'raw', aliasOf: 'priced' }).then(value => {
        settled = true
        return value
      })
      await vi.waitFor(() => expect(addModelAlias).toHaveBeenCalledTimes(1))
      await Promise.resolve()
      expect(settled).toBe(false)

      await dispatch(registry, eventAtom, undefined)
      await vi.waitFor(() => expect(getAliases).toHaveBeenCalledTimes(2))
      expect(settled).toBe(false)
      finishRefresh?.()
      await expect(write).resolves.toEqual({ ok: true })
      expect(registry.get(atoms.aliasesQuery.resultAtom)).toMatchObject({
        _tag: 'Success',
        value: [{ model: 'raw', aliasOf: 'priced' }],
      })
    } finally {
      unpin()
    }
  })

  it('keeps a committed write successful when its event-triggered query refresh fails', async () => {
    const refreshFailure = new RendererApiError({ operation: 'models:getAliases', message: 'refresh failed' })
    const getAliases = vi.fn().mockReturnValueOnce(Effect.succeed([])).mockReturnValueOnce(Effect.fail(refreshFailure))
    const { atoms, registry, eventAtom } = setup({
      addModelAlias: () => Effect.succeed({ ok: true as const }),
      getModelAliases: getAliases,
    })
    registry.set(atoms.aliasesQuery.requestAtom, PRICING_REQUEST)
    const unpin = atoms.aliasesQuery.pin(registry)
    try {
      await waitForSuccess(registry, atoms.aliasesQuery.resultAtom)
      const write = dispatch(registry, atoms.addAliasAtom, { model: 'raw', aliasOf: 'priced' })
      await vi.waitFor(() => expect(getAliases).toHaveBeenCalledTimes(1))
      await dispatch(registry, eventAtom, undefined)
      await expect(write).resolves.toEqual({ ok: true })
      expect(registry.get(atoms.aliasesQuery.resultAtom)).toMatchObject({ _tag: 'Failure' })
      expect(registry.get(atoms.commandErrorsAtom).addAlias).toBeNull()
    } finally {
      unpin()
    }
  })
})
