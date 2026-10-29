import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'
import * as Stream from 'effect/Stream'

import { configInvalidationRevisionAtom } from '@/app/atoms/config-change'
import { createRpcQuerySlot } from '@/app/atoms/rpc-query'
import { ApplicationClient } from '@/shared/lib/application-rpc'
import { isUnpriced } from '@/shared/lib/models'

import { configWriteReceiptSchema } from '../../../../shared/rpc/config.js'
import type { ModelAlias, ModelReportRow, PriceOverride } from '../../../../shared/schemas/models.js'

type PricingClient = Pick<typeof ApplicationClient, 'runtime' | 'mutation' | 'query'>

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

type ConfigWriteReceipt = Schema.Schema.Type<typeof configWriteReceiptSchema>

const setCommandError = (
  get: Atom.FnContext,
  errorsAtom: Atom.Writable<PricingCommandErrors, PricingCommandErrors>,
  command: PricingCommand,
  error: string | null,
): void => {
  const registry = get.registry
  registry.set(errorsAtom, { ...registry.get(errorsAtom), [command]: error })
}

const refreshAfterWrite = Effect.fnUntraced(function* (
  get: Atom.FnContext,
  options: PricingCommandOptions,
  configRevision: number,
) {
  if (get.registry.get(configInvalidationRevisionAtom) < configRevision) {
    yield* Stream.runDrain(
      get.stream(configInvalidationRevisionAtom).pipe(
        Stream.filter(revision => revision >= configRevision),
        Stream.take(1),
      ),
    )
  }

  const registry = get.registry
  const activeQueries = [options.aliasesQuery, options.overridesQuery, options.knownModelsQuery].filter(
    query => registry.get(query.requestAtom) !== null,
  )
  yield* Effect.all(
    activeQueries.map(query => Effect.result(get.result(query.resultAtom, { suspendOnWaiting: true }))),
    { concurrency: 'unbounded' },
  )
})

const createPricingCommandAtoms = (client: PricingClient, options: PricingCommandOptions) => {
  const command = <Input, MutationInput extends { readonly payload: unknown }, MutationError>(
    name: PricingCommand,
    mutation: Atom.AtomResultFn<MutationInput, ConfigWriteReceipt, MutationError>,
    toMutationInput: (input: Input) => MutationInput,
  ) =>
    client.runtime.fn<Input>()(
      (input, get) =>
        get.registry.get(writeSemaphoreAtom).withPermit(
          Effect.gen(function* () {
            const result = yield* Effect.result(get.setResult(mutation, toMutationInput(input)))
            if (result._tag === 'Failure') {
              const message = result.failure instanceof Error ? result.failure.message : String(result.failure)
              setCommandError(get, options.commandErrorsAtom, name, message)
              return { ok: false, message } as const
            }

            setCommandError(get, options.commandErrorsAtom, name, null)
            yield* refreshAfterWrite(get, options, result.success.configRevision)
            return { ok: true } as const
          }),
        ),
      { concurrent: true },
    )

  return {
    addAliasAtom: command('addAlias', client.mutation('models:addAlias'), (input: ModelAlias) => ({ payload: input })),
    removeAliasAtom: command('removeAlias', client.mutation('models:removeAlias'), (model: string) => ({
      payload: { model },
    })),
    setOverrideAtom: command('setOverride', client.mutation('models:setPrice'), (input: PriceOverride) => ({
      payload: input,
    })),
    removeOverrideAtom: command('removeOverride', client.mutation('models:removePriceOverride'), (model: string) => ({
      payload: { model },
    })),
  }
}

export function createPricingAtoms(client: PricingClient = ApplicationClient) {
  const aliasesQuery = createRpcQuerySlot({
    key: () => 'aliases',
    query: (_request, selectionId) =>
      client.query('models:getAliases', undefined, { serializationKey: selectionId, reactivityKeys: ['pricing'] }),
  })
  const overridesQuery = createRpcQuerySlot({
    key: () => 'overrides',
    query: (_request, selectionId) =>
      client.query('models:getPriceOverrides', undefined, {
        serializationKey: selectionId,
        reactivityKeys: ['pricing'],
      }),
  })
  const knownModelsQuery = createRpcQuerySlot({
    key: () => 'known-models',
    query: (_request, selectionId) =>
      client.query(
        'models:view',
        { scope: KNOWN_MODELS_REQUEST },
        {
          serializationKey: selectionId,
          reactivityKeys: ['ledger', 'pricing'],
        },
      ),
  })
  const commandErrorsAtom = Atom.keepAlive(Atom.make<PricingCommandErrors>(initialErrors))
  const commandAtoms = createPricingCommandAtoms(client, {
    aliasesQuery,
    overridesQuery,
    knownModelsQuery,
    commandErrorsAtom,
  })

  const { addAliasAtom, removeAliasAtom, setOverrideAtom, removeOverrideAtom } = commandAtoms
  const knownModelsAtom = Atom.readable<ModelReportRow[] | null>(get => {
    const payload = AsyncResult.value(get(knownModelsQuery.resultAtom))
    return Option.isSome(payload) ? (payload.value?.byModel ?? []) : null
  })
  const unpricedModelsAtom = Atom.readable(get => (get(knownModelsAtom) ?? []).filter(isUnpriced))
  const pricedModelsAtom = Atom.readable(get => (get(knownModelsAtom) ?? []).filter(model => model.costUSD > 0))

  return {
    aliasesQuery,
    overridesQuery,
    knownModelsQuery,
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

const defaultPricingAtoms = createPricingAtoms()

/** Each form uses the shared native mutation atoms and a distinct command result atom. */
export function createPricingCommandFamily(
  client: PricingClient = ApplicationClient,
  options: PricingCommandOptions = {
    aliasesQuery: defaultPricingAtoms.aliasesQuery,
    overridesQuery: defaultPricingAtoms.overridesQuery,
    knownModelsQuery: defaultPricingAtoms.knownModelsQuery,
    commandErrorsAtom: defaultPricingAtoms.commandErrorsAtom,
  },
) {
  return createPricingCommandAtoms(client, options)
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
