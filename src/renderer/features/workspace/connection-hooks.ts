import { RegistryContext, useAtomValue } from '@effect/atom-react'
import type * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import { useContext, useEffect, useRef } from 'react'

import { ApplicationClient } from '@/renderer/shared/lib/application-rpc.js'
import { pinWindowAtom, querySnapshot } from '@/renderer/stores/hooks/use-remote-query.js'
import type { WorkspaceConnection, WorkspaceConnectionInspection } from '@/shared/schemas/workspace-connections.js'

import { connectionInspectionAtom, idleConnectionInspectionAtom, inspectionFocusAtom } from './connection-atoms.js'
import { readInspection } from './model-picker/inspection-family.js'

const connectionListRequest = {}
const workspaceConnections = ApplicationClient.query('workspace:listConnections', connectionListRequest, {
  serializationKey: 'workspace-connections',
})
const workspaceConnectionsResult = Atom.keepAlive(Atom.readable(get => get(workspaceConnections)))

type InspectionAtom = Atom.Atom<AsyncResult.AsyncResult<WorkspaceConnectionInspection, unknown>>

function inspectionAtom(connectionId: string | null): InspectionAtom {
  return connectionId ? connectionInspectionAtom(connectionId) : idleConnectionInspectionAtom
}

/** Reads the inert detected catalog without opening Workspace storage. */
export function useWorkspaceConnections() {
  const registry = useContext(RegistryContext)
  useEffect(() => pinWindowAtom(registry, workspaceConnectionsResult), [registry])
  const result = useAtomValue(workspaceConnectionsResult)
  return querySnapshot(result)
}

export interface WorkspaceConnectionCatalog {
  readonly inspection: WorkspaceConnectionInspection | null
  readonly pending: boolean
  readonly failed: boolean
  readonly retry: () => void
}

/** Inspection state of one connection, cached per connection for the app session. Switching back shows the cached
 *  facts at once. A refresh keeps the previous value on screen. A changed connection list re-inspects this one. */
export function useWorkspaceConnectionCatalog(connectionId: string): WorkspaceConnectionCatalog {
  const registry = useContext(RegistryContext)
  const items = useWorkspaceConnections().data?.items ?? null
  const known = items !== null && items.some(item => item.connectionId === connectionId)
  const listKey = items === null ? null : connectionListKey(items)
  const reading = readInspection(useAtomValue(inspectionAtom(known ? connectionId : null)))
  const seenList = useRef<string | null>(null)
  useEffect(() => {
    if (listKey === null) return
    const previous = seenList.current
    seenList.current = listKey
    if (known && previous !== null && previous !== listKey) registry.refresh(connectionInspectionAtom(connectionId))
  }, [connectionId, known, listKey, registry])
  return {
    inspection: reading.value,
    pending: reading.pending,
    failed: reading.failed,
    retry: () => {
      if (known) registry.refresh(connectionInspectionAtom(connectionId))
    },
  }
}

function connectionListKey(items: readonly WorkspaceConnection[]): string {
  return items.map(item => [item.connectionId, item.driverId, item.harnessKind].join('\u0000')).join('\u0001')
}

/** Caller-level inspection of the connection named by the last `execute`. Re-executing the same connection refreshes
 *  it. Choosing another connection reuses its cached inspection when there is one. */
export function useInspectWorkspaceConnection() {
  const registry = useContext(RegistryContext)
  const focus = useAtomValue(inspectionFocusAtom)
  const result = useAtomValue(inspectionAtom(focus || null))
  const reading = readInspection(result)
  return {
    execute: (input: { readonly connectionId: string }): Promise<void> => {
      if (registry.get(inspectionFocusAtom) === input.connectionId) {
        registry.refresh(connectionInspectionAtom(input.connectionId))
      } else {
        registry.set(inspectionFocusAtom, input.connectionId)
      }
      return Promise.resolve()
    },
    pending: reading.pending,
    data: reading.value,
    error: querySnapshot(result).error,
  }
}
