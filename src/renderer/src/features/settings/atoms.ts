import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Atom from 'effect/reactivity/Atom'
import * as Semaphore from 'effect/Semaphore'

import { runtime as sharedRuntime } from '@/app/renderer-runtime'
import { RendererApi } from '@/shared/lib/renderer-api'

import type { ActiveCurrency, CurrencyOption } from '../../../../shared/schemas/fx.js'

const cadenceWriteSemaphoreAtom = Atom.keepAlive(Atom.readable(() => Semaphore.makeUnsafe(1)))
const currencyWriteSemaphoreAtom = Atom.keepAlive(Atom.readable(() => Semaphore.makeUnsafe(1)))

export const createSettingsAtoms = (
  runtime: Atom.RegistryRuntimeFactory,
  apiLayer: Layer.Layer<RendererApi> = RendererApi.layer,
) => {
  const api = runtime(apiLayer)
  const cadenceAtom = Atom.keepAlive(Atom.make('1m'))
  const cadenceRevisionAtom = Atom.keepAlive(Atom.make(0))
  const activeCurrencyAtom = Atom.keepAlive(Atom.make<ActiveCurrency>({ code: 'USD', symbol: '$', rate: 1 }))
  const currencyRevisionAtom = Atom.keepAlive(Atom.make(0))
  const currencyOptionsAtom = Atom.keepAlive(Atom.make<CurrencyOption[]>([]))

  const loadCadenceAtom = api.fn<undefined>()(
    (_, get) =>
      Effect.gen(function* () {
        const revision = get(cadenceRevisionAtom)
        const rendererApi = yield* RendererApi
        const cadence = yield* rendererApi.getCadence()
        if (get(cadenceRevisionAtom) === revision) get.set(cadenceAtom, cadence)
        return cadence
      }),
    { concurrent: true },
  )

  const loadCurrencyAtom = api.fn<undefined>()(
    (_, get) =>
      Effect.gen(function* () {
        const revision = get(currencyRevisionAtom)
        const rendererApi = yield* RendererApi
        const currency = yield* rendererApi.getCurrency()
        if (get(currencyRevisionAtom) === revision) get.set(activeCurrencyAtom, currency)
        return currency
      }),
    { concurrent: true },
  )

  const loadCurrencyOptionsAtom = api.fn<undefined>()(
    (_, get) =>
      Effect.gen(function* () {
        const rendererApi = yield* RendererApi
        const options = yield* rendererApi.getCurrencies()
        get.set(currencyOptionsAtom, options)
        return options
      }),
    { concurrent: true },
  )

  const setCadenceAtom = api.fn<string>()(
    (value, get) =>
      Effect.gen(function* () {
        get.set(cadenceRevisionAtom, get(cadenceRevisionAtom) + 1)
        return yield* get.registry.get(cadenceWriteSemaphoreAtom).withPermit(
          Effect.gen(function* () {
            const rendererApi = yield* RendererApi
            const result = yield* Effect.result(rendererApi.setCadence(value))
            get.set(cadenceRevisionAtom, get(cadenceRevisionAtom) + 1)
            if (result._tag === 'Failure') return yield* Effect.fail(result.failure)
            get.set(cadenceAtom, result.success)
            return result.success
          }),
        )
      }),
    { concurrent: true },
  )

  const setCurrencyAtom = api.fn<string>()(
    (code, get) =>
      Effect.gen(function* () {
        get.set(currencyRevisionAtom, get(currencyRevisionAtom) + 1)
        return yield* get.registry.get(currencyWriteSemaphoreAtom).withPermit(
          Effect.gen(function* () {
            const revision = get(currencyRevisionAtom)
            const rendererApi = yield* RendererApi
            const result = yield* Effect.result(rendererApi.setCurrency(code))
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
    loadCadenceAtom,
    loadCurrencyAtom,
    loadCurrencyOptionsAtom,
    setCadenceAtom,
    setCurrencyAtom,
    currencyChangedAtom,
  }
}

export type SettingsAtoms = ReturnType<typeof createSettingsAtoms>

const defaultSettingsAtoms = createSettingsAtoms(sharedRuntime, RendererApi.layer)

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
