import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'

import { ApplicationClient, ApplicationProtocolLayer } from '@/renderer/shared/lib/application-rpc.js'
import type { CreateSideChatRequest, SideChatBinding } from '@/shared/schemas/workspace-side-chats.js'

const runtime = ApplicationClient.runtime.factory(get =>
  Layer.merge(get(ApplicationClient.runtime.layer), ApplicationProtocolLayer),
)
export const createSideChatAtom = () =>
  runtime.fn<CreateSideChatRequest>()(
    request => Effect.flatMap(ApplicationClient, client => client('sideChat:create', request)),
    { concurrent: true },
  )
export const bringBackSideChatAtom = () =>
  runtime.fn<{ readonly id: string }>()(
    request => Effect.flatMap(ApplicationClient, client => client('sideChat:bringBack', request)),
    { concurrent: true },
  )
export const sideChatBindingAtom = Atom.family((id: string) =>
  ApplicationClient.query('sideChat:get', { id }, { serializationKey: `side-chat:${id}` }),
)
export const sideChatListAtom = Atom.family((parentTaskId: import('@/shared/schemas/workspace.js').TaskId) =>
  ApplicationClient.query('sideChat:list', { parentTaskId }, { serializationKey: `side-chats:${parentTaskId}` }),
)

export const emptySideChatListAtom = Atom.make(
  AsyncResult.success<{ readonly items: readonly SideChatBinding[] }>({ items: [] }),
)
