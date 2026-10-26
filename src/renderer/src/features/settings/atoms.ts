import * as Effect from 'effect/Effect'
import * as Atom from 'effect/reactivity/Atom'
import * as Semaphore from 'effect/Semaphore'

import { createRpcQuerySlot } from '@/app/atoms/rpc-query'
import { ApplicationClient } from '@/shared/lib/application-rpc'

import type { ActiveCurrency, CurrencyOption } from '../../../../shared/schemas/fx.js'

const CADENCE_REQUEST = {}
const CURRENCY_REQUEST = {}
const CURRENCY_OPTIONS_REQUEST = {}

const cadenceWriteSemaphoreAtom = Atom.keepAlive(Atom.readable(() => Semaphore.makeUnsafe(1)))
const currencyWriteSemaphoreAtom = Atom.keepAlive(Atom.readable(() => Semaphore.makeUnsafe(1)))

export const createSettingsAtoms = (client: typeof ApplicationClient = ApplicationClient) => {
  const cadenceAtom = Atom.keepAlive(Atom.make('1m'))
  const cadenceRevisionAtom = Atom.keepAlive(Atom.make(0))
  const activeCurrencyAtom = Atom.keepAlive(Atom.make<ActiveCurrency>({ code: 'USD', symbol: '$', rate: 1 }))
  const currencyRevisionAtom = Atom.keepAlive(Atom.make(0))
  const currencyOptionsAtom = Atom.keepAlive(Atom.make<CurrencyOption[]>([]))

  const cadenceQuery = createRpcQuerySlot({
    key: () => 'cadence',
    query: (_request, selectionId) => client.query('cadence:get', undefined, { serializationKey: selectionId }),
  })
  const currencyQuery = createRpcQuerySlot({
    key: () => 'currency',
    query: (_request, selectionId) => client.query('currency:get', undefined, { serializationKey: selectionId }),
  })
  const currencyOptionsQuery = createRpcQuerySlot({
    key: () => 'currency-options',
    query: (_request, selectionId) => client.query('currency:list', undefined, { serializationKey: selectionId }),
  })

  const loadCadenceAtom = client.runtime.fn<undefined>()(
    (_, get) =>
      Effect.gen(function* () {
        const revision = get(cadenceRevisionAtom)
        if (get.registry.get(cadenceQuery.requestAtom) === null)
          get.registry.set(cadenceQuery.requestAtom, CADENCE_REQUEST)
        else get.registry.set(cadenceQuery.refreshAtom, undefined)
        const cadence = yield* get.result(cadenceQuery.resultAtom, { suspendOnWaiting: true })
        if (get(cadenceRevisionAtom) === revision) get.set(cadenceAtom, cadence)
        return cadence
      }),
    { concurrent: true },
  )

  const loadCurrencyAtom = client.runtime.fn<undefined>()(
    (_, get) =>
      Effect.gen(function* () {
        const revision = get(currencyRevisionAtom)
        if (get.registry.get(currencyQuery.requestAtom) === null)
          get.registry.set(currencyQuery.requestAtom, CURRENCY_REQUEST)
        else get.registry.set(currencyQuery.refreshAtom, undefined)
        const currency = yield* get.result(currencyQuery.resultAtom, { suspendOnWaiting: true })
        if (get(currencyRevisionAtom) === revision) get.set(activeCurrencyAtom, currency)
        return currency
      }),
    { concurrent: true },
  )

  const loadCurrencyOptionsAtom = client.runtime.fn<undefined>()(
    (_, get) =>
      Effect.gen(function* () {
        if (get.registry.get(currencyOptionsQuery.requestAtom) === null)
          get.registry.set(currencyOptionsQuery.requestAtom, CURRENCY_OPTIONS_REQUEST)
        else get.registry.set(currencyOptionsQuery.refreshAtom, undefined)
        const options = yield* get.result(currencyOptionsQuery.resultAtom, { suspendOnWaiting: true })
        get.set(currencyOptionsAtom, options)
        return options
      }),
    { concurrent: true },
  )

  const cadenceMutation = client.mutation('cadence:set')
  const setCadenceAtom = client.runtime.fn<string>()(
    (value, get) =>
      Effect.gen(function* () {
        get.set(cadenceRevisionAtom, get(cadenceRevisionAtom) + 1)
        return yield* get.registry.get(cadenceWriteSemaphoreAtom).withPermit(
          Effect.gen(function* () {
            const result = yield* Effect.result(get.setResult(cadenceMutation, { payload: { value } }))
            get.set(cadenceRevisionAtom, get(cadenceRevisionAtom) + 1)
            if (result._tag === 'Failure') return yield* Effect.fail(result.failure)
            get.set(cadenceAtom, result.success)
            return result.success
          }),
        )
      }),
    { concurrent: true },
  )

  const currencyMutation = client.mutation('currency:set')
  const setCurrencyAtom = client.runtime.fn<string>()(
    (code, get) =>
      Effect.gen(function* () {
        get.set(currencyRevisionAtom, get(currencyRevisionAtom) + 1)
        return yield* get.registry.get(currencyWriteSemaphoreAtom).withPermit(
          Effect.gen(function* () {
            const revision = get(currencyRevisionAtom)
            const result = yield* Effect.result(get.setResult(currencyMutation, { payload: { code } }))
            const unchanged = get(currencyRevisionAtom) === revision
            get.set(currencyRevisionAtom, get(currencyRevisionAtom) + 1)
            if (result._tag === 'Failure') return yield* Effect.fail(result.failure)
            if (unchanged) get.set(activeCurrencyAtom, result.success)
            return result.success
          }),
        )
      }),
    { concurrent: true },
  )

  const currencyChangedAtom = Atom.writable(
    get => get(activeCurrencyAtom),
    (context, currency: ActiveCurrency) => {
      context.set(currencyRevisionAtom, context.get(currencyRevisionAtom) + 1)
      context.set(activeCurrencyAtom, currency)
    },
  )

  return {
    cadenceAtom,
    activeCurrencyAtom,
    currencyOptionsAtom,
    cadenceQuery,
    currencyQuery,
    currencyOptionsQuery,
    loadCadenceAtom,
    loadCurrencyAtom,
    loadCurrencyOptionsAtom,
    setCadenceAtom,
    setCurrencyAtom,
    currencyChangedAtom,
  }
}

export type SettingsAtoms = ReturnType<typeof createSettingsAtoms>

const defaultSettingsAtoms = createSettingsAtoms()

export const {
  cadenceAtom,
  activeCurrencyAtom,
  currencyOptionsAtom,
  loadCadenceAtom,
  loadCurrencyAtom,
  loadCurrencyOptionsAtom,
  setCadenceAtom,
  setCurrencyAtom,
  currencyChangedAtom,
} = defaultSettingsAtoms
