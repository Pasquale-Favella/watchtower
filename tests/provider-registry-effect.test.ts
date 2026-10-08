import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Provider } from '../src/main/pipeline/providers/types.js'
import { deferred } from './helpers/deferred.js'

const mockState = vi.hoisted(() => ({
  load: undefined as ((name: string) => Promise<unknown>) | undefined,
}))

vi.mock('../src/main/pipeline/providers/forge.js', async () => ({ forge: await mockState.load?.('forge') }))
vi.mock('../src/main/pipeline/providers/zcode.js', async () => ({ zcode: await mockState.load?.('zcode') }))
vi.mock('../src/main/pipeline/providers/zed.js', async () => ({ zed: await mockState.load?.('zed') }))

const optionalProviderNames = [
  'antigravity',
  'forge',
  'goose',
  'cursor',
  'opencode',
  'cursor-agent',
  'crush',
  'warp',
  'vercel-gateway',
  'zcode',
  'zed',
]

function provider(name: string): Provider {
  return {
    name,
    displayName: name,
    modelDisplayName: model => model,
    toolDisplayName: tool => tool,
    discoverSessions: async () => [],
    createSessionParser: () => ({ parse: async function* () {} }),
  }
}

async function registryWithMocks(
  load: (name: string) => Promise<Provider>,
): Promise<typeof import('../src/main/pipeline/providers/index.js')> {
  vi.resetModules()
  mockState.load = load
  return import('../src/main/pipeline/providers/index.js')
}

afterEach(() => {
  mockState.load = undefined
  vi.resetModules()
})

describe('native optional provider registry', () => {
  it('keeps failed optional names advertised and does not retry a failed import', async () => {
    const loads = vi.fn(async () => {
      throw new Error('optional module unavailable')
    })
    const registry = await registryWithMocks(name => (name === 'zcode' ? loads() : Promise.resolve(provider(name))))

    await expect(Effect.runPromise(registry.getProviderEffect('zcode'))).resolves.toBeUndefined()
    await expect(Effect.runPromise(registry.getProviderEffect('zcode'))).resolves.toBeUndefined()
    expect(loads).toHaveBeenCalledOnce()
    expect(registry.allProviderNames()).toContain('zcode')
  })

  it('resolves core and unknown names without importing optional modules', async () => {
    const loads = vi.fn(async (name: string) => provider(name))
    const registry = await registryWithMocks(async name => {
      loads(name)
      return provider(name)
    })

    const core = await Effect.runPromise(registry.getProviderEffect('claude'))
    expect(core?.name).toBe('claude')
    await expect(Effect.runPromise(registry.getProviderEffect('unknown-provider'))).resolves.toBeUndefined()
    expect(loads).not.toHaveBeenCalled()
  })

  it('interrupts and drains pending imports before returning the abort identity', async () => {
    const pending = deferred<Provider>()
    const started = deferred<undefined>()
    let drained = false
    const registry = await registryWithMocks(async name => {
      if (name === 'zed') {
        started.resolve(undefined)
        return pending.promise.finally(() => {
          drained = true
        })
      }
      return provider(name)
    })
    const { ScanAbortedError } = await import('../src/main/pipeline/scan-control.js')
    const abort = new ScanAbortedError({ message: 'scan aborted' })
    let stopCalled = false
    const fiber = Effect.runFork(
      registry.getProviderEffect('zed', {
        stop: () => {
          stopCalled = true
          pending.resolve(provider('zed'))
        },
      }),
    )

    await started.promise
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(stopCalled).toBe(true)
    expect(drained).toBe(true)
    const exit = await Effect.runPromise(Fiber.await(fiber))
    expect(exit._tag).toBe('Failure')

    const stopped = await Effect.runPromise(
      registry.getProviderEffect('zed', { signal: AbortSignal.abort(abort) }).pipe(Effect.result),
    )
    expect(stopped._tag).toBe('Failure')
    if (stopped._tag === 'Failure') expect(stopped.failure).toBe(abort)
  })

  it('shares concurrent lazy imports and preserves the canonical provider order', async () => {
    const gate = deferred<Provider>()
    const started = deferred<undefined>()
    let forgeLoads = 0
    const registry = await registryWithMocks(async name => {
      if (name === 'forge') {
        forgeLoads += 1
        started.resolve(undefined)
        return gate.promise
      }
      return provider(name)
    })

    const first = Effect.runPromise(registry.getAllProvidersEffect())
    const second = Effect.runPromise(registry.getAllProvidersEffect())
    await started.promise
    expect(forgeLoads).toBe(1)
    gate.resolve(provider('forge'))

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult.map(item => item.name).slice(-11)).toEqual(optionalProviderNames)
    expect(secondResult.map(item => item.name)).toEqual(firstResult.map(item => item.name))
    expect(forgeLoads).toBe(1)
    expect(registry.allProviderNames()).toContain('antigravity')
  })
})
