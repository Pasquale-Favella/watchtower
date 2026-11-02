import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'

import { agentDriverAccessModes, AgentDriverError } from '@/core/ports/agent-driver.js'
import type { AgentDriverRegistry } from '@/core/ports/agent-driver-registry.js'
import { HarnessConnectionResolutionError, HarnessConnectionResolver } from '@/core/ports/harness-connections.js'
import type { HarnessConnection } from '@/shared/schemas/harness-connections.js'
import type { WorkspaceConnectionInspection } from '@/shared/schemas/workspace-connections.js'

export interface ConnectionInspectionOptions {
  readonly initializeDeadlineMs?: number
  readonly cleanupDeadlineMs?: number
}

export class ConnectionInspectionError extends Schema.TaggedError<ConnectionInspectionError>()(
  'ConnectionInspectionError',
  {
    message: Schema.Literals([
      'Connection inspection failed.',
      'Connection inspection timed out.',
      'Connection identity did not match the selected installation.',
      'Connection cleanup could not be confirmed.',
    ]),
  },
) {}

const timed = Effect.fnUntraced(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  deadlineMs: number,
  message: ConnectionInspectionError['message'],
) {
  return yield* Effect.timeoutOption(effect, `${deadlineMs} millis`).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new ConnectionInspectionError({ message })),
        onSome: Effect.succeed,
      }),
    ),
  )
})

/** Inspect one selected immutable catalog entry in a short-lived Scope. */
export const inspectWorkspaceConnection = Effect.fn('inspectWorkspaceConnection')(function* (
  catalog: ReadonlyArray<HarnessConnection>,
  drivers: AgentDriverRegistry['Service'],
  connectionId: string,
  options: ConnectionInspectionOptions = {},
): Effect.fn.Return<
  WorkspaceConnectionInspection,
  ConnectionInspectionError | AgentDriverError | HarnessConnectionResolutionError
> {
  const initializeDeadlineMs = options.initializeDeadlineMs ?? 15_000
  const cleanupDeadlineMs = options.cleanupDeadlineMs ?? 5_000
  const selected = catalog.find(connection => connection.id === connectionId)
  if (!selected) return yield* new ConnectionInspectionError({ message: 'Connection inspection failed.' })

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const resolverLayer = HarnessConnectionResolver.layer([selected])
      const resolverContext = yield* Layer.build(resolverLayer)
      const resolver = Context.get(resolverContext, HarnessConnectionResolver)
      const driver = yield* drivers.resolve(selected.driverId)
      const options = yield* resolver.resolve(connectionId, selected.driverId)
      const connection = yield* timed(driver.connect(options), initializeDeadlineMs, 'Connection inspection timed out.')
      let cleanupConfirmed = false
      const closeConnection = Effect.fnUntraced(function* () {
        const result = yield* Effect.exit(
          Effect.timeoutOption(connection.close(cleanupDeadlineMs), `${cleanupDeadlineMs} millis`),
        )
        if (result._tag === 'Failure' || Option.isNone(result.value))
          return yield* new ConnectionInspectionError({ message: 'Connection cleanup could not be confirmed.' })
        cleanupConfirmed = true
      })
      const scope = yield* Effect.scope
      yield* Scope.addFinalizerExit(scope, () =>
        Effect.suspend(() => (cleanupConfirmed ? Effect.void : closeConnection())).pipe(Effect.orDie),
      )
      if (connection.identity.id !== connectionId || connection.identity.driverId !== selected.driverId) {
        yield* closeConnection()
        return yield* new ConnectionInspectionError({
          message: 'Connection identity did not match the selected installation.',
        })
      }

      const discovered = yield* Effect.exit(
        timed(connection.discover(), initializeDeadlineMs, 'Connection inspection timed out.'),
      )
      yield* closeConnection()
      if (discovered._tag === 'Failure') return yield* Effect.failCause(discovered.cause)

      const capabilities = discovered.value
      const protocolState: 'initialized' | 'not-established' =
        selected.driverId === 'claude-agent-sdk' ? 'not-established' : 'initialized'
      const choices: 'unknown' | 'session-scoped' = selected.driverId === 'acp' ? 'session-scoped' : 'unknown'
      return {
        connectionId,
        driverId: selected.driverId,
        protocol: {
          state: protocolState,
          ...(protocolState === 'initialized' && connection.identity.protocolVersion
            ? { version: connection.identity.protocolVersion }
            : {}),
        },
        authentication: 'unknown' as const,
        accessModes: agentDriverAccessModes(driver),
        capabilities: {
          openSession: capabilities.openSession,
          loadSession: capabilities.loadSession,
          submit: capabilities.submit,
          interrupt: capabilities.interrupt,
          steer: capabilities.steer,
          respond: capabilities.respond,
          reconcile: capabilities.reconcile,
          models: {
            state: capabilities.models.length ? ('connection-scoped' as const) : choices,
            items: capabilities.models,
          },
          modes: {
            state: capabilities.modes.length ? ('connection-scoped' as const) : choices,
            items: capabilities.modes,
          },
          ...(capabilities.promptContent ? { promptContent: capabilities.promptContent } : {}),
        },
      }
    }),
  )
})
