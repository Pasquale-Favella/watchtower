import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import * as Semaphore from 'effect/Semaphore'
import * as Stream from 'effect/Stream'

import { configInvalidationRevisionAtom } from '@/app/atoms/config-change'
import { createRemoteQuerySlot } from '@/app/atoms/remote-query'
import { runtime as sharedRuntime } from '@/app/renderer-runtime'
import { isUnpriced } from '@/shared/lib/models'
import { RendererApi } from '@/shared/lib/renderer-api'

import type { ModelReportRow } from '../../../../shared/schemas/models.js'

export const PRICING_REQUEST = {}
export const KNOWN_MODELS_REQUEST = { period: 'lifetime' as const }

export type PricingCommand = 'addAlias' | 'removeAlias' | 'setOverride' | 'removeOverride'
export type PricingCommandErrors = Readonly<Record<PricingCommand, string | null>>

const initialErrors: PricingCommandErrors = {
  addAlias: null,
  removeAlias: null,
  setOverride: null,
  removeOverride: null,
}

const writeSemaphoreAtom = Atom.keepAlive(Atom.readable(() => Semaphore.makeUnsafe(1)))

interface PricingCommandOptions {
  readonly aliasesQuery: QueryInvalidationTarget
  readonly overridesQuery: QueryInvalidationTarget
  readonly knownModelsQuery: QueryInvalidationTarget
  readonly commandErrorsAtom: Atom.Writable<PricingCommandErrors, PricingCommandErrors>
}

interface QueryInvalidationTarget {
  readonly requestAtom: Atom.Atom<unknown>
  readonly resultAtom: Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>
}

export function createPricingCommandAtoms(
  factory: Atom.RegistryRuntimeFactory,
  options: PricingCommandOptions,
  apiLayer: Layer.Layer<RendererApi> = RendererApi.layer,
) {
  const api = factory(apiLayer)
  const setCommandError = (get: Atom.FnContext, command: PricingCommand, error: string | null): void => {
    const registry = get.registry
    registry.set(options.commandErrorsAtom, {
      ...registry.get(options.commandErrorsAtom),
      [command]: error,
    })
  }

  const refreshAfterWrite = (get: Atom.FnContext, revision: number) =>
    Effect.gen(function* () {
      yield* Stream.runDrain(
        get.stream(configInvalidationRevisionAtom).pipe(
          Stream.filter(next => next > revision),
          Stream.take(1),
        ),
      )

      const registry = get.registry
      const activeQueries = [options.aliasesQuery, options.overridesQuery, options.knownModelsQuery].filter(
        query => registry.get(query.requestAtom) !== null,
      )
      yield* Effect.all(
        activeQueries.map(query => Effect.result(get.result(query.resultAtom, { suspendOnWaiting: true }))),
        { concurrency: 'unbounded' },
      )
    })

  const command = <Input>(
    name: PricingCommand,
    write: (rendererApi: RendererApi['Service'], input: Input) => Effect.Effect<void, unknown>,
  ) =>
    api.fn<Input>()(
      (input, get) =>
        get.registry.get(writeSemaphoreAtom).withPermit(
          Effect.gen(function* () {
            const revision = get.registry.get(configInvalidationRevisionAtom)
            const rendererApi = yield* RendererApi
            const result = yield* Effect.result(write(rendererApi, input))
            if (result._tag === 'Failure') {
              const message = result.failure instanceof Error ? result.failure.message : String(result.failure)
              setCommandError(get, name, message)
              return { ok: false, message } as const
            }
            setCommandError(get, name, null)
            yield* refreshAfterWrite(get, revision)
            return { ok: true } as const
          }),
        ),
      { concurrent: true },
    )

  return {
    addAliasAtom: command('addAlias', (rendererApi, input: { model: string; aliasOf: string }) =>
      rendererApi.addModelAlias(input.model, input.aliasOf),
    ),
    removeAliasAtom: command('removeAlias', (rendererApi, model: string) => rendererApi.removeModelAlias(model)),
    setOverrideAtom: command(
      'setOverride',
      (rendererApi, input: { model: string; inputPricePerMillion: number; outputPricePerMillion: number }) =>
        rendererApi.setModelPrice(input.model, input.inputPricePerMillion, input.outputPricePerMillion),
    ),
    removeOverrideAtom: command('removeOverride', (rendererApi, model: string) =>
      rendererApi.removePriceOverride(model),
    ),
  }
}

export function createPricingAtoms(
  factory: Atom.RegistryRuntimeFactory,
  apiLayer: Layer.Layer<RendererApi> = RendererApi.layer,
) {
  const api = factory(apiLayer)
  const pricingAliases = createRemoteQuerySlot({
    runtime: api,
    fetch: () => Effect.flatMap(RendererApi, rendererApi => rendererApi.getModelAliases()),
    key: () => 'aliases',
    reactivityKeys: ['pricing'],
  })
  const pricingOverrides = createRemoteQuerySlot({
    runtime: api,
    fetch: () => Effect.flatMap(RendererApi, rendererApi => rendererApi.getPriceOverrides()),
    key: () => 'overrides',
    reactivityKeys: ['pricing'],
  })
  const pricingKnownModels = createRemoteQuerySlot({
    runtime: api,
    fetch: () => Effect.flatMap(RendererApi, rendererApi => rendererApi.getModels(KNOWN_MODELS_REQUEST)),
    key: () => 'known-models',
    reactivityKeys: ['ledger', 'pricing'],
  })
  const commandErrorsAtom = Atom.keepAlive(Atom.make<PricingCommandErrors>(initialErrors))
  const commandAtoms = createPricingCommandAtoms(
    factory,
    {
      aliasesQuery: pricingAliases,
      overridesQuery: pricingOverrides,
      knownModelsQuery: pricingKnownModels,
      commandErrorsAtom,
    },
    apiLayer,
  )
  const { addAliasAtom, removeAliasAtom, setOverrideAtom, removeOverrideAtom } = commandAtoms

  const unpricedModelsAtom = Atom.readable(get => {
    const result = get(pricingKnownModels.resultAtom)
    return result._tag === 'Success' ? (result.value?.byModel ?? []).filter(isUnpriced) : []
  })
  const pricedModelsAtom = Atom.readable(get => {
    const result = get(pricingKnownModels.resultAtom)
    return result._tag === 'Success' ? (result.value?.byModel ?? []).filter(model => model.costUSD > 0) : []
  })
  const knownModelsAtom = Atom.readable<ModelReportRow[] | null>(get => {
    const result = get(pricingKnownModels.resultAtom)
    return result._tag === 'Success' ? (result.value?.byModel ?? []) : null
  })

  return {
    aliasesQuery: pricingAliases,
    overridesQuery: pricingOverrides,
    knownModelsQuery: pricingKnownModels,
    commandErrorsAtom,
    addAliasAtom,
    removeAliasAtom,
    setOverrideAtom,
    removeOverrideAtom,
    knownModelsAtom,
    unpricedModelsAtom,
    pricedModelsAtom,
  }
}

const defaultPricingAtoms = createPricingAtoms(sharedRuntime)

/** Each form gets its own command result atom so concurrent callers cannot share receipts. */
export function createPricingCommandFamily(
  factory: Atom.RegistryRuntimeFactory = sharedRuntime,
  apiLayer: Layer.Layer<RendererApi> = RendererApi.layer,
) {
  return createPricingCommandAtoms(
    factory,
    {
      aliasesQuery: defaultPricingAtoms.aliasesQuery,
      overridesQuery: defaultPricingAtoms.overridesQuery,
      knownModelsQuery: defaultPricingAtoms.knownModelsQuery,
      commandErrorsAtom: defaultPricingAtoms.commandErrorsAtom,
    },
    apiLayer,
  )
}

export const aliasesPricingCommands = createPricingCommandFamily()
export const pricingPaneCommands = createPricingCommandFamily()
export const quickAddPricingCommands = createPricingCommandFamily()

export const {
  aliasesQuery: pricingAliasesQuery,
  overridesQuery: pricingOverridesQuery,
  knownModelsQuery: pricingKnownModelsQuery,
  commandErrorsAtom: pricingCommandErrorsAtom,
  addAliasAtom,
  removeAliasAtom,
  setOverrideAtom,
  removeOverrideAtom,
  knownModelsAtom,
  unpricedModelsAtom,
  pricedModelsAtom,
} = defaultPricingAtoms
