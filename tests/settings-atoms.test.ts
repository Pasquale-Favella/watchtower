import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { afterEach, describe, expect, it } from 'vitest'

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

const registries: AtomRegistry.AtomRegistry[] = []
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose()
})

function makeHarness(overrides: SettingsOverrides = {}) {
  const runtime = Atom.context()
  const service = { ...legacyRendererApi, ...overrides }
  const apiLayer = Layer.succeed(RendererApi, service)
  const atoms = createSettingsAtoms(runtime, apiLayer)
  const registry = AtomRegistry.make()
  registries.push(registry)
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

  it('does not let a cadence snapshot overwrite a newer command confirmation', async () => {
    let resolveSnapshot!: (value: string) => void
    let markReadStarted!: () => void
    const readStarted = new Promise<void>(resolve => {
      markReadStarted = resolve
    })
    const { atoms, registry } = makeHarness({
      getCadence: () =>
        Effect.promise(() => {
          markReadStarted()
          return new Promise<string>(resolve => {
            resolveSnapshot = resolve
          })
        }),
      setCadence: () => Effect.succeed('5m'),
    })

    const loading = dispatch(registry, atoms.loadCadenceAtom, undefined)
    await readStarted
    const writing = dispatch(registry, atoms.setCadenceAtom, '10m')
    await writing
    resolveSnapshot('1m')
    await loading

    expect(registry.get(atoms.cadenceAtom)).toBe('5m')
  })

  it('does not let a cadence snapshot started during a write regress after commit', async () => {
    let resolveSnapshot!: (value: string) => void
    let resolveWrite!: (value: string) => void
    let markReadStarted!: () => void
    let markWriteStarted!: () => void
    const readStarted = new Promise<void>(resolve => {
      markReadStarted = resolve
    })
    const writeStarted = new Promise<void>(resolve => {
      markWriteStarted = resolve
    })
    const { atoms, registry } = makeHarness({
      getCadence: () =>
        Effect.promise(() => {
          markReadStarted()
          return new Promise<string>(resolve => {
            resolveSnapshot = resolve
          })
        }),
      setCadence: () =>
        Effect.promise(() => {
          markWriteStarted()
          return new Promise<string>(resolve => {
            resolveWrite = resolve
          })
        }),
    })

    const writing = dispatch(registry, atoms.setCadenceAtom, '5m')
    await writeStarted
    const loading = dispatch(registry, atoms.loadCadenceAtom, undefined)
    await readStarted

    resolveWrite('5m')
    await writing
    resolveSnapshot('1m')
    await loading

    expect(registry.get(atoms.cadenceAtom)).toBe('5m')
  })

  it('uses the cadence value confirmed by the server', async () => {
    const { atoms, registry } = makeHarness({ setCadence: () => Effect.succeed('5m') })
    const result = await dispatch(registry, atoms.setCadenceAtom, '10m')

    expect(AsyncResult.isSuccess(result) && result.value).toBe('5m')
    expect(registry.get(atoms.cadenceAtom)).toBe('5m')
  })

  it('restores the confirmed cadence after a failed write', async () => {
    const failure = new RendererApiError({ operation: 'cadence:set', message: 'offline' })
    const { atoms, registry } = makeHarness({ setCadence: () => Effect.fail(failure) })
    const result = await dispatch(registry, atoms.setCadenceAtom, '10m')

    expect(AsyncResult.isFailure(result)).toBe(true)
    expect(registry.get(atoms.cadenceAtom)).toBe('1m')
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
    expect(registry.get(atoms.cadenceAtom)).toBe('3m')
  })

  it('keeps cadence write locks isolated between registries', async () => {
    let releaseFirst!: (value: string) => void
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>(resolve => {
      markFirstStarted = resolve
    })
    const { atoms, registry: firstRegistry } = makeHarness({
      setCadence: value =>
        Effect.promise(() => {
          if (value !== '2m') return Promise.resolve(value)
          markFirstStarted()
          return new Promise<string>(resolve => {
            releaseFirst = resolve
          })
        }),
    })
    const secondRegistry = AtomRegistry.make()
    registries.push(secondRegistry)

    const firstWrite = dispatch(firstRegistry, atoms.setCadenceAtom, '2m')
    await firstStarted
    const secondWrite = dispatch(secondRegistry, atoms.setCadenceAtom, '3m')
    await secondWrite
    expect(secondRegistry.get(atoms.cadenceAtom)).toBe('3m')

    releaseFirst('2m')
    await firstWrite
    expect(firstRegistry.get(atoms.cadenceAtom)).toBe('2m')
  })

  it('does not let a currency snapshot overwrite a newer CurrencyChanged event', async () => {
    let resolveSnapshot!: (value: ActiveCurrency) => void
    let markReadStarted!: () => void
    const readStarted = new Promise<void>(resolve => {
      markReadStarted = resolve
    })
    const { atoms, registry } = makeHarness({
      getCurrency: () =>
        Effect.promise(() => {
          markReadStarted()
          return new Promise<ActiveCurrency>(resolve => {
            resolveSnapshot = resolve
          })
        }),
    })

    const loading = dispatch(registry, atoms.loadCurrencyAtom, undefined)
    await readStarted
    const changed: ActiveCurrency = { code: 'GBP', symbol: '£', rate: 0.8 }
    registry.set(atoms.currencyChangedAtom, changed)
    resolveSnapshot(eur)
    await loading

    expect(registry.get(atoms.activeCurrencyAtom)).toEqual(changed)
  })

  it('serializes currency writes so the final UI agrees with the backend', async () => {
    const started: string[] = []
    let releaseFirst!: (value: ActiveCurrency) => void
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>(resolve => {
      markFirstStarted = resolve
    })
    const { atoms, registry } = makeHarness({
      setCurrency: code =>
        Effect.promise(() => {
          started.push(code)
          if (code === 'EUR') {
            markFirstStarted()
            return new Promise<ActiveCurrency>(resolve => {
              releaseFirst = resolve
            })
          }
          return Promise.resolve({ code: 'GBP', symbol: '£', rate: 0.8 })
        }),
    })

    const firstWrite = dispatch(registry, atoms.setCurrencyAtom, 'EUR')
    await firstStarted
    const secondWrite = dispatch(registry, atoms.setCurrencyAtom, 'GBP')
    expect(started).toEqual(['EUR'])

    releaseFirst(eur)
    await Promise.all([firstWrite, secondWrite])

    expect(started).toEqual(['EUR', 'GBP'])
    expect(registry.get(atoms.activeCurrencyAtom)).toEqual({ code: 'GBP', symbol: '£', rate: 0.8 })
  })
})
