import { useEffect, useMemo } from 'react'

import type { ProjectId } from '@/shared/schemas/workspace.js'

import { useWorkspaceSidebarTasks, type WorkspaceRequest } from '../hooks.js'
import { SIDEBAR_TASK_PAGE_SIZE, type SidebarTaskPage } from './sidebar-task-pages.js'

/** Invisible loader that keeps one cursor page of one Project's chats live in the merged sidebar list. */
export function SidebarTaskPageRefresh({
  projectId,
  afterId,
  onTasksPage,
  onTasksError,
}: {
  readonly projectId: ProjectId
  readonly afterId: string | null
  readonly onTasksPage: (projectId: ProjectId, afterId: string | null, page: SidebarTaskPage) => void
  readonly onTasksError: (projectId: ProjectId, afterId: string | null, error: string | null) => void
}) {
  const request = useMemo<WorkspaceRequest<'workspace:listTasks'>>(
    () => ({
      projectId,
      options: { ...(afterId ? { afterId } : {}), limit: SIDEBAR_TASK_PAGE_SIZE, includeArchived: true },
    }),
    [afterId, projectId],
  )
  const query = useWorkspaceSidebarTasks(projectId, request)
  const page = query.data

  useEffect(() => {
    if (query.status !== 'ready' || !page) return
    onTasksPage(projectId, afterId, {
      ...page,
      items: page.items.filter(task => task.projectId === projectId),
    })
  }, [afterId, onTasksPage, page, projectId, query.status])

  useEffect(() => {
    onTasksError(projectId, afterId, query.error)
    return () => onTasksError(projectId, afterId, null)
  }, [afterId, onTasksError, projectId, query.error])

  return null
}
