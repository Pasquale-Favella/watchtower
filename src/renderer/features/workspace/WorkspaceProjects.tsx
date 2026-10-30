import { useEffect, useMemo, useRef, useState } from 'react'

import { Panel } from '@/renderer/components/Panel'
import { QueryErrorNotice } from '@/renderer/components/QueryErrorNotice'
import { Button } from '@/renderer/components/ui/button'
import { Input } from '@/renderer/components/ui/input'
import type { ProjectId, TaskId } from '@/shared/schemas/workspace.js'
import type { WorkspaceProjectReadPage, WorkspaceTaskReadPage } from '@/shared/schemas/workspace-store.js'

import {
  useCreateTask,
  useRegisterProject,
  useWorkspaceProjects,
  useWorkspaceTasks,
  type WorkspaceRequest,
} from './hooks.js'
import { appendUniquePage, searchLoaded } from './project-ui.js'

const PAGE_SIZE = 30
const FIRST_PROJECT_PAGE: WorkspaceRequest<'workspace:listProjects'> = { options: { limit: PAGE_SIZE } }

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : 'The operation failed. Try again.'

export function WorkspaceProjects({ onSelectTask }: { onSelectTask: (taskId: TaskId | null) => void }) {
  const [projectRequest, setProjectRequest] = useState(FIRST_PROJECT_PAGE)
  const projectsQuery = useWorkspaceProjects(projectRequest)
  const [projects, setProjects] = useState<WorkspaceProjectReadPage['items']>([])
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(null)
  const [projectSearch, setProjectSearch] = useState('')
  const [taskSearch, setTaskSearch] = useState('')
  const [selectedTaskId, setSelectedTaskId] = useState<TaskId | null>(null)
  const [taskRequest, setTaskRequest] = useState<WorkspaceRequest<'workspace:listTasks'> | null>(null)
  const tasksQuery = useWorkspaceTasks(taskRequest)
  const [tasks, setTasks] = useState<WorkspaceTaskReadPage['items']>([])
  const [registerName, setRegisterName] = useState('')
  const [registerPath, setRegisterPath] = useState('')
  const [taskTitle, setTaskTitle] = useState('')
  const [taskDescription, setTaskDescription] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [registrationNotice, setRegistrationNotice] = useState<string | null>(null)
  const [registering, setRegistering] = useState(false)
  const [creatingTask, setCreatingTask] = useState(false)
  const activeProjectId = useRef<ProjectId | null>(selectedProjectId)

  useEffect(() => {
    activeProjectId.current = selectedProjectId
  }, [selectedProjectId])

  useEffect(() => {
    if (projectsQuery.status !== 'ready' || !projectsQuery.data) return
    const page = projectsQuery.data
    if (page) setProjects(previous => appendUniquePage(previous, page.items))
  }, [projectsQuery.data, projectsQuery.status, projectRequest])

  useEffect(() => {
    if (!taskRequest || tasksQuery.status !== 'ready' || !tasksQuery.data) return
    if (activeProjectId.current !== taskRequest.projectId) return
    const page = tasksQuery.data
    if (page) setTasks(previous => appendUniquePage(previous, page.items))
  }, [taskRequest, tasksQuery.data, tasksQuery.status])

  const selectedProject = projects.find(project => project.id === selectedProjectId) ?? null
  const filteredProjects = useMemo(
    () => searchLoaded(projects, projectSearch, project => [project.name, project.repositoryIdentity]),
    [projects, projectSearch],
  )
  const filteredTasks = useMemo(
    () => searchLoaded(tasks, taskSearch, task => [task.title, task.description, task.id]),
    [tasks, taskSearch],
  )

  function selectProject(projectId: ProjectId) {
    if (projectId === selectedProjectId) return
    activeProjectId.current = projectId
    setSelectedProjectId(projectId)
    setTasks([])
    setTaskRequest({ projectId, options: { limit: PAGE_SIZE } })
    setTaskSearch('')
    setSelectedTaskId(null)
    onSelectTask(null)
  }

  async function registerProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const projectSelectedAtSubmit = activeProjectId.current
    setActionError(null)
    setRegistrationNotice(null)
    setRegistering(true)
    try {
      const receipt = await registerCommand.execute({
        path: registerPath.trim(),
        name: registerName.trim(),
      })
      const project = receipt.project
      setProjects(previous => appendUniquePage(previous, [project]))
      if (activeProjectId.current === projectSelectedAtSubmit) {
        activeProjectId.current = project.id
        setSelectedProjectId(project.id)
        setTasks([])
        setTaskRequest({ projectId: project.id, options: { limit: PAGE_SIZE } })
        setSelectedTaskId(null)
        onSelectTask(null)
      }
      setRegistrationNotice(
        receipt.reused
          ? `Using the existing Project “${project.name}” at ${receipt.mainCheckout.path}.`
          : `Registered “${project.name}” at ${receipt.mainCheckout.path}.`,
      )
      setRegisterName('')
      setRegisterPath('')
      setProjectRequest({ options: { limit: PAGE_SIZE } })
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
      const taskId = receipt.taskId
      setSelectedTaskId(taskId)
      onSelectTask(taskId)
      setTaskTitle('')
      setTaskDescription('')
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
    <section aria-label="Projects and tasks" className="space-y-3">
      <header className="shrink-0">
        <h1 className="text-foreground text-lg font-semibold">Projects and tasks</h1>
        <p className="text-muted-foreground text-xs">
          Browse registered Projects and create Tasks for a local checkout.
        </p>
      </header>

      {actionError && (
        <p role="alert" className="text-destructive text-xs">
          {actionError}
        </p>
      )}
      {registrationNotice && (
        <p role="status" className="text-muted-foreground text-xs">
          {registrationNotice}
        </p>
      )}

      <div className="grid gap-3">
        <Panel title="Register a Project" className="shrink-0">
          <form onSubmit={registerProject} className="space-y-2">
            <label className="text-muted-foreground block text-xs" htmlFor="workspace-project-name">
              Project name
            </label>
            <Input
              id="workspace-project-name"
              value={registerName}
              onChange={event => setRegisterName(event.target.value)}
              required
              maxLength={512}
            />
            <label className="text-muted-foreground block text-xs" htmlFor="workspace-project-path">
              Local repository path
            </label>
            <Input
              id="workspace-project-path"
              value={registerPath}
              onChange={event => setRegisterPath(event.target.value)}
              required
              placeholder="C:\\src\\project"
            />
            <Button type="submit" size="sm" disabled={registering || !registerName.trim() || !registerPath.trim()}>
              {registering ? 'Registering…' : 'Register Project'}
            </Button>
          </form>
          <div className="border-border mt-4 border-t pt-3">
            <label className="text-muted-foreground mb-1 block text-xs" htmlFor="workspace-project-search">
              Search loaded Projects
            </label>
            <Input
              id="workspace-project-search"
              type="search"
              value={projectSearch}
              onChange={event => setProjectSearch(event.target.value)}
              placeholder="Name, path, or identity"
            />
            <p className="text-muted-foreground mt-1 text-[10px]">
              Search covers the {projects.length} Project records loaded so far.
            </p>
            <QueryErrorNotice error={projectsQuery.error} hasData={projects.length > 0} />
            {projectsQuery.status === 'loading' && projects.length === 0 ? (
              <p role="status" className="text-muted-foreground py-3 text-xs">
                Loading Projects…
              </p>
            ) : filteredProjects.length === 0 ? (
              <p className="text-muted-foreground py-3 text-xs">
                {projects.length ? 'No loaded Projects match this search.' : 'No registered Projects yet.'}
              </p>
            ) : (
              <ul aria-label="Loaded Projects" className="mt-2 max-h-64 space-y-1 overflow-auto">
                {filteredProjects.map(project => (
                  <li key={project.id}>
                    <button
                      type="button"
                      onClick={() => selectProject(project.id)}
                      aria-current={selectedProjectId === project.id ? 'true' : undefined}
                      className={`focus-visible:ring-ring w-full rounded-md px-2 py-1.5 text-left text-xs outline-none focus-visible:ring-2 ${selectedProjectId === project.id ? 'bg-accent text-foreground' : 'hover:bg-muted text-muted-foreground'}`}
                    >
                      <span className="block truncate font-medium">{project.name}</span>
                      <span className="block truncate font-mono text-[10px]">{project.repositoryIdentity}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-muted-foreground mt-1 text-[10px]">
              {projects.length} loaded of {projectPage?.total ?? '…'} total
            </p>
            {projectCanLoadMore && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => {
                  const afterId = projectPage?.nextAfterId
                  if (afterId) setProjectRequest({ options: { afterId, limit: PAGE_SIZE } })
                }}
              >
                Load next Project page
              </Button>
            )}
          </div>
        </Panel>

        <Panel title={selectedProject ? `Tasks · ${selectedProject.name}` : 'Tasks'} className="flex flex-col">
          {!selectedProject ? (
            <p className="text-muted-foreground text-xs">Select a Project to browse and create its Tasks.</p>
          ) : (
            <div className="flex flex-col gap-3">
              <form onSubmit={createTask} className="grid shrink-0 gap-2">
                <label className="sr-only" htmlFor="workspace-task-title">
                  Task title
                </label>
                <Input
                  id="workspace-task-title"
                  value={taskTitle}
                  onChange={event => setTaskTitle(event.target.value)}
                  placeholder="Task title"
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
                <Button type="submit" size="sm" disabled={creatingTask || !taskTitle.trim()}>
                  {creatingTask ? 'Creating…' : 'Create Task'}
                </Button>
              </form>
              <div className="shrink-0">
                <label className="text-muted-foreground mb-1 block text-xs" htmlFor="workspace-task-search">
                  Search loaded Tasks
                </label>
                <Input
                  id="workspace-task-search"
                  type="search"
                  value={taskSearch}
                  onChange={event => setTaskSearch(event.target.value)}
                  placeholder="Title, description, or ID"
                />
                <p className="text-muted-foreground mt-1 text-[10px]">
                  Search covers the {tasks.length} Task records loaded for this Project.
                </p>
              </div>
              <QueryErrorNotice error={tasksQuery.error} hasData={tasks.length > 0} />
              {selectedTaskId && (
                <p role="status" className="text-primary shrink-0 text-[10px]">
                  Selected Task: {selectedTaskId}
                </p>
              )}
              {tasksQuery.status === 'loading' && tasks.length === 0 ? (
                <p role="status" className="text-muted-foreground text-xs">
                  Loading Tasks…
                </p>
              ) : filteredTasks.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  {tasks.length ? 'No loaded Tasks match this search.' : 'No Tasks for this Project yet.'}
                </p>
              ) : (
                <ul aria-label="Loaded Tasks" className="max-h-80 space-y-1 overflow-auto">
                  {filteredTasks.map(task => (
                    <li key={task.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedTaskId(task.id)
                          onSelectTask(task.id)
                        }}
                        aria-current={selectedTaskId === task.id ? 'true' : undefined}
                        className={`focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-left outline-none focus-visible:ring-2 ${selectedTaskId === task.id ? 'border-primary bg-accent' : 'border-border hover:bg-muted'}`}
                      >
                        <span className="text-foreground block truncate text-xs font-medium">{task.title}</span>
                        <span className="text-muted-foreground block truncate text-[10px]">
                          {task.description || task.id}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="text-muted-foreground flex shrink-0 items-center justify-between text-[10px]">
                <span>
                  {tasks.length} loaded of {taskPage?.total ?? '…'} total
                </span>
                {taskCanLoadMore && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const afterId = taskPage?.nextAfterId
                      if (afterId && selectedProjectId)
                        setTaskRequest({ projectId: selectedProjectId, options: { afterId, limit: PAGE_SIZE } })
                    }}
                  >
                    Load next Task page
                  </Button>
                )}
              </div>
            </div>
          )}
        </Panel>
      </div>
    </section>
  )
}
