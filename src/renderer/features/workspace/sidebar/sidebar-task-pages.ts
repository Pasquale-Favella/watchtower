import type { ProjectId, TaskId } from '@/shared/schemas/workspace.js'
import type { WorkspaceTaskReadPage } from '@/shared/schemas/workspace-store.js'

import { appendUniquePage } from '../project-ui.js'

export type SidebarTaskPage = WorkspaceTaskReadPage
export type SidebarTask = SidebarTaskPage['items'][number]

/** Every loaded cursor page of one Project's chats, merged by identity. */
export type LoadedTaskGroup = {
  readonly items: SidebarTaskPage['items']
  readonly nextAfterId: TaskId | null
  readonly pages: Readonly<Record<string, SidebarTaskPage>>
}

export type LoadedTasksByProject = Readonly<Record<string, LoadedTaskGroup>>

export const SIDEBAR_TASK_PAGE_SIZE = 30
const FIRST_TASK_PAGE_KEY = '\u0000first'

export function taskPageKey(afterId: string | null): string {
  return afterId ?? FIRST_TASK_PAGE_KEY
}

export function nextUnloadedTaskCursor(pages: Readonly<Record<string, SidebarTaskPage>>): TaskId | null {
  let cursor: TaskId | null = null
  const visited = new Set<string>()
  while (true) {
    const key = taskPageKey(cursor)
    if (visited.has(key)) return cursor
    visited.add(key)
    const page = pages[key]
    if (!page?.nextAfterId) return null
    cursor = page.nextAfterId
    if (pages[taskPageKey(cursor)] === undefined) return cursor
  }
}

/** Records one refreshed page for a Project and recomputes its merged chats and next cursor. */
export function withTasksPage(
  current: LoadedTasksByProject,
  projectId: ProjectId,
  afterId: string | null,
  page: SidebarTaskPage,
): LoadedTasksByProject {
  const pages = { ...current[projectId]?.pages, [taskPageKey(afterId)]: page }
  const items = Object.values(pages).reduce<SidebarTaskPage['items']>(
    (loaded, pageValue) => appendUniquePage(loaded, pageValue.items),
    [],
  )
  return { ...current, [projectId]: { items, nextAfterId: nextUnloadedTaskCursor(pages), pages } }
}

/** The cursor to request next for a Project, or null when every page is loaded or one is already requested. */
export function nextTaskCursorToRequest(
  group: LoadedTaskGroup | undefined,
  requested: ReadonlyArray<string | null>,
): TaskId | null {
  const next = group?.nextAfterId ?? null
  return next && !requested.includes(next) ? next : null
}
