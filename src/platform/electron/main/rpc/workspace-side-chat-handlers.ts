import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'

import { WorkspaceSideChats } from '@/core/application/commands/workspace-side-chats.js'
import { WorkspaceHost } from '@/platform/electron/main/workspace/host.js'
import { WorkspaceSideChatRpcGroup } from '@/shared/rpc/workspace-side-chats.js'
import { SideChatError } from '@/shared/schemas/workspace-side-chats.js'

function safe<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, SideChatError, R> {
  return effect.pipe(
    Effect.catchCause(cause => {
      const error = Cause.findError(cause)
      if (error._tag === 'Success' && Schema.is(SideChatError)(error.success)) return Effect.fail(error.success)
      return Effect.fail(new SideChatError({ code: 'unavailable', message: 'Side chats are unavailable.' }))
    }),
  )
}
export const workspaceSideChatHandlers = Layer.unwrap(
  Effect.gen(function* () {
    const service = yield* WorkspaceSideChats
    const host = yield* WorkspaceHost
    const ready = <A, E, R>(effect: Effect.Effect<A, E, R>) => safe(Effect.andThen(host.ensureOpen, effect))
    return WorkspaceSideChatRpcGroup.toLayer({
      'sideChat:create': request => ready(service.create(request)),
      'sideChat:get': ({ id }) => ready(service.get(id)),
      'sideChat:list': ({ parentTaskId }) =>
        ready(Effect.map(service.list(parentTaskId), items => ({ items: [...items] }))),
      'sideChat:bringBack': ({ id }) => ready(Effect.map(service.bringBack(id), text => ({ text }))),
    })
  }),
)
