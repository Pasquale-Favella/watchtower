import { differenceInMinutes } from 'date-fns'
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  MessageCircle,
  Pencil,
  Plus,
  Search,
  SquarePen,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { QueryErrorNotice } from '@/renderer/components/QueryErrorNotice'
import { LoadingRegion } from '@/renderer/components/skeletons'
import { Button } from '@/renderer/components/ui/button'
import { Input } from '@/renderer/components/ui/input'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { TextTooltip } from '@/renderer/components/ui/tooltip'
import { HarnessIcon } from '@/renderer/features/coach-skills/harness-icon.js'
import { cn } from '@/renderer/shared/lib/utils'
import type { ProjectId, TaskId } from '@/shared/schemas/workspace.js'
import type { WorkspaceProjectReadPage, WorkspaceTaskReadPage } from '@/shared/schemas/workspace-store.js'

import { useWorkspaceConnectionCatalog, useWorkspaceConnections } from './connection-hooks.js'
import {
  delegatedChildTotal,
  delegateSignalLabel,
  hasDelegateAttention,
  isDelegatedChild,
} from './delegation/sidebar-delegation.js'
import { SidebarDelegateChildren, SidebarDelegateToggle } from './delegation/SidebarDelegates.js'
import { showErrorToast } from './error-toast.js'
import {
  useRenameTask,
  useSetTaskArchived,
  useWorkspaceProject,
  useWorkspaceProjects,
  useWorkspaceSidebarTasks,
  type WorkspaceRequest,
} from './hooks.js'
import { catalogView, modelDisplayName } from './model-picker/catalog.js'
import { appendUniquePage, compareTaskActivity, taskActivityAt } from './project-ui.js'
import { useWorkspaceProjectDialog } from './use-project-dialog.js'

const PAGE_SIZE = 30
const NO_PROJECT_GROUP = 'no-project'
const FIRST_PROJECT_PAGE: WorkspaceRequest<'workspace:listProjects'> = { options: { limit: PAGE_SIZE } }
type SidebarTaskPage = WorkspaceTaskReadPage
type LoadedTaskGroup = {
  readonly items: SidebarTaskPage['items']
  readonly nextAfterId: TaskId | null
  readonly pages: Readonly<Record<string, SidebarTaskPage>>
}
const FIRST_TASK_PAGE_KEY = '\u0000first'

function taskPageKey(afterId: string | null): string {
  return afterId ?? FIRST_TASK_PAGE_KEY
}

function nextUnloadedTaskCursor(pages: Readonly<Record<string, SidebarTaskPage>>): TaskId | null {
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

export interface WorkspaceProjectsProps {
  selectedProjectId: ProjectId | null
  selectedTaskId: TaskId | null
  onSelectProject: (projectId: ProjectId | null) => void
  onSelectTask: (taskId: TaskId | null) => void
  onNewChat?: (projectId: ProjectId | null) => void
}

function isScratchProject(project: WorkspaceProjectReadPage['items'][number]): boolean {
  return project.isScratch === true
}

function taskStatusClass(status: WorkspaceTaskReadPage['items'][number]['status']): string {
  switch (status) {
    case 'inProgress':
      return 'bg-blue-500'
    case 'blocked':
      return 'bg-amber-500'
    case 'inReview':
      return 'bg-violet-500'
    case 'completed':
      return 'bg-emerald-500'
    case 'archived':
      return 'bg-muted-foreground/40'
    case 'open':
      return 'bg-sidebar-foreground/30'
  }
}

type SidebarTask = SidebarTaskPage['items'][number]
type TaskSectionId = 'attention' | 'working' | 'open' | 'inProgress' | 'blocked' | 'inReview' | 'completed' | 'archived'

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

function taskSection(task: SidebarTask): TaskSectionId {
  if (
    task.runtime?.pendingRequestKind ||
    task.runtime?.runStatus === 'awaitingInput' ||
    task.runtime?.runStatus === 'uncertain' ||
    task.runtime?.runStatus === 'recoveryRequired' ||
    hasDelegateAttention(task)
  )
    return 'attention'
  if (
    task.runtime?.runStatus === 'queued' ||
    task.runtime?.runStatus === 'starting' ||
    task.runtime?.runStatus === 'running' ||
    task.runtime?.runStatus === 'interruptRequested'
  )
    return 'working'
  return task.status
}

function taskSectionIsCollapsedByDefault(sectionId: TaskSectionId): boolean {
  return sectionId === 'completed' || sectionId === 'archived'
}

/** The parent's own signal first, then what its delegated Tasks are doing. */
function taskSignalLabel(task: SidebarTask): string | null {
  return ownTaskSignalLabel(task) ?? delegateSignalLabel(task)
}

function ownTaskSignalLabel(task: SidebarTask): string | null {
  if (task.runtime?.pendingRequestKind === 'approval') return 'Approval needed'
  if (task.runtime?.pendingRequestKind === 'question') return 'Answer needed'
  switch (task.runtime?.runStatus) {
    case 'uncertain':
      return 'Delivery is uncertain'
    case 'recoveryRequired':
      return 'Recovery needed'
    case 'queued':
      return 'Queued'
    case 'starting':
      return 'Starting'
    case 'running':
      return 'Running'
    case 'awaitingInput':
      return 'Waiting for input'
    case 'interruptRequested':
      return 'Stopping'
    default:
      return null
  }
}

function taskLifecycleLabel(status: SidebarTask['status']): string {
  switch (status) {
    case 'open':
      return 'Ready'
    case 'inProgress':
      return 'In progress'
    case 'blocked':
      return 'Blocked'
    case 'inReview':
      return 'In review'
    case 'completed':
      return 'Completed'
    case 'archived':
      return 'Archived'
  }
}

function formatTaskUpdatedAt(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function compactElapsedTime(value: string, nowMs: number): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const minutes = Math.max(0, differenceInMinutes(nowMs, date))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`
  return `${Math.floor(minutes / 1440)}d`
}

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
  const [expandedGroupIds, setExpandedGroupIds] = useState<ReadonlySet<string>>(() => new Set())
  const [loadedTasks, setLoadedTasks] = useState<Readonly<Record<string, LoadedTaskGroup>>>({})
  const [search, setSearch] = useState('')
  const [initializedDefaultProject, setInitializedDefaultProject] = useState(false)
  const projectDialog = useWorkspaceProjectDialog()
  const connectionsQuery = useWorkspaceConnections()
  const connectionsById = useMemo(
    () => new Map((connectionsQuery.data?.items ?? []).map(connection => [connection.connectionId, connection])),
    [connectionsQuery.data?.items],
  )
  const projectPage = projectsQuery.data

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

  const scratchProjects = useMemo(() => projects.filter(isScratchProject), [projects])
  const regularProjects = useMemo(() => projects.filter(project => !isScratchProject(project)), [projects])
  const searchTerm = search.trim().toLocaleLowerCase()
  const searching = searchTerm.length > 0
  const selectedGroupId =
    selectedProjectId &&
    (scratchProjects.some(project => project.id === selectedProjectId) ? NO_PROJECT_GROUP : selectedProjectId)

  useEffect(() => {
    if (!selectedGroupId) return
    setExpandedGroupIds(current => (current.has(selectedGroupId) ? current : new Set([...current, selectedGroupId])))
  }, [selectedGroupId])

  useEffect(() => {
    if (initializedDefaultProject || selectedProjectId || regularProjects.length === 0) return
    const initialProject =
      regularProjects.find(project => (project.runtime?.attentionCount ?? 0) > 0) ??
      regularProjects.find(project => (project.runtime?.workingCount ?? 0) > 0) ??
      regularProjects[0]
    setExpandedGroupIds(current => (current.size > 0 ? current : new Set([initialProject.id])))
    setInitializedDefaultProject(true)
  }, [initializedDefaultProject, regularProjects, selectedProjectId])

  const newChat = (projectId: ProjectId | null) => {
    const target = projectId && scratchProjects.some(project => project.id === projectId) ? null : projectId
    onSelectProject(projectId)
    onSelectTask(null)
    onNewChat?.(target)
  }

  const toggleProject = (projectId: ProjectId) => {
    setExpandedGroupIds(current => {
      const next = new Set(current)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    })
  }

  const toggleNoProject = () => {
    setExpandedGroupIds(current => {
      const next = new Set(current)
      if (next.has(NO_PROJECT_GROUP)) next.delete(NO_PROJECT_GROUP)
      else next.add(NO_PROJECT_GROUP)
      return next
    })
  }

  const selectTask = (taskId: TaskId, projectId: ProjectId) => {
    onSelectProject(projectId)
    onSelectTask(taskId)
  }

  const rememberTasksPage = useCallback(
    (projectId: ProjectId, request: WorkspaceRequest<'workspace:listTasks'>, page: SidebarTaskPage) => {
      setLoadedTasks(current => {
        const existing = current[projectId]
        const pages = { ...existing?.pages, [taskPageKey(request.options?.afterId ?? null)]: page }
        const items = Object.values(pages).reduce<SidebarTaskPage['items']>(
          (loaded, pageValue) => appendUniquePage(loaded, pageValue.items),
          [],
        )
        return {
          ...current,
          [projectId]: {
            items,
            nextAfterId: nextUnloadedTaskCursor(pages),
            pages,
          },
        }
      })
    },
    [],
  )

  const projectCanLoadMore = Boolean(projectPage?.nextAfterId)
  const noProjectMatches = scratchProjects.some(project => {
    const tasks = loadedTasks[project.id]?.items
    return (
      !tasks ||
      loadedTasks[project.id]?.nextAfterId !== null ||
      tasks.some(task => task.title.toLocaleLowerCase().includes(searchTerm))
    )
  })
  const searchHasMatches =
    regularProjects.some(
      project =>
        project.name.toLocaleLowerCase().includes(searchTerm) ||
        loadedTasks[project.id]?.items.some(task => task.title.toLocaleLowerCase().includes(searchTerm)),
    ) || noProjectMatches
  const searchStillLoading =
    regularProjects.some(project => loadedTasks[project.id] === undefined) ||
    scratchProjects.some(project => loadedTasks[project.id] === undefined)

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
              onClick={() => newChat(null)}
            >
              <SquarePen className="size-4" />
            </Button>
          }
        />
        <TextTooltip
          label="Open Project"
          trigger={
            <Button type="button" size="icon-sm" variant="ghost" aria-label="Open Project" onClick={projectDialog.open}>
              <FolderPlus className="size-4" />
            </Button>
          }
        />
      </header>

      {projectDialog.notice && (
        <p role="status" className="text-sidebar-muted-foreground px-3 pb-2 text-xs">
          {projectDialog.notice}
        </p>
      )}
      {searching && (
        <p role="status" className="text-sidebar-muted-foreground px-3 pb-2 text-[10px]">
          Search covers loaded Projects and chats only. Load more to search additional results.
        </p>
      )}
      <QueryErrorNotice error={projectsQuery.error} hasData={projects.length > 0} />

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {projectsQuery.status === 'loading' && projects.length === 0 ? (
          <LoadingRegion label="Loading chats…" className="px-2 py-3">
            <ChatRowsSkeleton rows={4} />
          </LoadingRegion>
        ) : (
          <ul aria-label="Project chats" className="space-y-0.5">
            {regularProjects.map(project => (
              <ProjectFolder
                key={project.id}
                project={project}
                expanded={searching || expandedGroupIds.has(project.id)}
                visible={
                  !searching ||
                  project.name.toLocaleLowerCase().includes(searchTerm) ||
                  !loadedTasks[project.id] ||
                  loadedTasks[project.id].nextAfterId !== null ||
                  loadedTasks[project.id].items.some(task => task.title.toLocaleLowerCase().includes(searchTerm))
                }
                searchTerm={searchTerm}
                projectMatchesSearch={project.name.toLocaleLowerCase().includes(searchTerm)}
                loadedTaskGroup={loadedTasks[project.id]}
                selectedTaskId={selectedTaskId}
                onToggle={() => {
                  if (!searching) toggleProject(project.id)
                }}
                onNewChat={() => newChat(project.id)}
                onSelectTask={(taskId, projectId) => selectTask(taskId, projectId)}
                onTasksPage={rememberTasksPage}
                connectionsById={connectionsById}
              />
            ))}

            {scratchProjects.length > 0 && (!searching || noProjectMatches) && (
              <li className="list-none">
                <button
                  type="button"
                  aria-expanded={searching || expandedGroupIds.has(NO_PROJECT_GROUP)}
                  onClick={() => {
                    if (!searching) toggleNoProject()
                  }}
                  disabled={searching}
                  className="hover:bg-sidebar-accent focus-visible:ring-ring flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-2"
                >
                  <Folder className="text-sidebar-muted-foreground size-4 shrink-0" />
                  <span className="text-sidebar-foreground/90 min-w-0 flex-1 truncate font-medium">No project</span>
                  {searching || expandedGroupIds.has(NO_PROJECT_GROUP) ? (
                    <ChevronDown className="text-sidebar-muted-foreground size-3.5 shrink-0" />
                  ) : (
                    <ChevronRight className="text-sidebar-muted-foreground size-3.5 shrink-0" />
                  )}
                </button>
                {(searching || expandedGroupIds.has(NO_PROJECT_GROUP)) && (
                  <div className="border-sidebar-border ml-3.5 border-l pl-2">
                    {scratchProjects.map(project => (
                      <SidebarTaskGroup
                        key={project.id}
                        projectId={project.id}
                        searchTerm={searchTerm}
                        projectMatchesSearch={false}
                        loadedTaskGroup={loadedTasks[project.id]}
                        selectedTaskId={selectedTaskId}
                        accessibleLabel="No project chats"
                        connectionsById={connectionsById}
                        onSelectTask={selectTask}
                        onTasksPage={rememberTasksPage}
                      />
                    ))}
                  </div>
                )}
              </li>
            )}
          </ul>
        )}

        {searching && !searchHasMatches && !searchStillLoading && (
          <p className="text-sidebar-muted-foreground px-2 py-3 text-xs" role="status">
            No loaded Projects or chats match Search.
          </p>
        )}

        {projectCanLoadMore && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="my-1 h-7 w-full justify-start text-xs"
            onClick={() => {
              const afterId = projectPage?.nextAfterId
              if (afterId) setProjectRequest({ options: { afterId, limit: PAGE_SIZE } })
            }}
          >
            <MessageCircle className="size-3.5" />
            Load more Projects
          </Button>
        )}
      </div>
    </section>
  )
}

function ProjectFolder({
  project,
  expanded,
  visible,
  searchTerm,
  projectMatchesSearch,
  loadedTaskGroup,
  selectedTaskId,
  onToggle,
  onNewChat,
  onSelectTask,
  onTasksPage,
  connectionsById,
}: {
  readonly project: WorkspaceProjectReadPage['items'][number]
  readonly expanded: boolean
  readonly visible: boolean
  readonly searchTerm: string
  readonly projectMatchesSearch: boolean
  readonly loadedTaskGroup: LoadedTaskGroup | undefined
  readonly selectedTaskId: TaskId | null
  readonly onToggle: () => void
  readonly onNewChat: () => void
  readonly onSelectTask: (taskId: TaskId, projectId: ProjectId) => void
  readonly onTasksPage: (
    projectId: ProjectId,
    request: WorkspaceRequest<'workspace:listTasks'>,
    page: SidebarTaskPage,
  ) => void
  readonly connectionsById: ReadonlyMap<string, { readonly label: string; readonly harnessKind: string }>
}) {
  const attentionCount = project.runtime?.attentionCount ?? 0
  const workingCount = project.runtime?.workingCount ?? 0
  const runtimeSummary = [
    attentionCount > 0 ? `${attentionCount} ${attentionCount === 1 ? 'Task needs' : 'Tasks need'} attention` : null,
    workingCount > 0 ? `${workingCount} ${workingCount === 1 ? 'Task' : 'Tasks'} working` : null,
  ]
    .filter((value): value is string => value !== null)
    .join(' · ')
  return (
    <li className={visible ? 'list-none' : 'hidden'}>
      <div className="group/project hover:bg-sidebar-accent relative flex h-8 items-center rounded-md">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          disabled={searchTerm.length > 0}
          className="focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-2"
        >
          <Folder className="text-sidebar-muted-foreground size-4 shrink-0" />
          <span className="text-sidebar-foreground/90 min-w-0 flex-1 truncate font-medium">{project.name}</span>
        </button>
        <TextTooltip
          label={`New chat in ${project.name}`}
          trigger={
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="mr-0.5 opacity-0 group-focus-within/project:opacity-100 group-hover/project:opacity-100 pointer-coarse:opacity-100"
              aria-label={`New chat in ${project.name}`}
              onClick={onNewChat}
            >
              <Plus className="size-3.5" />
            </Button>
          }
        />
        {runtimeSummary && (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  role="img"
                  aria-label={runtimeSummary}
                  className="text-sidebar-muted-foreground flex shrink-0 items-center gap-1 px-1 text-[10px] tabular-nums"
                />
              }
            >
              {attentionCount > 0 && (
                <span className="inline-flex items-center gap-1" aria-hidden="true">
                  <span className="size-1.5 rounded-full bg-amber-500" />
                  {attentionCount}
                </span>
              )}
              {workingCount > 0 && (
                <span className="inline-flex items-center gap-1" aria-hidden="true">
                  <span className="size-1.5 rounded-full bg-blue-500" />
                  {workingCount}
                </span>
              )}
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8} className="max-w-64 flex-col items-start gap-0.5">
              <span>{runtimeSummary}</span>
            </TooltipContent>
          </Tooltip>
        )}
        <button
          type="button"
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${project.name}`}
          aria-expanded={expanded}
          onClick={onToggle}
          disabled={searchTerm.length > 0}
          className="text-sidebar-muted-foreground hover:text-sidebar-foreground focus-visible:ring-ring mr-1 flex size-6 shrink-0 items-center justify-center rounded outline-none focus-visible:ring-2"
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
      </div>
      {expanded && (
        <div className="border-sidebar-border ml-3.5 border-l pl-2">
          <SidebarTaskGroup
            projectId={project.id}
            searchTerm={searchTerm}
            projectMatchesSearch={projectMatchesSearch}
            loadedTaskGroup={loadedTaskGroup}
            selectedTaskId={selectedTaskId}
            accessibleLabel={`Chats in ${project.name}`}
            onSelectTask={onSelectTask}
            onTasksPage={onTasksPage}
            connectionsById={connectionsById}
          />
        </div>
      )}
    </li>
  )
}

function SidebarTaskGroup({
  projectId,
  searchTerm,
  projectMatchesSearch,
  loadedTaskGroup,
  selectedTaskId,
  accessibleLabel,
  onSelectTask,
  onTasksPage,
  connectionsById,
}: {
  readonly projectId: ProjectId
  readonly searchTerm: string
  readonly projectMatchesSearch: boolean
  readonly loadedTaskGroup: LoadedTaskGroup | undefined
  readonly selectedTaskId: TaskId | null
  readonly accessibleLabel: string
  readonly onSelectTask: (taskId: TaskId, projectId: ProjectId) => void
  readonly onTasksPage: (
    projectId: ProjectId,
    request: WorkspaceRequest<'workspace:listTasks'>,
    page: SidebarTaskPage,
  ) => void
  readonly connectionsById: ReadonlyMap<string, { readonly label: string; readonly harnessKind: string }>
}) {
  const [request, setRequest] = useState<WorkspaceRequest<'workspace:listTasks'>>({
    projectId,
    options: { limit: PAGE_SIZE, includeArchived: true },
  })
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<TaskSectionId>>(
    () =>
      new Set(TASK_SECTIONS.filter(section => taskSectionIsCollapsedByDefault(section.id)).map(section => section.id)),
  )
  const [pageCursors, setPageCursors] = useState<ReadonlyArray<TaskId | null>>([null])
  const [nowMs, setNowMs] = useState(() => Date.now())
  const query = useWorkspaceSidebarTasks(projectId, request)
  const page = query.data

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (query.status !== 'ready' || !page) return
    onTasksPage(projectId, request, {
      ...page,
      items: page.items.filter(task => task.projectId === projectId),
    })
  }, [onTasksPage, page, projectId, query.status, request])

  const loadMore = () => {
    const nextAfterId = loadedTaskGroup?.nextAfterId ?? page?.nextAfterId
    if (nextAfterId) {
      setPageCursors(current => (current.includes(nextAfterId) ? current : [...current, nextAfterId]))
      setRequest({ projectId, options: { afterId: nextAfterId, limit: PAGE_SIZE, includeArchived: true } })
    }
  }

  const activeCursor = request.options?.afterId ?? null

  // Child Tasks belong under their parent; they never appear as top-level rows.
  const tasks = (loadedTaskGroup?.items ?? []).filter(task => !isDelegatedChild(task))
  const projectLabel = accessibleLabel.startsWith('Chats in ')
    ? accessibleLabel.slice('Chats in '.length)
    : 'No project'
  const visibleTasks =
    searchTerm && !projectMatchesSearch
      ? tasks.filter(task => task.title.toLocaleLowerCase().includes(searchTerm))
      : tasks
  const visibleTasksBySection = TASK_SECTIONS.map(section => ({
    ...section,
    tasks: visibleTasks.filter(task => taskSection(task) === section.id).sort(compareTaskActivity),
  })).filter(section => section.tasks.length > 0)

  const toggleSection = (sectionId: TaskSectionId) => {
    setCollapsedSections(current => {
      const next = new Set(current)
      if (next.has(sectionId)) next.delete(sectionId)
      else next.add(sectionId)
      return next
    })
  }

  const renderTask = (task: SidebarTask) => {
    const selected = selectedTaskId === task.id
    const signal = taskSignalLabel(task)
    const section = taskSection(task)
    const sectionLabel = TASK_SECTIONS.find(item => item.id === section)?.label ?? taskLifecycleLabel(task.status)
    const tooltipState =
      section === 'attention' || section === 'working'
        ? `${sectionLabel} · ${signal ?? 'Active'}`
        : `Task lifecycle · ${taskLifecycleLabel(task.status)}`
    return (
      <SidebarTaskRow
        key={task.id}
        task={task}
        projectId={projectId}
        projectLabel={projectLabel}
        selected={selected}
        tooltipState={tooltipState}
        nowMs={nowMs}
        section={section}
        connectionsById={connectionsById}
        selectedTaskId={selectedTaskId}
        onSelectTask={onSelectTask}
      />
    )
  }

  return (
    <>
      {pageCursors
        .filter(afterId => afterId !== activeCursor)
        .map(afterId => (
          <SidebarTaskPageRefresh
            key={afterId ?? 'first'}
            projectId={projectId}
            afterId={afterId}
            onTasksPage={onTasksPage}
          />
        ))}
      {query.error && <QueryErrorNotice error={query.error} hasData={tasks.length > 0} />}
      {query.status === 'loading' && tasks.length === 0 ? (
        <LoadingRegion label="Loading chats…" className="px-2 py-2">
          <ChatRowsSkeleton rows={3} />
        </LoadingRegion>
      ) : visibleTasks.length === 0 ? (
        <p className="text-sidebar-muted-foreground px-2 py-2 text-xs">
          {searchTerm ? 'No loaded chats match Search' : 'No chats yet'}
        </p>
      ) : (
        <div aria-label={accessibleLabel} className="space-y-1">
          {visibleTasksBySection.map(section => {
            const collapsed = !searchTerm && collapsedSections.has(section.id)
            const selectedTask = section.tasks.find(task => task.id === selectedTaskId)
            const displayedTasks = collapsed ? (selectedTask ? [selectedTask] : []) : section.tasks
            return (
              <section key={section.id} aria-label={`${section.label}, ${section.tasks.length} loaded`}>
                <button
                  type="button"
                  aria-expanded={!collapsed}
                  aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${section.label}, ${section.tasks.length} loaded`}
                  onClick={() => toggleSection(section.id)}
                  disabled={searchTerm.length > 0}
                  className="text-sidebar-muted-foreground hover:text-sidebar-foreground focus-visible:ring-ring flex h-7 w-full items-center gap-1.5 rounded px-1 text-left text-[10px] font-semibold tracking-wide uppercase outline-none focus-visible:ring-2"
                >
                  {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
                  <span className="min-w-0 flex-1 truncate">{section.label}</span>
                  <span className="tabular-nums">{section.tasks.length}</span>
                </button>
                {displayedTasks.length > 0 && <ul className="space-y-0.5">{displayedTasks.map(renderTask)}</ul>}
              </section>
            )
          })}
        </div>
      )}
      {loadedTaskGroup?.nextAfterId && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="my-1 h-7 w-full justify-start text-xs"
          onClick={loadMore}
        >
          Load more chats
        </Button>
      )}
    </>
  )
}

function SidebarTaskRow({
  task,
  projectId,
  projectLabel,
  selected,
  tooltipState,
  nowMs,
  section,
  connectionsById,
  selectedTaskId,
  onSelectTask,
}: {
  readonly task: SidebarTask
  readonly projectId: ProjectId
  readonly projectLabel: string
  readonly selected: boolean
  readonly tooltipState: string
  readonly nowMs: number
  readonly section: TaskSectionId
  readonly connectionsById: ReadonlyMap<string, { readonly label: string; readonly harnessKind: string }>
  readonly selectedTaskId: TaskId | null
  readonly onSelectTask: (taskId: TaskId, projectId: ProjectId) => void
}) {
  const renameTask = useRenameTask()
  const setTaskArchived = useSetTaskArchived()
  const [editing, setEditing] = useState(false)
  const [delegatesOpen, setDelegatesOpen] = useState(false)
  const delegatedTotal = delegatedChildTotal(task)
  const [draft, setDraft] = useState(task.title)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const committing = useRef(false)
  const settled = useRef(false)
  const latestRun = task.runtime.latestRun
  const catalog = useWorkspaceConnectionCatalog(latestRun?.connectionId ?? '')
  const modelView = catalogView({ inspection: catalog.inspection, failed: catalog.failed })
  const modelName = latestRun?.modelId
    ? modelDisplayName(
        latestRun.modelId,
        modelView.kind === 'listed' || modelView.kind === 'session' ? modelView.models : [],
      )
    : null
  const activityAt = taskActivityAt(task)
  const activityTime = formatTaskUpdatedAt(activityAt)
  const elapsedTime = compactElapsedTime(activityAt, nowMs)
  const connection = latestRun?.connectionId ? connectionsById.get(latestRun.connectionId) : undefined
  const harnessKind = latestRun?.driverId ?? 'unknown'
  const cannotArchive = Boolean(
    task.runtime.pendingRequestKind ||
    ['queued', 'starting', 'running', 'awaitingInput', 'interruptRequested', 'uncertain', 'recoveryRequired'].includes(
      task.runtime.runStatus ?? '',
    ),
  )
  const statusColor =
    section === 'attention' ? 'bg-amber-500' : section === 'working' ? 'bg-blue-500' : taskStatusClass(task.status)

  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])

  const cancelRename = () => {
    settled.current = true
    setDraft(task.title)
    setEditing(false)
  }
  const commitRename = async () => {
    if (settled.current || committing.current) return
    const title = draft.trim()
    if (!title || title === task.title) {
      cancelRename()
      return
    }
    committing.current = true
    settled.current = true
    try {
      await renameTask.execute({ taskId: task.id, title })
      setError(null)
      setEditing(false)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not rename chat.'
      setError(message)
      showErrorToast(`workspace:rename:${task.id}`, "Couldn't rename chat", message)
      committing.current = false
      settled.current = false
      inputRef.current?.focus()
    }
  }
  const toggleArchived = async () => {
    if (cannotArchive || setTaskArchived.pending) return
    try {
      await setTaskArchived.execute({ taskId: task.id, archived: task.status !== 'archived' })
      setError(null)
    } catch (cause) {
      showErrorToast(
        `workspace:archive:${task.id}`,
        task.status === 'archived' ? "Couldn't unarchive chat" : "Couldn't archive chat",
        cause instanceof Error ? cause.message : 'Could not update chat archive status.',
      )
    }
  }

  return (
    <li className="group/task relative list-none rounded-md">
      <div className="relative flex min-h-9 items-center">
        {!editing && delegatedTotal > 0 && (
          <SidebarDelegateToggle
            title={task.title}
            total={delegatedTotal}
            expanded={delegatesOpen}
            onToggle={() => setDelegatesOpen(open => !open)}
          />
        )}
        {editing ? (
          <Input
            ref={inputRef}
            aria-label={`Rename chat ${task.title}`}
            value={draft}
            aria-invalid={error ? true : undefined}
            onChange={event => setDraft(event.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void commitRename()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                cancelRename()
              }
            }}
            className="h-7 flex-1 rounded-md px-2.5 text-xs"
          />
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => onSelectTask(task.id, projectId)}
                  aria-current={selected ? 'page' : undefined}
                  aria-label={`${task.title}, ${tooltipState}, last activity ${activityTime}`}
                  className={`focus-visible:ring-ring flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md py-1 pr-16 pl-2.5 text-left text-[13px] transition-colors outline-none focus-visible:ring-2 ${selected ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'}`}
                />
              }
            >
              <span className={`size-1.5 shrink-0 rounded-full ${statusColor}`} aria-hidden="true" />
              {latestRun && <HarnessIcon kind={connection?.harnessKind ?? harnessKind} className="size-3.5 shrink-0" />}
              <span className="min-w-0 flex-1 truncate">{task.title}</span>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8} className="max-w-64 flex-col items-start gap-0.5">
              <span className="max-w-full truncate font-medium">{task.title}</span>
              <span className="text-background/75">{projectLabel}</span>
              {latestRun && (
                <span className="text-background/75 flex items-center gap-1.5">
                  <HarnessIcon kind={connection?.harnessKind ?? harnessKind} className="size-3.5 shrink-0" />
                  {connection?.label ?? harnessKind}
                </span>
              )}
              {modelName && <span className="text-background/75">Model: {modelName}</span>}
              {latestRun?.branch && <span className="text-background/75">Branch: {latestRun.branch}</span>}
              <span className="text-background/75">
                {tooltipState} · Activity {activityTime}
              </span>
            </TooltipContent>
          </Tooltip>
        )}
        {!editing && elapsedTime && (
          <span
            aria-hidden="true"
            className="text-sidebar-muted-foreground pointer-events-none absolute right-2 text-[10px] tabular-nums transition-opacity group-hover/task:opacity-0 group-has-[:focus-visible]/task:opacity-0 pointer-coarse:opacity-0"
          >
            {elapsedTime}
          </span>
        )}
        {!editing && (
          <div className="pointer-events-none absolute inset-y-0 right-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/task:pointer-events-auto group-hover/task:opacity-100 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Rename chat ${task.title}`}
                    onClick={() => {
                      committing.current = false
                      settled.current = false
                      setDraft(task.title)
                      setError(null)
                      setEditing(true)
                    }}
                    className="size-7"
                  />
                }
              >
                <Pencil className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={8}>
                Rename {task.title}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`${task.status === 'archived' ? 'Unarchive' : 'Archive'} chat ${task.title}`}
                    aria-disabled={cannotArchive || setTaskArchived.pending}
                    onClick={() => void toggleArchived()}
                    className="size-7"
                  />
                }
              >
                {task.status === 'archived' ? (
                  <ArchiveRestore className="size-3.5" />
                ) : (
                  <Archive className="size-3.5" />
                )}
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={8}>
                {cannotArchive
                  ? 'Stop or resolve the active chat run before archiving.'
                  : `${task.status === 'archived' ? 'Unarchive' : 'Archive'} chat`}
              </TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>
      {delegatesOpen && delegatedTotal > 0 && (
        <SidebarDelegateChildren
          taskId={task.id}
          projectId={projectId}
          selectedTaskId={selectedTaskId}
          onSelectTask={onSelectTask}
        />
      )}
    </li>
  )
}

function SidebarTaskPageRefresh({
  projectId,
  afterId,
  onTasksPage,
}: {
  readonly projectId: ProjectId
  readonly afterId: TaskId | null
  readonly onTasksPage: (
    projectId: ProjectId,
    request: WorkspaceRequest<'workspace:listTasks'>,
    page: SidebarTaskPage,
  ) => void
}) {
  const request = useMemo<WorkspaceRequest<'workspace:listTasks'>>(
    () => ({
      projectId,
      options: { ...(afterId ? { afterId } : {}), limit: PAGE_SIZE, includeArchived: true },
    }),
    [afterId, projectId],
  )
  const query = useWorkspaceSidebarTasks(projectId, request)
  const page = query.data

  useEffect(() => {
    if (query.status !== 'ready' || !page) return
    onTasksPage(projectId, request, {
      ...page,
      items: page.items.filter(task => task.projectId === projectId),
    })
  }, [onTasksPage, page, projectId, query.status, request])

  return null
}

/** Sidebar chat-list placeholder: icon-sized square + text-bar rows, sized to the sidebar's text-xs rows. */
function ChatRowsSkeleton({ rows, className }: { rows: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2.5', className)}>
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex items-center gap-2">
          <Skeleton className="size-3.5 shrink-0 rounded-sm" />
          <Skeleton className={cn('h-3', row % 2 === 0 ? 'w-4/5' : 'w-3/5')} />
        </div>
      ))}
    </div>
  )
}
