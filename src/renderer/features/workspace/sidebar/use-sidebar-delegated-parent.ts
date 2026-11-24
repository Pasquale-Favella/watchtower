import { useAtomValue } from '@effect/atom-react'
import * as Option from 'effect/Option'
import * as AsyncResult from 'effect/reactivity/AsyncResult'

import type { ProjectId, TaskId } from '@/shared/schemas/workspace.js'

import { workspaceTask } from '../atoms.js'

export function useSidebarDelegatedParent(projectId: ProjectId | null, taskId: TaskId | null): TaskId | undefined {
  const detail = Option.getOrUndefined(AsyncResult.value(useAtomValue(workspaceTask.resultAtom)))
  if (detail?.task.id === taskId && detail.task.projectId === projectId) return detail.delegatedFrom?.parentTaskId
  return undefined
}
