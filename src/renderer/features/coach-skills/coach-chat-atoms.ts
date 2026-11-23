import * as Atom from 'effect/reactivity/Atom'

import { ApplicationClient } from '@/renderer/shared/lib/application-rpc.js'
import { createRpcQuerySlot } from '@/renderer/stores/atoms/rpc-query.js'

export const coachChatRequest = {}
export const coachChatKey = () => 'coach-chat'
export const coachChatQuery = createRpcQuerySlot({
  key: coachChatKey,
  query: (_: typeof coachChatRequest, serializationKey) =>
    ApplicationClient.query('workspace:getCoachChat', {}, { serializationKey }),
})
/**
 * True from the moment the first message of a new chat is sent until its Run is admitted. It lives in the registry, not
 * in the composer, so New chat stays disabled even after the composer unmounts when the chat appears.
 */
export const coachChatStartingAtom = Atom.keepAlive(Atom.make(false))
export const saveSkillAtom = ApplicationClient.mutation('skills:save')
export const discardCoachChatAtom = ApplicationClient.mutation('workspace:discardCoachChat')
