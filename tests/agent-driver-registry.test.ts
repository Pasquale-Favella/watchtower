import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner'
import { describe, expect, it } from 'vitest'

import { AgentDriver } from '@/core/ports/agent-driver.js'
import { AgentDriverRegistry } from '@/core/ports/agent-driver-registry.js'
import { AgentDriverRegistryLive } from '@/infrastructure/agent-harnesses/drivers/registry.js'

const makeDriver = (driverId: string): AgentDriver['Service'] =>
  AgentDriver.of({
    driverId,
    connect: () => Effect.die(new Error('Registry construction and resolution must not connect')),
  })

describe('AgentDriverRegistry', () => {
  it('rejects duplicate driver ids at construction rather than silently replacing a driver', () => {
    expect(() => AgentDriverRegistry.fromDrivers([makeDriver('same'), makeDriver('same')])).toThrow(
      expect.objectContaining({ _tag: 'AgentDriverError', code: 'invalid-state' }),
    )
  })

  it('returns a typed driver-unavailable failure for an unregistered id', async () => {
    const registry = AgentDriverRegistry.fromDrivers([])

    expect(registry.driverIds).toEqual([])
    await expect(Effect.runPromise(registry.resolve('missing'))).rejects.toMatchObject({
      _tag: 'AgentDriverError',
      code: 'driver-unavailable',
    })
  })

  it('resolves registered drivers without connecting and lists their ids', async () => {
    const first = makeDriver('first')
    const second = makeDriver('second')
    const registry = AgentDriverRegistry.fromDrivers([first, second])

    expect(registry.driverIds).toEqual(['first', 'second'])
    expect(await Effect.runPromise(registry.resolve('first'))).toBe(first)
    expect(await Effect.runPromise(registry.resolve('second'))).toBe(second)
  })
})

describe('AgentDriverRegistryLive', () => {
  it('exposes all three production drivers without starting native resources', async () => {
    let spawnCalls = 0
    const spawner = ChildProcessSpawner.make(() => {
      spawnCalls += 1
      return Effect.die(new Error('Building the registry must not spawn a process'))
    })
    const layer = AgentDriverRegistryLive.pipe(
      Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    )
    const driverIds = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* AgentDriverRegistry
        const drivers = yield* Effect.forEach(registry.driverIds, registry.resolve)
        return drivers.map(driver => driver.driverId)
      }).pipe(Effect.provide(layer)),
    )

    expect(driverIds).toEqual(['codex-app-server', 'claude-agent-sdk', 'acp'])
    expect(spawnCalls).toBe(0)
  })
})
