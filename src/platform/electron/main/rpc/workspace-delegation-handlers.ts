import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'

import { WorkspaceHost } from '@/platform/electron/main/workspace/host.js'
import { WorkspaceDelegationRpcGroup } from '@/shared/rpc/workspace-delegations.js'
import { DelegationError } from '@/shared/schemas/delegation.js'

/** Any failure outside the delegation contract is reported as unavailable, with no internal detail. */
function safe<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, DelegationError, R> {
  return effect.pipe(
    Effect.catchCause(cause => {
      const error = Cause.findError(cause)
      if (error._tag === 'Success' && Schema.is(DelegationError)(error.success)) return Effect.fail(error.success)
      return Effect.fail(new DelegationError({ code: 'unavailable', message: 'Delegation is unavailable.' }))
    }),
  )
}

export const workspaceDelegationHandlers = Layer.unwrap(
  Effect.gen(function* () {
    const host = yield* WorkspaceHost
    const ready = <A, E, R>(effect: Effect.Effect<A, E, R>) => safe(Effect.andThen(host.ensureOpen, effect))
    return WorkspaceDelegationRpcGroup.toLayer({
      'delegation:list': ({ parentTaskId, parentRunId, limit }) =>
        ready(
          host.withExecution((_execution, _ownerEpoch, delegations) =>
            delegations.listForTask({ taskId: parentTaskId, runId: parentRunId, limit: limit ?? 50 }),
          ),
        ),
      'delegation:get': ({ delegationId }) =>
        ready(
          host.store.getDelegation(delegationId).pipe(
            Effect.flatMap(record =>
              record
                ? Effect.succeed(record)
                : Effect.fail(new DelegationError({ code: 'not-found', message: 'Delegation was not found.' })),
            ),
          ),
        ),
      'delegation:cancel': ({ delegationId }) =>
        ready(
          host.withExecution((_execution, _ownerEpoch, delegations) => delegations.cancelFromUser(delegationId)),
        ),
    })
  }),
)
