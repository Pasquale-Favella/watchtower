import { ChevronDown, ChevronRight, FolderPlus, MessageCircle, Search, SquarePen, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { displayShortcutForAction } from '@/renderer/app/shortcuts'
import { QueryErrorNotice } from '@/renderer/components/QueryErrorNotice'
import { LoadingRegion } from '@/renderer/components/skeletons'
import { Button } from '@/renderer/components/ui/button'
import { Input } from '@/renderer/components/ui/input'
import { Kbd } from '@/renderer/components/ui/kbd'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { TextTooltip } from '@/renderer/components/ui/tooltip'
import { cn } from '@/renderer/shared/lib/utils'
import type { ProjectId, TaskId } from '@/shared/schemas/workspace.js'
import type { WorkspaceProjectReadPage } from '@/shared/schemas/workspace-store.js'

import { useWorkspaceConnections } from './connection-hooks.js'
import {
  resolveSidebarTaskSelection,
  sidebarTaskPresentation,
  type TaskSectionId,
} from './delegation/sidebar-delegation.js'
import { useWorkspaceProject, useWorkspaceProjects, type WorkspaceRequest } from './hooks.js'
import { hasNoUserProjects } from './project-list-state.js'
import { appendUniquePage, compareTaskActivity } from './project-ui.js'
import {
  type LoadedTasksByProject,
  nextTaskCursorToRequest,
  SIDEBAR_TASK_PAGE_SIZE,
  type SidebarTask,
  type SidebarTaskPage,
  taskPageKey,
  withTasksPage,
} from './sidebar/sidebar-task-pages.js'
import { SidebarTaskPageRefresh } from './sidebar/SidebarTaskPageRefresh.js'
import { SidebarTaskRow } from './sidebar/SidebarTaskRow.js'
import { useSidebarDelegatedParent } from './sidebar/use-sidebar-delegated-parent.js'
import { useSidebarModels } from './sidebar/use-sidebar-models.js'
import { useWorkspaceProjectDialog } from './use-project-dialog.js'

const NO_PROJECT_LABEL = 'No project'
const FIRST_PROJECT_PAGE: WorkspaceRequest<'workspace:listProjects'> = { options: { limit: SIDEBAR_TASK_PAGE_SIZE } }
const FIRST_TASK_CURSORS: ReadonlyArray<string | null> = [null]

export interface WorkspaceProjectsProps {
  selectedProjectId: ProjectId | null
  selectedTaskId: TaskId | null
  onSelectProject: (projectId: ProjectId | null) => void
  onSelectTask: (taskId: TaskId | null) => void
  onNewChat?: (projectId: ProjectId | null) => void
}

const TASK_SECTIONS: ReadonlyArray<{ readonly id: TaskSectionId; readonly label: string }> = [
  { id: 'attention', label: 'Needs attention' },
  { id: 'working', label: 'Working' },
  { id: 'open', label: 'Ready' },
  { id: 'inProgress', label: 'In progress' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'inReview', label: 'In review' },
  { id: 'completed', label: 'Completed' },
  { id: 'archived', label: 'Archived' },
]

function taskSectionIsCollapsedByDefault(sectionId: TaskSectionId): boolean {
  return sectionId === 'completed' || sectionId === 'archived'
}

function projectLabel(project: WorkspaceProjectReadPage['items'][number] | undefined): string {
  return !project || project.isScratch === true ? NO_PROJECT_LABEL : project.name
}

/** Every loaded chat across Projects in one list, grouped by status; each card names its Project. */
export function WorkspaceProjects({
  selectedProjectId,
  selectedTaskId,
  onSelectProject,
  onSelectTask,
  onNewChat,
}: WorkspaceProjectsProps) {
  const [projectRequest, setProjectRequest] = useState(FIRST_PROJECT_PAGE)
  const projectsQuery = useWorkspaceProjects(projectRequest)
  const [projects, setProjects] = useState<WorkspaceProjectReadPage['items']>([])
  const selectedProjectQuery = useWorkspaceProject(selectedProjectId ? { projectId: selectedProjectId } : null)
  const [loadedTasks, setLoadedTasks] = useState<LoadedTasksByProject>({})
  const [taskCursors, setTaskCursors] = useState<Readonly<Record<string, ReadonlyArray<string | null>>>>({})
  const [taskErrors, setTaskErrors] = useState<
    Readonly<Record<string, { readonly projectId: ProjectId; readonly error: string }>>
  >({})
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<TaskSectionId>>(
    () =>
      new Set(TASK_SECTIONS.filter(section => taskSectionIsCollapsedByDefault(section.id)).map(section => section.id)),
  )
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [search, setSearch] = useState('')
  const projectDialog = useWorkspaceProjectDialog()
  const addProjectShortcut = displayShortcutForAction('addProject')
  const delegatedParentId = useSidebarDelegatedParent(selectedProjectId, selectedTaskId)
  const connectionsQuery = useWorkspaceConnections()
  const connectionsById = useMemo(
    () => new Map((connectionsQuery.data?.items ?? []).map(connection => [connection.connectionId, connection])),
    [connectionsQuery.data?.items],
  )
  const projectPage = projectsQuery.data
  const catalogConnectionIds = useMemo(() => {
    const ids = new Set<string>()
    for (const group of Object.values(loadedTasks)) {
      for (const task of group.items) {
        const id = task.runtime.latestRun?.connectionId
        if (id && connectionsById.has(id)) ids.add(id)
      }
    }
    return [...ids].sort()
  }, [connectionsById, loadedTasks])
  const modelsByConnection = useSidebarModels(catalogConnectionIds)

  useEffect(() => {
    const page = projectsQuery.data
    if (projectsQuery.status !== 'ready' || !page) return
    setProjects(previous => appendUniquePage(previous, page.items))
  }, [projectsQuery.data, projectsQuery.status])

  useEffect(() => {
    const restored = selectedProjectQuery.data?.project
    if (restored)
      setProjects(previous => {
        const existing = previous.find(project => project.id === restored.id)
        return appendUniquePage(previous, [
          {
            ...restored,
            runtime: existing?.runtime ?? { attentionCount: 0, workingCount: 0 },
          },
        ])
      })
    if (selectedProjectId && selectedProjectQuery.error) onSelectProject(null)
  }, [onSelectProject, selectedProjectId, selectedProjectQuery.data, selectedProjectQuery.error])

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const rememberTasksPage = useCallback((projectId: ProjectId, afterId: string | null, page: SidebarTaskPage) => {
    setLoadedTasks(current => withTasksPage(current, projectId, afterId, page))
  }, [])

  const rememberTasksError = useCallback((projectId: ProjectId, afterId: string | null, error: string | null) => {
    const key = `${projectId}:${taskPageKey(afterId)}`
    setTaskErrors(current => {
      if ((current[key]?.error ?? null) === error) return current
      if (error) return { ...current, [key]: { projectId, error } }
      return Object.fromEntries(Object.entries(current).filter(([entryKey]) => entryKey !== key))
    })
  }, [])

  const projectsById = useMemo(() => new Map(projects.map(project => [project.id, project])), [projects])
  const cursorsFor = useCallback((projectId: ProjectId) => taskCursors[projectId] ?? FIRST_TASK_CURSORS, [taskCursors])
  const requestTaskCursor = useCallback((projectId: ProjectId, cursor: TaskId) => {
    setTaskCursors(current => {
      const requested = current[projectId] ?? FIRST_TASK_CURSORS
      return requested.includes(cursor) ? current : { ...current, [projectId]: [...requested, cursor] }
    })
  }, [])

  const showNoProjects = hasNoUserProjects(projects, Boolean(projectPage?.nextAfterId))
  const searchTerm = search.trim().toLocaleLowerCase()
  const searching = searchTerm.length > 0
  const allTasks = useMemo(
    () => projects.flatMap(project => loadedTasks[project.id]?.items ?? []),
    [loadedTasks, projects],
  )
  const selectedProjectTasks = selectedProjectId ? (loadedTasks[selectedProjectId]?.items ?? []) : []
  const activeTaskId = resolveSidebarTaskSelection(selectedTaskId, delegatedParentId, selectedProjectTasks)
  const activeTask = selectedProjectTasks.find(task => task.id === activeTaskId)
  const revealSection = delegatedParentId && activeTask ? sidebarTaskPresentation(activeTask).section : undefined
  const selectedProjectGroup = selectedProjectId ? loadedTasks[selectedProjectId] : undefined
  const delegatedParentCursor =
    delegatedParentId && selectedProjectId && !activeTask
      ? nextTaskCursorToRequest(selectedProjectGroup, cursorsFor(selectedProjectId))
      : null

  // A Delegated Task's parent row may sit on a later page: keep paging that Project until it is listed.
  useEffect(() => {
    if (selectedProjectId && delegatedParentCursor) requestTaskCursor(selectedProjectId, delegatedParentCursor)
  }, [delegatedParentCursor, requestTaskCursor, selectedProjectId])

  useEffect(() => {
    if (!revealSection) return
    setCollapsedSections(current => {
      if (!current.has(revealSection)) return current
      const next = new Set(current)
      next.delete(revealSection)
      return next
    })
  }, [revealSection, selectedTaskId])

  const newChat = () => {
    onSelectProject(null)
    onSelectTask(null)
    onNewChat?.(null)
  }

  const selectTask = (taskId: TaskId, projectId: ProjectId) => {
    onSelectProject(projectId)
    onSelectTask(taskId)
  }

  const toggleSection = (sectionId: TaskSectionId) => {
    setCollapsedSections(current => {
      const next = new Set(current)
      if (next.has(sectionId)) next.delete(sectionId)
      else next.add(sectionId)
      return next
    })
  }

  const loadMoreChats = () => {
    for (const project of projects) {
      const cursor = nextTaskCursorToRequest(loadedTasks[project.id], cursorsFor(project.id))
      if (cursor) requestTaskCursor(project.id, cursor)
    }
  }

  const visibleTasks = searching
    ? allTasks.filter(
        task =>
          (delegatedParentId && task.id === activeTaskId) ||
          task.title.toLocaleLowerCase().includes(searchTerm) ||
          projectLabel(projectsById.get(task.projectId)).toLocaleLowerCase().includes(searchTerm),
      )
    : allTasks
  const tasksBySection = new Map<
    TaskSectionId,
    { task: SidebarTask; presentation: ReturnType<typeof sidebarTaskPresentation> }[]
  >()
  for (const task of visibleTasks) {
    const presentation = sidebarTaskPresentation(task)
    const bucket = tasksBySection.get(presentation.section)
    if (bucket) bucket.push({ task, presentation })
    else tasksBySection.set(presentation.section, [{ task, presentation }])
  }
  const visibleSections = TASK_SECTIONS.map(section => ({
    ...section,
    tasks: tasksBySection.get(section.id)?.sort((left, right) => compareTaskActivity(left.task, right.task)) ?? [],
  })).filter(section => section.tasks.length > 0)

  const failedProjectIds = new Set(Object.values(taskErrors).map(failure => failure.projectId))
  const tasksStillLoading = projects.some(
    project => loadedTasks[project.id] === undefined && !failedProjectIds.has(project.id),
  )
  const taskError = Object.values(taskErrors)[0]?.error ?? null
  const canLoadMoreChats = projects.some(project => loadedTasks[project.id]?.nextAfterId)
  const projectCanLoadMore = Boolean(projectPage?.nextAfterId)
  const initialLoading =
    (projectsQuery.status === 'loading' && projects.length === 0) || (allTasks.length === 0 && tasksStillLoading)

  return (
    <section aria-label="Chats" className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-1.5 px-2 pb-2">
        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden="true"
            className="text-sidebar-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
          />
          <Input
            type="search"
            aria-label="Search loaded chats"
            placeholder="Search"
            value={search}
            onChange={event => setSearch(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape' && search) {
                event.preventDefault()
                setSearch('')
              }
            }}
            className="bg-sidebar-accent/50 focus-visible:border-sidebar-border focus-visible:bg-sidebar h-8 rounded-md border-transparent pr-8 pl-8 text-xs shadow-none"
          />
          {search && (
            <TextTooltip
              label="Clear search"
              trigger={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Clear search"
                  className="absolute top-1/2 right-1 -translate-y-1/2"
                  onClick={() => setSearch('')}
                >
                  <X className="size-3.5" />
                </Button>
              }
            />
          )}
        </div>
        <TextTooltip
          label="New chat"
          trigger={
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="New chat"
              disabled={!onNewChat}
              onClick={newChat}
            >
              <SquarePen className="size-4" />
            </Button>
          }
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Add project"
                onClick={projectDialog.open}
              >
                <FolderPlus className="size-4" />
              </Button>
            }
          />
          <TooltipContent>
            Add project
            {addProjectShortcut && <Kbd>{addProjectShortcut}</Kbd>}
          </TooltipContent>
        </Tooltip>
      </header>

      {projectDialog.notice && (
        <p role="status" className="text-sidebar-muted-foreground px-3 pb-2 text-xs">
          {projectDialog.notice}
        </p>
      )}
      {searching && (
        <p role="status" className="text-sidebar-muted-foreground px-3 pb-2 text-[10px]">
          Search covers loaded chats and Project names only. Load more to search additional results.
        </p>
      )}
      <QueryErrorNotice error={projectsQuery.error} hasData={projects.length > 0} />

      {projects.map(project =>
        cursorsFor(project.id).map(afterId => (
          <SidebarTaskPageRefresh
            key={`${project.id}:${afterId ?? 'first'}`}
            projectId={project.id}
            afterId={afterId}
            onTasksPage={rememberTasksPage}
            onTasksError={rememberTasksError}
          />
        )),
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <QueryErrorNotice error={taskError} hasData={allTasks.length > 0} />
        {initialLoading ? (
          <LoadingRegion label="Loading chats…" className="px-2 py-3">
            <ChatRowsSkeleton rows={4} />
          </LoadingRegion>
        ) : (
          visibleSections.length > 0 && (
            <div aria-label="Chats by status" className="space-y-1">
              {visibleSections.map(section => {
                const collapsed = !searching && collapsedSections.has(section.id)
                const selectedTask = section.tasks.find(({ task }) => task.id === activeTaskId)
                const displayedTasks = collapsed ? (selectedTask ? [selectedTask] : []) : section.tasks
                return (
                  <section key={section.id} aria-label={`${section.label}, ${section.tasks.length} loaded`}>
                    <button
                      type="button"
                      aria-expanded={!collapsed}
                      aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${section.label}, ${section.tasks.length} loaded`}
                      onClick={() => toggleSection(section.id)}
                      disabled={searching}
                      className="text-sidebar-muted-foreground hover:text-sidebar-foreground focus-visible:ring-ring flex h-7 w-full items-center gap-1.5 rounded px-1 text-left text-[10px] font-semibold tracking-wide uppercase outline-none focus-visible:ring-2"
                    >
                      {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
                      <span className="min-w-0 flex-1 truncate">{section.label}</span>
                      <span className="tabular-nums">{section.tasks.length}</span>
                    </button>
                    {displayedTasks.length > 0 && (
                      <ul className="space-y-0.5">
                        {displayedTasks.map(({ task, presentation }) => (
                          <SidebarTaskRow
                            key={task.id}
                            task={task}
                            projectLabel={projectLabel(projectsById.get(task.projectId))}
                            scratch={projectLabel(projectsById.get(task.projectId)) === NO_PROJECT_LABEL}
                            selected={task.id === activeTaskId}
                            revealForTaskId={
                              !collapsed && delegatedParentId && task.id === activeTaskId ? selectedTaskId : null
                            }
                            presentation={presentation}
                            sectionLabel={section.label}
                            nowMs={nowMs}
                            connectionsById={connectionsById}
                            modelsByConnection={modelsByConnection}
                            onSelectTask={selectTask}
                          />
                        ))}
                      </ul>
                    )}
                  </section>
                )
              })}
            </div>
          )
        )}

        {!searching && projectsQuery.status === 'ready' && showNoProjects && (
          <div className="flex flex-col items-start gap-2 px-2 py-3">
            <p className="text-sidebar-muted-foreground text-xs">No projects yet</p>
            <Button type="button" variant="outline" size="sm" onClick={projectDialog.open}>
              Add project
              {addProjectShortcut && <Kbd>{addProjectShortcut}</Kbd>}
            </Button>
          </div>
        )}

        {!searching && !initialLoading && !showNoProjects && allTasks.length === 0 && !taskError && (
          <p className="text-sidebar-muted-foreground px-2 py-3 text-xs">No chats yet</p>
        )}

        {searching && visibleTasks.length === 0 && !tasksStillLoading && (
          <p className="text-sidebar-muted-foreground px-2 py-3 text-xs" role="status">
            No loaded chats match Search.
          </p>
        )}

        {canLoadMoreChats && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="my-1 h-7 w-full justify-start text-xs"
            onClick={loadMoreChats}
          >
            <MessageCircle className="size-3.5" />
            Load more chats
          </Button>
        )}

        {projectCanLoadMore && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="my-1 h-7 w-full justify-start text-xs"
            onClick={() => {
              const afterId = projectPage?.nextAfterId
              if (afterId) setProjectRequest({ options: { afterId, limit: SIDEBAR_TASK_PAGE_SIZE } })
            }}
          >
            <FolderPlus className="size-3.5" />
            Load chats from more Projects
          </Button>
        )}
      </div>
    </section>
  )
}

/** Sidebar chat-list placeholder: glyph-sized square + two text-bar lines, matching the chat cards. */
function ChatRowsSkeleton({ rows, className }: { rows: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex items-start gap-2">
          <Skeleton className="size-4 shrink-0 rounded-sm" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className={cn('h-3', row % 2 === 0 ? 'w-4/5' : 'w-3/5')} />
            <Skeleton className="h-2.5 w-2/5" />
          </div>
        </div>
      ))}
    </div>
  )
}
