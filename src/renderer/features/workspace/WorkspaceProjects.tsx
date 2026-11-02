import { useEffect, useMemo, useRef, useState } from 'react'

import { QueryErrorNotice } from '@/renderer/components/QueryErrorNotice'
import { Button } from '@/renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/renderer/components/ui/dialog'
import { Input } from '@/renderer/components/ui/input'
import type { ProjectId, TaskId } from '@/shared/schemas/workspace.js'
import type { WorkspaceProjectReadPage, WorkspaceTaskReadPage } from '@/shared/schemas/workspace-store.js'

import {
  useCreateTask,
  useRegisterProject,
  useWorkspaceProject,
  useWorkspaceProjects,
  useWorkspaceTasks,
  type WorkspaceRequest,
} from './hooks.js'
import { appendUniquePage, searchLoaded } from './project-ui.js'

const PAGE_SIZE = 30
const FIRST_PROJECT_PAGE: WorkspaceRequest<'workspace:listProjects'> = { options: { limit: PAGE_SIZE } }
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : 'The operation failed. Try again.'

export interface WorkspaceProjectsProps {
  selectedProjectId: ProjectId | null
  selectedTaskId: TaskId | null
  onSelectProject: (projectId: ProjectId | null) => void
  onSelectTask: (taskId: TaskId | null) => void
}

export function WorkspaceProjects({
  selectedProjectId,
  selectedTaskId,
  onSelectProject,
  onSelectTask,
}: WorkspaceProjectsProps) {
  const [projectRequest, setProjectRequest] = useState(FIRST_PROJECT_PAGE)
  const projectsQuery = useWorkspaceProjects(projectRequest)
  const [projects, setProjects] = useState<WorkspaceProjectReadPage['items']>([])
  const selectedProjectQuery = useWorkspaceProject(selectedProjectId ? { projectId: selectedProjectId } : null)
  const [projectSearch, setProjectSearch] = useState('')
  const [taskSearch, setTaskSearch] = useState('')
  const [taskRequest, setTaskRequest] = useState<WorkspaceRequest<'workspace:listTasks'> | null>(null)
  const tasksQuery = useWorkspaceTasks(taskRequest)
  const [tasks, setTasks] = useState<WorkspaceTaskReadPage['items']>([])
  const [registerName, setRegisterName] = useState('')
  const [registerPath, setRegisterPath] = useState('')
  const [taskTitle, setTaskTitle] = useState('')
  const [taskDescription, setTaskDescription] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [registrationNotice, setRegistrationNotice] = useState<string | null>(null)
  const [registerOpen, setRegisterOpen] = useState(false)
  const [taskOpen, setTaskOpen] = useState(false)
  const [registering, setRegistering] = useState(false)
  const [creatingTask, setCreatingTask] = useState(false)
  const activeProjectId = useRef<ProjectId | null>(selectedProjectId)

  useEffect(() => {
    activeProjectId.current = selectedProjectId
  }, [selectedProjectId])

  useEffect(() => {
    if (projectsQuery.status !== 'ready' || !projectsQuery.data) return
    const page = projectsQuery.data
    setProjects(previous => appendUniquePage(previous, page.items))
    if (!selectedProjectId && page.items[0]) onSelectProject(page.items[0].id)
    else if (selectedProjectId && !projects.some(project => project.id === selectedProjectId) && page.items.length) {
      const restored = selectedProjectQuery.data?.project
      if (restored) setProjects(previous => appendUniquePage(previous, [restored]))
      else if (selectedProjectQuery.error) onSelectProject(page.items[0]?.id ?? null)
    }
  }, [
    projectsQuery.data,
    projectsQuery.status,
    projectRequest,
    onSelectProject,
    projects,
    selectedProjectId,
    selectedProjectQuery.data,
    selectedProjectQuery.status,
    selectedProjectQuery.error,
  ])

  useEffect(() => {
    if (selectedProjectId) setTaskRequest({ projectId: selectedProjectId, options: { limit: PAGE_SIZE } })
  }, [selectedProjectId])

  useEffect(() => {
    if (!taskRequest || tasksQuery.status !== 'ready' || !tasksQuery.data) return
    if (activeProjectId.current !== taskRequest.projectId) return
    const page = tasksQuery.data
    setTasks(previous => appendUniquePage(previous, page.items))
    if (!selectedTaskId && page.items[0]) onSelectTask(page.items[0].id)
  }, [taskRequest, tasksQuery.data, tasksQuery.status, onSelectTask, selectedTaskId])

  const selectedProject =
    projects.find(project => project.id === selectedProjectId) ?? selectedProjectQuery.data?.project ?? null
  const filteredProjects = useMemo(
    () => searchLoaded(projects, projectSearch, project => [project.name, project.repositoryIdentity]),
    [projects, projectSearch],
  )
  const filteredTasks = useMemo(
    () => searchLoaded(tasks, taskSearch, task => [task.title, task.description]),
    [tasks, taskSearch],
  )

  function selectProject(projectId: ProjectId) {
    if (projectId === selectedProjectId) return
    activeProjectId.current = projectId
    setTasks([])
    setTaskSearch('')
    onSelectProject(projectId)
    onSelectTask(null)
  }

  async function registerProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setActionError(null)
    setRegistrationNotice(null)
    setRegistering(true)
    try {
      const receipt = await registerCommand.execute({ path: registerPath.trim(), name: registerName.trim() })
      const project = receipt.project
      setProjects(previous => appendUniquePage(previous, [project]))
      activeProjectId.current = project.id
      onSelectProject(project.id)
      onSelectTask(null)
      setRegistrationNotice(
        receipt.reused
          ? `Using the existing Project “${project.name}” at ${receipt.mainCheckout.path}.`
          : `Registered “${project.name}” at ${receipt.mainCheckout.path}.`,
      )
      setRegisterName('')
      setRegisterPath('')
      setRegisterOpen(false)
      setProjectRequest(FIRST_PROJECT_PAGE)
    } catch (error) {
      setActionError(errorText(error))
    } finally {
      setRegistering(false)
    }
  }

  async function createTask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedProjectId) return
    const projectAtStart = selectedProjectId
    setActionError(null)
    setCreatingTask(true)
    try {
      const receipt = await createTaskCommand.execute({
        projectId: projectAtStart,
        title: taskTitle.trim(),
        description: taskDescription.trim(),
      })
      if (activeProjectId.current !== projectAtStart) return
      onSelectTask(receipt.taskId)
      setTaskTitle('')
      setTaskDescription('')
      setTaskOpen(false)
      setTasks([])
      setTaskRequest({ projectId: projectAtStart, options: { limit: PAGE_SIZE } })
    } catch (error) {
      if (activeProjectId.current === projectAtStart) setActionError(errorText(error))
    } finally {
      setCreatingTask(false)
    }
  }

  const registerCommand = useRegisterProject()
  const createTaskCommand = useCreateTask()
  const projectPage = projectsQuery.data
  const taskPage = tasksQuery.data
  const projectCanLoadMore = Boolean(projectPage?.nextAfterId)
  const taskCanLoadMore = Boolean(taskPage?.nextAfterId && taskRequest?.projectId === selectedProjectId)

  return (
    <section aria-label="Projects and tasks" className="flex min-h-0 flex-col gap-3">
      <header className="flex shrink-0 flex-col gap-2">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">{selectedProject?.name ?? 'Workspace'}</h1>
          <p className="text-muted-foreground text-[11px]">Projects · Tasks</p>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button className="flex-1" size="sm" variant="outline" onClick={() => setRegisterOpen(true)}>
            Open Project
          </Button>
          <Button className="flex-1" size="sm" onClick={() => setTaskOpen(true)} disabled={!selectedProject}>
            New Task
          </Button>
        </div>
      </header>

      {registrationNotice && (
        <p role="status" className="text-muted-foreground text-xs">
          {registrationNotice}
        </p>
      )}
      {actionError && (
        <p role="alert" className="text-destructive text-xs">
          {actionError}
        </p>
      )}

      <label className="sr-only" htmlFor="workspace-project-search">
        Search loaded Projects
      </label>
      <Input
        id="workspace-project-search"
        type="search"
        value={projectSearch}
        onChange={event => setProjectSearch(event.target.value)}
        placeholder="Find a Project"
      />
      <QueryErrorNotice error={projectsQuery.error} hasData={projects.length > 0} />
      <div className="min-h-0 flex-1 overflow-auto">
        {projectsQuery.status === 'loading' && projects.length === 0 ? (
          <p role="status" className="text-muted-foreground py-3 text-xs">
            Loading Projects…
          </p>
        ) : filteredProjects.length === 0 ? (
          <p className="text-muted-foreground py-3 text-xs">
            {projects.length
              ? 'No loaded Projects match this search.'
              : 'No registered Projects yet. Open one to begin.'}
          </p>
        ) : (
          <ul aria-label="Loaded Projects" className="space-y-1">
            {filteredProjects.map(project => (
              <li key={project.id}>
                <button
                  type="button"
                  onClick={() => selectProject(project.id)}
                  aria-current={selectedProjectId === project.id ? 'true' : undefined}
                  className={`focus-visible:ring-ring w-full rounded-md px-2 py-1.5 text-left text-xs outline-none focus-visible:ring-2 ${selectedProjectId === project.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-muted'}`}
                >
                  <span className="block truncate font-medium">{project.name}</span>
                  <span className="text-muted-foreground block truncate text-[10px]">{project.repositoryIdentity}</span>
                </button>
                {selectedProjectId === project.id && (
                  <div className="ml-3 border-l pl-2">
                    <label className="sr-only" htmlFor="workspace-task-search">
                      Search loaded Tasks
                    </label>
                    <Input
                      id="workspace-task-search"
                      type="search"
                      className="my-1 h-8"
                      value={taskSearch}
                      onChange={event => setTaskSearch(event.target.value)}
                      placeholder="Find a Task"
                    />
                    <QueryErrorNotice error={tasksQuery.error} hasData={tasks.length > 0} />
                    {tasksQuery.status === 'loading' && tasks.length === 0 ? (
                      <p role="status" className="py-2 text-xs">
                        Loading Tasks…
                      </p>
                    ) : filteredTasks.length === 0 ? (
                      <p className="text-muted-foreground py-2 text-xs">
                        {tasks.length ? 'No loaded Tasks match this search.' : 'No Tasks for this Project yet.'}
                      </p>
                    ) : (
                      <ul aria-label={`Tasks for ${project.name}`} className="space-y-0.5">
                        {filteredTasks.map(task => (
                          <li key={task.id}>
                            <button
                              type="button"
                              onClick={() => onSelectTask(task.id)}
                              aria-current={selectedTaskId === task.id ? 'true' : undefined}
                              className={`focus-visible:ring-ring w-full rounded px-2 py-1.5 text-left outline-none focus-visible:ring-2 ${selectedTaskId === task.id ? 'bg-accent text-foreground' : 'hover:bg-muted'}`}
                            >
                              <span className="block truncate text-xs">{task.title}</span>
                              <span className="text-muted-foreground block truncate text-[10px]">{task.status}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="text-muted-foreground flex items-center justify-between py-1 text-[10px]">
                      <span>
                        {tasks.length} loaded of {taskPage?.total ?? '…'}
                      </span>
                      {taskCanLoadMore && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            const afterId = taskPage?.nextAfterId
                            if (afterId)
                              setTaskRequest({ projectId: project.id, options: { afterId, limit: PAGE_SIZE } })
                          }}
                        >
                          Load more
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="text-muted-foreground py-1 text-[10px]">
          {projects.length} loaded of {projectPage?.total ?? '…'} Projects
        </p>
        {projectCanLoadMore && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              const afterId = projectPage?.nextAfterId
              if (afterId) setProjectRequest({ options: { afterId, limit: PAGE_SIZE } })
            }}
          >
            Load more Projects
          </Button>
        )}
      </div>

      <Dialog open={registerOpen} onOpenChange={setRegisterOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Open a Project</DialogTitle>
            <DialogDescription>Register a local checkout or reuse its existing Project.</DialogDescription>
          </DialogHeader>
          <form onSubmit={registerProject} className="space-y-3">
            <label className="block text-sm" htmlFor="workspace-project-name">
              Project name
            </label>
            <Input
              id="workspace-project-name"
              value={registerName}
              onChange={event => setRegisterName(event.target.value)}
              required
              maxLength={512}
            />
            <label className="block text-sm" htmlFor="workspace-project-path">
              Local checkout path
            </label>
            <Input
              id="workspace-project-path"
              value={registerPath}
              onChange={event => setRegisterPath(event.target.value)}
              required
              placeholder="C:\\src\\project"
            />
            <DialogFooter>
              <Button type="submit" disabled={registering || !registerName.trim() || !registerPath.trim()}>
                {registering ? 'Opening…' : 'Open Project'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={taskOpen} onOpenChange={setTaskOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Task</DialogTitle>
            <DialogDescription>
              {selectedProject ? `Create a Task in ${selectedProject.name}.` : 'Select a Project first.'}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={createTask} className="space-y-3">
            <label className="sr-only" htmlFor="workspace-task-title">
              Task title
            </label>
            <Input
              id="workspace-task-title"
              value={taskTitle}
              onChange={event => setTaskTitle(event.target.value)}
              placeholder="What needs to be done?"
              required
              maxLength={512}
            />
            <label className="sr-only" htmlFor="workspace-task-description">
              Task description
            </label>
            <Input
              id="workspace-task-description"
              value={taskDescription}
              onChange={event => setTaskDescription(event.target.value)}
              placeholder="Description (optional)"
              maxLength={20_000}
            />
            <DialogFooter>
              <Button type="submit" disabled={creatingTask || !selectedProject || !taskTitle.trim()}>
                {creatingTask ? 'Creating…' : 'Create Task'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  )
}
