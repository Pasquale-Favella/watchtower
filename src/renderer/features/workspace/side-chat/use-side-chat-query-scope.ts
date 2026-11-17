import { RegistryContext } from '@effect/atom-react'
import type * as Atom from 'effect/reactivity/Atom'
import { useContext, useLayoutEffect, useMemo } from 'react'

import * as workspace from '../atoms.js'

const mutableQueries = [
  'workspaceStatus',
  'workspaceProjects',
  'workspaceProject',
  'workspaceTasks',
  'workspaceTask',
  'workspaceTaskSnapshot',
  'workspaceNativeAgentSessions',
  'workspaceRequests',
  'workspaceRequestResponses',
  'workspaceSteerIntents',
  'workspaceFollowUps',
  'workspaceBranches',
] as const
const allQueries = [...mutableQueries, 'workspaceConversation', 'workspacePayload'] as const
/** Each embedded conversation selects its own reads while using the window's event subscription. */
export function useSideChatQueryScope(): ReadonlyMap<object, object> {
  const registry = useContext(RegistryContext)
  const scoped = useMemo(() => workspace.createWorkspaceAtoms(), [])
  useLayoutEffect(() => {
    const release = workspace.registerScopedWorkspaceQueries(mutableQueries.map(name => scoped[name]))
    return () => {
      release()
      for (const name of allQueries) registry.set(scoped[name].resetAtom as Atom.Writable<unknown, void>, undefined)
    }
  }, [registry, scoped])
  return useMemo(() => new Map<object, object>(allQueries.map(name => [workspace[name], scoped[name]])), [scoped])
}
