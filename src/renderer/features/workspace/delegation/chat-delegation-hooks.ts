import { useAtomValue } from '@effect/atom-react'
import { useMemo } from 'react'

import { querySnapshot } from '@/renderer/stores/hooks/use-remote-query.js'
import type { DelegationRecord } from '@/shared/schemas/delegation.js'
import type { ProjectId, TaskId } from '@/shared/schemas/workspace.js'

import { useWorkspaceTasks } from '../hooks.js'
import { delegationListAtom, emptyDelegationListAtom } from './delegation-atoms.js'

export interface ParentTaskLink {
  readonly title: string
  readonly open: () => void
}

/**
 * Reads the parent from the same Task listing as useDelegatedFrom, which also carries the parent's title. A second
 * Task detail query would compete with the selected Task's detail query, which is one slot per scope.
 */
export function useParentTaskLink(
  projectId: ProjectId | null,
  taskId: TaskId | null,
  openTask?: (taskId: TaskId) => void,
): ParentTaskLink | null {
  const request = useMemo(
    () =>
      projectId && taskId && openTask
        ? { projectId, options: { includeDelegated: true, includeArchived: true, limit: 50 } }
        : null,
    [openTask, projectId, taskId],
  )
  const items = useWorkspaceTasks(request).data?.items
  const parentTaskId = taskId
    ? items?.find(task => task.id === taskId)?.runtime?.delegatedFrom?.parentTaskId
    : undefined
  const title = items?.find(task => task.id === parentTaskId)?.title ?? 'Parent task'
  return useMemo(
    () => (parentTaskId && openTask ? { title, open: () => openTask(parentTaskId) } : null),
    [openTask, parentTaskId, title],
  )
}

export function useChatDelegationsById(taskId: TaskId | null): ReadonlyMap<string, DelegationRecord> {
  const atom = taskId ? delegationListAtom(taskId) : emptyDelegationListAtom
  const items = querySnapshot(useAtomValue(atom)).data?.items
  return useMemo(() => new Map(items?.map(record => [record.id, record])), [items])
}
