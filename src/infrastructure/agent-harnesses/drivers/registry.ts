import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import { AgentDriver } from '@/core/ports/agent-driver.js'
import { AgentDriverRegistry } from '@/core/ports/agent-driver-registry.js'
import { layerAcpAgentDriver } from '@/infrastructure/agent-harnesses/drivers/acp/driver.js'
import { ClaudeAgentDriverLive } from '@/infrastructure/agent-harnesses/drivers/claude/driver.js'
import { codexAgentDriverLayer } from '@/infrastructure/agent-harnesses/drivers/codex/driver.js'

export const agentDriverRegistryLayer = (options: { readonly runtimeExecutable?: string } = {}) =>
  Layer.effect(
    AgentDriverRegistry,
    Effect.gen(function* () {
      const codex = yield* Effect.provide(AgentDriver, codexAgentDriverLayer)
      const claude = yield* Effect.provide(AgentDriver, ClaudeAgentDriverLive)
      const acp = yield* Effect.provide(
        AgentDriver,
        layerAcpAgentDriver({ runtimeExecutable: options.runtimeExecutable }),
      )
      return AgentDriverRegistry.fromDrivers([codex, claude, acp])
    }),
  )

export const AgentDriverRegistryLive = agentDriverRegistryLayer()
