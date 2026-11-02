import { RegistryContext, useAtomSet, useAtomValue } from '@effect/atom-react'
import * as Option from 'effect/Option'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import { useContext, useEffect } from 'react'

import { ApplicationClient } from '@/renderer/shared/lib/application-rpc.js'
import { pinWindowAtom, querySnapshot } from '@/renderer/stores/hooks/use-remote-query.js'

import { inspectWorkspaceConnectionAtom } from './connection-atoms.js'

const connectionListRequest = {}
const workspaceConnections = ApplicationClient.query('workspace:listConnections', connectionListRequest, {
  serializationKey: 'workspace-connections',
})
const workspaceConnectionsResult = Atom.keepAlive(Atom.readable(get => get(workspaceConnections)))

/** Reads the inert detected catalog without opening Workspace storage. */
export function useWorkspaceConnections() {
  const registry = useContext(RegistryContext)
  useEffect(() => pinWindowAtom(registry, workspaceConnectionsResult), [registry])
  const result = useAtomValue(workspaceConnectionsResult)
  return querySnapshot(result)
}

/** Inspects exactly one selected connection and exposes only renderer-safe evidence. */
export function useInspectWorkspaceConnection() {
  const registry = useContext(RegistryContext)
  useEffect(() => pinWindowAtom(registry, inspectWorkspaceConnectionAtom), [registry])
  const result = useAtomValue(inspectWorkspaceConnectionAtom)
  const execute = useAtomSet(inspectWorkspaceConnectionAtom, { mode: 'promise' })
  const snapshot = querySnapshot(result)
  return {
    execute: (input: { readonly connectionId: string }) => execute(input),
    pending: result.waiting,
    data: Option.getOrNull(AsyncResult.value(result)),
    error: snapshot.error,
  }
}
