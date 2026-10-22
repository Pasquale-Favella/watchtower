import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { describe, expect, it } from 'vitest'

import { createSettingsAtoms } from '../src/renderer/src/features/settings/atoms.js'
import { legacyRendererApi, RendererApi, RendererApiError } from '../src/renderer/src/shared/lib/renderer-api.js'
import type { ActiveCurrency, CurrencyOption } from '../src/shared/schemas/fx.js'

const eur: ActiveCurrency = { code: 'EUR', symbol: '€', rate: 0.92 }
const currencies: CurrencyOption[] = [
  { code: 'EUR', symbol: '€' },
  { code: 'USD', symbol: '$' },
]

type SettingsOverrides = Partial<
  Pick<RendererApi['Service'], 'getCadence' | 'setCadence' | 'getCurrency' | 'setCurrency' | 'getCurrencies'>
>

function makeHarness(overrides: SettingsOverrides = {}) {
  const runtime = Atom.context()
  const service = { ...legacyRendererApi, ...overrides }
  const apiLayer = Layer.succeed(RendererApi, service)
  const atoms = createSettingsAtoms(runtime, apiLayer)
  const registry = AtomRegistry.make()
  return { atoms, registry }
}

function dispatch<Arg, A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.AtomResultFn<Arg, A, E>,
  arg: Arg,
): Promise<AsyncResult.AsyncResult<A, E>> {
  return new Promise(resolve => {
    let unsubscribe: () => void = () => undefined
    unsubscribe = registry.subscribe(atom, result => {
      if (!result.waiting && !AsyncResult.isInitial(result)) {
        unsubscribe()
        resolve(result)
      }
    })
    registry.set(atom, arg)
  })
}

describe('settings atoms', () => {
  it('starts with current cadence and USD defaults', () => {
    const { atoms, registry } = makeHarness()
    expect(registry.get(atoms.cadenceAtom)).toBe('1m')
    expect(registry.get(atoms.activeCurrencyAtom)).toEqual({ code: 'USD', symbol: '$', rate: 1 })
    expect(registry.get(atoms.currencyOptionsAtom)).toEqual([])
  })

  it('loads cadence, active currency, and currency options through RendererApi', async () => {
    const { atoms, registry } = makeHarness({
      getCadence: () => Effect.succeed('5m'),
      getCurrency: () => Effect.succeed(eur),
      getCurrencies: () => Effect.succeed(currencies),
    })

    const cadence = await dispatch(registry, atoms.loadCadenceAtom, undefined)
    const currency = await dispatch(registry, atoms.loadCurrencyAtom, undefined)
    const options = await dispatch(registry, atoms.loadCurrencyOptionsAtom, undefined)

    expect(AsyncResult.isSuccess(cadence) && cadence.value).toBe('5m')
    expect(registry.get(atoms.cadenceAtom)).toBe('5m')
    expect(AsyncResult.isSuccess(currency) && currency.value).toEqual(eur)
    expect(registry.get(atoms.activeCurrencyAtom)).toEqual(eur)
    expect(AsyncResult.isSuccess(options) && options.value).toEqual(currencies)
    expect(registry.get(atoms.currencyOptionsAtom)).toEqual(currencies)
  })

  it('applies cadence optimistically and replaces it with the server confirmation', async () => {
    const { atoms, registry } = makeHarness({ setCadence: () => Effect.succeed('5m') })
    const result = await dispatch(registry, atoms.setCadenceAtom, '10m')

    expect(AsyncResult.isSuccess(result) && result.value).toBe('5m')
    expect(registry.get(atoms.cadenceAtom)).toBe('5m')
  })

  it('keeps the optimistic cadence after a failed write', async () => {
    const failure = new RendererApiError({ operation: 'cadence:set', message: 'offline' })
    const { atoms, registry } = makeHarness({ setCadence: () => Effect.fail(failure) })
    const result = await dispatch(registry, atoms.setCadenceAtom, '10m')

    expect(AsyncResult.isFailure(result)).toBe(true)
    expect(registry.get(atoms.cadenceAtom)).toBe('10m')
  })

  it('changes currency only after the main process confirms it', async () => {
    const failure = new RendererApiError({ operation: 'currency:set', message: 'offline' })
    const { atoms, registry } = makeHarness({ setCurrency: () => Effect.fail(failure) })
    const failed = await dispatch(registry, atoms.setCurrencyAtom, 'EUR')

    expect(AsyncResult.isFailure(failed)).toBe(true)
    expect(registry.get(atoms.activeCurrencyAtom)).toEqual({ code: 'USD', symbol: '$', rate: 1 })

    const successHarness = makeHarness({ setCurrency: () => Effect.succeed(eur) })
    const succeeded = await dispatch(successHarness.registry, successHarness.atoms.setCurrencyAtom, 'EUR')
    expect(AsyncResult.isSuccess(succeeded)).toBe(true)
    expect(successHarness.registry.get(successHarness.atoms.activeCurrencyAtom)).toEqual(eur)
  })

  it('keeps prior values when loads fail and applies currency change events directly', async () => {
    const failure = new RendererApiError({ operation: 'currency:get', message: 'offline' })
    const { atoms, registry } = makeHarness({
      getCurrency: () => Effect.fail(failure),
      getCurrencies: () => Effect.fail(failure),
    })
    registry.set(atoms.activeCurrencyAtom, eur)
    registry.set(atoms.currencyOptionsAtom, currencies)

    const loadedCurrency = await dispatch(registry, atoms.loadCurrencyAtom, undefined)
    const loadedOptions = await dispatch(registry, atoms.loadCurrencyOptionsAtom, undefined)
    expect(AsyncResult.isFailure(loadedCurrency)).toBe(true)
    expect(AsyncResult.isFailure(loadedOptions)).toBe(true)
    expect(registry.get(atoms.activeCurrencyAtom)).toEqual(eur)
    expect(registry.get(atoms.currencyOptionsAtom)).toEqual(currencies)

    registry.set(atoms.currencyChangedAtom, { code: 'GBP', symbol: '£', rate: 0.8 })
    expect(registry.get(atoms.activeCurrencyAtom)).toEqual({ code: 'GBP', symbol: '£', rate: 0.8 })
  })

  it('admits overlapping writes to the same command without interrupting an earlier call', async () => {
    const started: string[] = []
    const finished: string[] = []
    const { atoms, registry } = makeHarness({
      setCadence: value =>
        Effect.promise(() => {
          started.push(value)
          return new Promise<string>(resolve => {
            setTimeout(() => {
              finished.push(value)
              resolve(value)
            }, 10)
          })
        }),
    })
    const first = dispatch(registry, atoms.setCadenceAtom, '2m')
    const second = dispatch(registry, atoms.setCadenceAtom, '3m')
    await Promise.all([first, second])

    expect(started).toEqual(['2m', '3m'])
    expect(finished).toEqual(['2m', '3m'])
  })
})
