import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import * as AtomRpc from 'effect/reactivity/AtomRpc'
import * as Reactivity from 'effect/reactivity/Reactivity'
import * as RpcTest from 'effect/rpc/RpcTest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RpcDataWorker } from '../src/main/rpc/handlers.js'
import { analyticsHandlers, configHandlers } from '../src/main/rpc/handlers.js'
import { lifecycleHandlers, lifecycleLayer } from '../src/main/rpc/lifecycle.js'
import { configInvalidationRevisionAtom } from '../src/renderer/src/app/atoms/config-change.js'
import { querySnapshot } from '../src/renderer/src/app/hooks/use-remote-query.js'
import {
  createPricingAtoms,
  createPricingCommandFamily,
  KNOWN_MODELS_REQUEST,
  PRICING_REQUEST,
} from '../src/renderer/src/features/models/pricing-atoms.js'
import { ApplicationRpcGroup } from '../src/shared/rpc/application.js'
import type { ModelReportRow, ModelsPayload } from '../src/shared/schemas/models.js'

const registries: AtomRegistry.AtomRegistry[] = []
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose()
})

interface PricingSetupOptions {
  readonly request: RpcDataWorker['request']
  readonly configRevision?: () => number
}

function setup(options: PricingSetupOptions) {
  const factory = Atom.context()
  const lifecycle = lifecycleLayer({
    epoch: 'pricing-test',
    readSnapshot: {
      scanStatus: () => Effect.succeed(undefined),
      scanActivity: () => Effect.succeed(undefined),
      currency: () => Effect.succeed(undefined),
      updater: () => Effect.succeed(undefined),
      harnesses: () => Effect.succeed(undefined),
    },
  })
  const handlers = Layer.mergeAll(
    analyticsHandlers({ request: options.request }),
    configHandlers({ request: options.request }, Effect.sync(options.configRevision ?? (() => 0))),
    lifecycleHandlers.pipe(Layer.provide(lifecycle)),
  )
  const client = AtomRpc.Service<object>()('test/PricingRpc', {
    group: ApplicationRpcGroup,
    protocol: Layer.empty,
    runtime: factory,
    makeEffect: RpcTest.makeClient(ApplicationRpcGroup, { flatten: true }).pipe(Effect.provide(handlers)),
  })
  const atoms = createPricingAtoms(client)
  registries.push(AtomRegistry.make())
  const registry = registries[registries.length - 1]
  if (!registry) throw new Error('Pricing test registry was not created')
  const configEventAtom = client.runtime.fn<number>()((revision, get) =>
    Effect.gen(function* () {
      yield* Reactivity.invalidate(['ledger', 'pricing'])
      get.registry.set(configInvalidationRevisionAtom, revision)
    }),
  )
  return { client, atoms, registry, configEventAtom, factory }
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
  it('loads aliases, overrides and lifetime models through native AtomRpc queries', async () => {
    const alias = { model: 'foo', aliasOf: 'bar' }
    const override = { model: 'baz', inputPricePerMillion: 1, outputPricePerMillion: 2 }
    const priced: ModelReportRow = {
      provider: 'openai',
      model: 'priced',
      modelDisplayName: 'Priced',
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
    const unpriced: ModelReportRow = { ...priced, model: 'unpriced', costUSD: 0 }
    const savings: ModelReportRow = { ...priced, model: 'savings', costUSD: 0, savingsUSD: 1 }
    const getModels = vi.fn(() =>
      Promise.resolve<ModelsPayload>({ byModel: [priced, unpriced, savings], byTask: [], audit: [] }),
    )
    const request = vi.fn((operation: string) => {
      if (operation === 'models:getAliases') return Promise.resolve([alias])
      if (operation === 'models:getPriceOverrides') return Promise.resolve([override])
      if (operation === 'models:view') return getModels()
      return Promise.resolve({ ok: true })
    })
    const { atoms, registry } = setup({ request })

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
      expect(request.mock.calls.map(([operation]) => operation).sort()).toEqual([
        'models:getAliases',
        'models:getPriceOverrides',
        'models:view',
      ])
      expect(request).toHaveBeenCalledWith('models:view', { period: 'lifetime' })

      getModels.mockRejectedValueOnce(new Error('refresh failed'))
      registry.set(atoms.knownModelsQuery.refreshAtom, undefined)
      await vi.waitFor(() =>
        expect(registry.get(atoms.knownModelsQuery.resultAtom)).toMatchObject({ _tag: 'Failure', waiting: false }),
      )
      expect(registry.get(atoms.knownModelsAtom)).toEqual([priced, unpriced, savings])
      expect(registry.get(atoms.unpricedModelsAtom)).toEqual([unpriced])
      expect(registry.get(atoms.pricedModelsAtom)).toEqual([priced])
      expect(querySnapshot(registry.get(atoms.knownModelsQuery.resultAtom))).toMatchObject({
        data: { byModel: [priced, unpriced, savings] },
        error: expect.any(String),
      })
    } finally {
      unpins.forEach(unpin => unpin())
    }
  })

  it('keeps unopened queries lazy and invalidates only active pricing queries', async () => {
    const getAliases = vi.fn(() => Promise.resolve([]))
    const getOverrides = vi.fn(() => Promise.resolve([]))
    const getModels = vi.fn(() => Promise.resolve(null))
    const { client, atoms, registry } = setup({
      request: operation => {
        if (operation === 'models:getAliases') return getAliases()
        if (operation === 'models:getPriceOverrides') return getOverrides()
        if (operation === 'models:view') return getModels()
        return Promise.resolve({ ok: true })
      },
    })
    expect(getAliases).not.toHaveBeenCalled()
    expect(getOverrides).not.toHaveBeenCalled()
    expect(getModels).not.toHaveBeenCalled()

    registry.set(atoms.aliasesQuery.requestAtom, PRICING_REQUEST)
    const unpin = atoms.aliasesQuery.pin(registry)
    try {
      await waitForSuccess(registry, atoms.aliasesQuery.resultAtom)
      const invalidate = client.runtime.fn(() => Reactivity.invalidate(['pricing']))
      await dispatch(registry, invalidate, undefined)
      await vi.waitFor(() => expect(getAliases).toHaveBeenCalledTimes(2))
      expect(getOverrides).not.toHaveBeenCalled()
      expect(getModels).not.toHaveBeenCalled()
    } finally {
      unpin()
    }
  })

  it('dispatches each native config mutation once and clears its command error', async () => {
    const request = vi.fn(() => Promise.resolve({ ok: true }))
    const { atoms, registry } = setup({ request })
    registry.set(atoms.commandErrorsAtom, {
      addAlias: 'old',
      removeAlias: 'old',
      setOverride: 'old',
      removeOverride: 'old',
    })

    const writes = [
      dispatch(registry, atoms.addAliasAtom, { model: 'raw', aliasOf: 'target' }),
      dispatch(registry, atoms.removeAliasAtom, 'raw'),
      dispatch(registry, atoms.setOverrideAtom, {
        model: 'raw',
        inputPricePerMillion: 1,
        outputPricePerMillion: 2,
      }),
      dispatch(registry, atoms.removeOverrideAtom, 'raw'),
    ]
    await expect(Promise.all(writes)).resolves.toEqual([{ ok: true }, { ok: true }, { ok: true }, { ok: true }])

    expect(request.mock.calls).toEqual([
      ['models:addAlias', 'raw', 'target'],
      ['models:removeAlias', 'raw'],
      ['models:setPrice', 'raw', 1, 2],
      ['models:removePriceOverride', 'raw'],
    ])
    expect(registry.get(atoms.commandErrorsAtom)).toEqual({
      addAlias: null,
      removeAlias: null,
      setOverride: null,
      removeOverride: null,
    })
  })

  it('returns write failure without invalidating queries', async () => {
    const getAliases = vi.fn(() => Promise.resolve([]))
    const request = vi.fn((operation: string) => {
      if (operation === 'models:addAlias') return Promise.reject(new Error('offline'))
      if (operation === 'models:getAliases') return getAliases()
      return Promise.resolve({ ok: true })
    })
    const { atoms, registry } = setup({ request })
    const result = await dispatch(registry, atoms.addAliasAtom, { model: 'raw', aliasOf: 'target' })
    expect(result).toEqual({ ok: false, message: 'Configuration command failed' })
    expect(registry.get(atoms.commandErrorsAtom).addAlias).toBe('Configuration command failed')
    expect(getAliases).not.toHaveBeenCalled()
  })

  it('serializes same-tag native mutations while keeping command results independent', async () => {
    let finishFirst: (() => void) | undefined
    let writes = 0
    const request = vi.fn((operation: string) => {
      if (operation !== 'models:addAlias') return Promise.resolve({ ok: true })
      writes += 1
      if (writes === 1) {
        return new Promise(resolve => {
          finishFirst = () => resolve({ ok: true })
        })
      }
      return Promise.reject(new Error('second failed'))
    })
    const { client, atoms, registry } = setup({ request })
    const secondFamily = createPricingCommandFamily(client, atoms)
    const first = dispatch(registry, atoms.addAliasAtom, { model: 'one', aliasOf: 'priced' })
    await vi.waitFor(() => expect(writes).toBe(1))
    const second = dispatch(registry, secondFamily.addAliasAtom, { model: 'two', aliasOf: 'priced' })
    await Promise.resolve()
    expect(writes).toBe(1)
    finishFirst?.()

    await expect(first).resolves.toEqual({ ok: true })
    await expect(second).resolves.toEqual({ ok: false, message: 'Configuration command failed' })
    expect(writes).toBe(2)
    expect(registry.get(atoms.addAliasAtom)).toMatchObject({ _tag: 'Success', value: { ok: true } })
    expect(registry.get(secondFamily.addAliasAtom)).toMatchObject({
      _tag: 'Success',
      value: { ok: false, message: 'Configuration command failed' },
    })
  })

  it('waits for the receipt revision and the active query refresh to settle', async () => {
    let refreshes = 0
    let finishRefresh: (() => void) | undefined
    const request = vi.fn((operation: string) => {
      if (operation === 'models:addAlias') return Promise.resolve({ ok: true })
      if (operation === 'models:getAliases') {
        refreshes += 1
        if (refreshes === 3) {
          return new Promise(resolve => {
            finishRefresh = () => resolve([])
          })
        }
        return Promise.resolve([])
      }
      return Promise.resolve({ ok: true })
    })
    const { atoms, registry, configEventAtom } = setup({ request, configRevision: () => 3 })
    registry.set(atoms.aliasesQuery.requestAtom, PRICING_REQUEST)
    const unpin = atoms.aliasesQuery.pin(registry)
    try {
      await waitForSuccess(registry, atoms.aliasesQuery.resultAtom)
      registry.set(configInvalidationRevisionAtom, 1)
      let settled = false
      const write = dispatch(registry, atoms.addAliasAtom, { model: 'raw', aliasOf: 'priced' }).then(value => {
        settled = true
        return value
      })
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith('models:addAlias', 'raw', 'priced'))

      await dispatch(registry, configEventAtom, 2)
      await vi.waitFor(() => expect(refreshes).toBe(2))
      expect(settled).toBe(false)

      await dispatch(registry, configEventAtom, 3)
      await vi.waitFor(() => expect(refreshes).toBe(3))
      expect(settled).toBe(false)
      finishRefresh?.()

      await expect(write).resolves.toEqual({ ok: true })
      expect(registry.get(atoms.aliasesQuery.resultAtom)).toMatchObject({ _tag: 'Success', value: [] })
    } finally {
      unpin()
    }
  })

  it('keeps a committed write successful when its query refresh fails', async () => {
    let aliasReads = 0
    const request = vi.fn((operation: string) => {
      if (operation === 'models:addAlias') return Promise.resolve({ ok: true })
      if (operation === 'models:getAliases') {
        aliasReads += 1
        return aliasReads === 1 ? Promise.resolve([]) : Promise.reject(new Error('refresh failed'))
      }
      return Promise.resolve({ ok: true })
    })
    const { atoms, registry, configEventAtom } = setup({ request, configRevision: () => 1 })
    registry.set(atoms.aliasesQuery.requestAtom, PRICING_REQUEST)
    const unpin = atoms.aliasesQuery.pin(registry)
    try {
      await waitForSuccess(registry, atoms.aliasesQuery.resultAtom)
      const write = dispatch(registry, atoms.addAliasAtom, { model: 'raw', aliasOf: 'priced' })
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith('models:addAlias', 'raw', 'priced'))
      await dispatch(registry, configEventAtom, 1)
      await expect(write).resolves.toEqual({ ok: true })
      expect(registry.get(atoms.aliasesQuery.resultAtom)).toMatchObject({ _tag: 'Failure', waiting: false })
      expect(request.mock.calls.filter(([operation]) => operation === 'models:addAlias')).toHaveLength(1)
    } finally {
      unpin()
    }
  })
})
