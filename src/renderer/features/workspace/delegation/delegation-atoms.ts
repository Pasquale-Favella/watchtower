import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import { RpcClientError } from 'effect/rpc/RpcClientError'

import { ApplicationClient, ApplicationProtocolLayer } from '@/renderer/shared/lib/application-rpc.js'
import type { DelegationError, DelegationId, DelegationList, DelegationRecord } from '@/shared/schemas/delegation.js'
import type { TaskId } from '@/shared/schemas/workspace.js'

const runtime = ApplicationClient.runtime.factory(get =>
  Layer.merge(get(ApplicationClient.runtime.layer), ApplicationProtocolLayer),
)

/** Delegated Tasks started by one parent Task, newest state from the application store. */
export const delegationListAtom = Atom.family((parentTaskId: TaskId) =>
  ApplicationClient.query('delegation:list', { parentTaskId }, { serializationKey: `delegations:${parentTaskId}` }),
)

export const delegationRecordAtom = Atom.family((delegationId: DelegationId) =>
  ApplicationClient.query('delegation:get', { delegationId }, { serializationKey: `delegation:${delegationId}` }),
)

export const cancelDelegationAtom = () =>
  runtime.fn<{ readonly commandId: string; readonly delegationId: DelegationId }>()(
    request => Effect.flatMap(ApplicationClient, client => client('delegation:cancel', request)),
    { concurrent: true },
  )

/** A one-off read of the whole record, for an action that must not act on the list's result preview. */
export const readDelegationAtom = () =>
  runtime.fn<{ readonly delegationId: DelegationId }>()(
    request => Effect.flatMap(ApplicationClient, client => client('delegation:get', request)),
    { concurrent: true },
  )

export const emptyDelegationListAtom = Atom.make(AsyncResult.success<DelegationList>({ items: [], truncated: false }))

export const idleDelegationRecordAtom = Atom.make(
  AsyncResult.initial<DelegationRecord, DelegationError | RpcClientError>(),
)
