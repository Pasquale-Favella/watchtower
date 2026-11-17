import { RegistryContext, useAtomSet, useAtomValue } from '@effect/atom-react'
import { useCallback, useContext, useEffect } from 'react'

import type { ConversationId, ProjectId, TaskId } from '@/shared/schemas/workspace.js'

import {
  hydrateWorkspaceNavigation,
  updateWorkspaceNavigationAtom,
  workspaceNavigationAtom,
} from './navigation-atoms.js'

function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/** Shared selection state used by the global sidebar and Workspace view. */
export function useWorkspaceNavigation() {
  const registry = useContext(RegistryContext)
  const navigation = useAtomValue(workspaceNavigationAtom)
  const update = useAtomSet(updateWorkspaceNavigationAtom)

  useEffect(() => {
    hydrateWorkspaceNavigation(registry, browserStorage())
  }, [registry])

  const selectProject = useCallback(
    (projectId: ProjectId | null) => update({ projectId, taskId: null, conversationId: null }),
    [update],
  )
  const selectTask = useCallback((taskId: TaskId | null) => update({ taskId, conversationId: null }), [update])
  const selectConversation = useCallback(
    (conversationId: ConversationId | null) => update({ conversationId }),
    [update],
  )

  return { navigation, selectProject, selectTask, selectConversation }
}
