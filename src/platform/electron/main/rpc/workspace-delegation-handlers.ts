import * as Effect from 'effect/Effect'

import { WorkspaceDelegationRpcGroup } from '@/shared/rpc/workspace-delegations.js'
import { DelegationError } from '@/shared/schemas/delegation.js'

const notFound = () => Effect.fail(new DelegationError({ code: 'not-found', message: 'Delegation was not found.' }))

export const workspaceDelegationHandlers = WorkspaceDelegationRpcGroup.toLayer({
  'delegation:list': () => Effect.succeed({ items: [], truncated: false }),
  'delegation:get': notFound,
  'delegation:cancel': notFound,
})
