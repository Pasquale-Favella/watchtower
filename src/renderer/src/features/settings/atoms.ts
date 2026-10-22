import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Atom from 'effect/reactivity/Atom'

import { runtime as sharedRuntime } from '@/app/renderer-runtime'
import { RendererApi } from '@/shared/lib/renderer-api'

import type { ActiveCurrency, CurrencyOption } from '../../../../shared/schemas/fx.js'

export const createSettingsAtoms = (
  runtime: Atom.RegistryRuntimeFactory,
  apiLayer: Layer.Layer<RendererApi> = RendererApi.layer,
) => {
  const api = runtime(apiLayer)
  const cadenceAtom = Atom.keepAlive(Atom.make('1m'))
  const activeCurrencyAtom = Atom.keepAlive(Atom.make<ActiveCurrency>({ code: 'USD', symbol: '$', rate: 1 }))
  const currencyOptionsAtom = Atom.keepAlive(Atom.make<CurrencyOption[]>([]))

  const loadCadenceAtom = api.fn<undefined>()(
    (_, get) =>
      Effect.gen(function* () {
        const rendererApi = yield* RendererApi
        const cadence = yield* rendererApi.getCadence()
        get.set(cadenceAtom, cadence)
        return cadence
      }),
    { concurrent: true },
  )

  const loadCurrencyAtom = api.fn<undefined>()(
    (_, get) =>
      Effect.gen(function* () {
        const rendererApi = yield* RendererApi
        const currency = yield* rendererApi.getCurrency()
        get.set(activeCurrencyAtom, currency)
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
        get.set(cadenceAtom, value)
        const rendererApi = yield* RendererApi
        const confirmed = yield* rendererApi.setCadence(value)
        get.set(cadenceAtom, confirmed)
        return confirmed
      }),
    { concurrent: true },
  )

  const setCurrencyAtom = api.fn<string>()(
    (code, get) =>
      Effect.gen(function* () {
        const rendererApi = yield* RendererApi
        const currency = yield* rendererApi.setCurrency(code)
        get.set(activeCurrencyAtom, currency)
        return currency
      }),
    { concurrent: true },
  )

  const currencyChangedAtom = Atom.writable(
    get => get(activeCurrencyAtom),
    (context, currency: ActiveCurrency) => context.set(activeCurrencyAtom, currency),
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
