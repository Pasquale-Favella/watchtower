import { ChevronDown, ChevronRight, Folder, FolderPlus, MessageCircle, Plus, Search, SquarePen, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { QueryErrorNotice } from '@/renderer/components/QueryErrorNotice'
import { Button } from '@/renderer/components/ui/button'
import { Input } from '@/renderer/components/ui/input'
import type { ProjectId, TaskId } from '@/shared/schemas/workspace.js'
import type { WorkspaceProjectReadPage, WorkspaceTaskReadPage } from '@/shared/schemas/workspace-store.js'

import { useWorkspaceProject, useWorkspaceProjects, useWorkspaceSidebarTasks, type WorkspaceRequest } from './hooks.js'
import { appendUniquePage } from './project-ui.js'
import { useWorkspaceProjectDialog } from './use-project-dialog.js'

const PAGE_SIZE = 30
const NO_PROJECT_GROUP = 'no-project'
const FIRST_PROJECT_PAGE: WorkspaceRequest<'workspace:listProjects'> = { options: { limit: PAGE_SIZE } }
type SidebarTaskPage = WorkspaceTaskReadPage
type LoadedTaskGroup = { readonly items: SidebarTaskPage['items']; readonly nextAfterId: TaskId | null }

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
  const projectDialog = useWorkspaceProjectDialog()
  const projectPage = projectsQuery.data

  useEffect(() => {
    const page = projectsQuery.data
    if (projectsQuery.status !== 'ready' || !page) return
    setProjects(previous => appendUniquePage(previous, page.items))
  }, [projectsQuery.data, projectsQuery.status])

  useEffect(() => {
    const restored = selectedProjectQuery.data?.project
    if (restored) setProjects(previous => appendUniquePage(previous, [restored]))
    if (selectedProjectId && selectedProjectQuery.error) onSelectProject(null)
  }, [onSelectProject, selectedProjectId, selectedProjectQuery.data, selectedProjectQuery.error])

  const scratchProjects = useMemo(() => projects.filter(isScratchProject), [projects])
  const regularProjects = useMemo(() => projects.filter(project => !isScratchProject(project)), [projects])
  const searchTerm = search.trim().toLocaleLowerCase()
  const searching = searchTerm.length > 0

  useEffect(() => {
    if (!selectedProjectId) return
    const groupId = scratchProjects.some(project => project.id === selectedProjectId)
      ? NO_PROJECT_GROUP
      : selectedProjectId
    setExpandedGroupIds(current => (current.has(groupId) ? current : new Set([...current, groupId])))
  }, [scratchProjects, selectedProjectId])

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
        const nextAfterId =
          request.options?.afterId !== undefined
            ? page.nextAfterId
            : existing
              ? existing.nextAfterId === null && page.total > existing.items.length
                ? page.nextAfterId
                : existing.nextAfterId
              : page.nextAfterId
        return {
          ...current,
          [projectId]: {
            items: appendUniquePage(existing?.items ?? [], page.items),
            nextAfterId,
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
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Clear search"
              title="Clear search"
              className="absolute top-1/2 right-1 -translate-y-1/2"
              onClick={() => setSearch('')}
            >
              <X className="size-3.5" />
            </Button>
          )}
        </div>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="New chat"
          title="New chat"
          disabled={!onNewChat}
          onClick={() => newChat(null)}
        >
          <SquarePen className="size-4" />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Open Project"
          title="Open Project"
          onClick={projectDialog.open}
        >
          <FolderPlus className="size-4" />
        </Button>
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
          <p role="status" className="text-sidebar-muted-foreground px-2 py-3 text-xs">
            Loading chats…
          </p>
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
}) {
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
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="mr-0.5 opacity-0 group-focus-within/project:opacity-100 group-hover/project:opacity-100 pointer-coarse:opacity-100"
          aria-label={`New chat in ${project.name}`}
          title={`New chat in ${project.name}`}
          onClick={onNewChat}
        >
          <Plus className="size-3.5" />
        </Button>
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
}) {
  const [request, setRequest] = useState<WorkspaceRequest<'workspace:listTasks'>>({
    projectId,
    options: { limit: PAGE_SIZE },
  })
  const query = useWorkspaceSidebarTasks(projectId, request)
  const page = query.data

  useEffect(() => {
    if (query.status !== 'ready' || !page) return
    onTasksPage(projectId, request, {
      ...page,
      items: page.items.filter(task => task.projectId === projectId),
    })
  }, [onTasksPage, page, projectId, query.status, request])

  const loadMore = () => {
    const nextAfterId = loadedTaskGroup?.nextAfterId ?? page?.nextAfterId
    if (nextAfterId) setRequest({ projectId, options: { afterId: nextAfterId, limit: PAGE_SIZE } })
  }

  const tasks = loadedTaskGroup?.items ?? []
  const visibleTasks =
    searchTerm && !projectMatchesSearch
      ? tasks.filter(task => task.title.toLocaleLowerCase().includes(searchTerm))
      : tasks

  return (
    <>
      {query.error && <QueryErrorNotice error={query.error} hasData={tasks.length > 0} />}
      {query.status === 'loading' && tasks.length === 0 ? (
        <p role="status" className="text-sidebar-muted-foreground px-2 py-2 text-xs">
          Loading chats…
        </p>
      ) : visibleTasks.length === 0 ? (
        <p className="text-sidebar-muted-foreground px-2 py-2 text-xs">
          {searchTerm ? 'No loaded chats match Search' : 'No chats yet'}
        </p>
      ) : (
        <ul aria-label={accessibleLabel} className="space-y-0.5">
          {visibleTasks.map(task => (
            <li key={task.id} className="list-none">
              <button
                type="button"
                onClick={() => onSelectTask(task.id, projectId)}
                aria-current={selectedTaskId === task.id ? 'page' : undefined}
                className={`focus-visible:ring-ring flex min-h-8 w-full items-center gap-2 rounded-md px-2.5 py-1 text-left text-xs outline-none focus-visible:ring-2 ${selectedTaskId === task.id ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'}`}
              >
                <span className={`size-1.5 shrink-0 rounded-full ${taskStatusClass(task.status)}`} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{task.title}</span>
                <span className="sr-only">{task.status}</span>
              </button>
            </li>
          ))}
        </ul>
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
