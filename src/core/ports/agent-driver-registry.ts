import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'

import { type AgentDriver, AgentDriverError } from '@/core/ports/agent-driver.js'

export class AgentDriverRegistry extends Context.Service<
  AgentDriverRegistry,
  {
    readonly driverIds: ReadonlyArray<string>
    readonly resolve: (driverId: string) => Effect.Effect<AgentDriver['Service'], AgentDriverError>
  }
>()('watchtower/core/AgentDriverRegistry') {
  /** Pure construction; duplicate ids throw AgentDriverError with code invalid-state. */
  static readonly fromDrivers = (drivers: ReadonlyArray<AgentDriver['Service']>): AgentDriverRegistry['Service'] => {
    const byId = new Map<string, AgentDriver['Service']>()
    for (const driver of drivers) {
      if (byId.has(driver.driverId)) {
        throw new AgentDriverError({
          code: 'invalid-state',
          message: `Agent driver is registered more than once: ${driver.driverId}`,
        })
      }
      byId.set(driver.driverId, driver)
    }
    return AgentDriverRegistry.of({
      driverIds: Object.freeze(Array.from(byId.keys())),
      resolve: Effect.fn('AgentDriverRegistry.resolve')(function* (driverId: string) {
        const driver = byId.get(driverId)
        if (!driver) {
          return yield* new AgentDriverError({
            code: 'driver-unavailable',
            message: `Agent driver is not registered: ${driverId}`,
          })
        }
        return driver
      }),
    })
  }
}
