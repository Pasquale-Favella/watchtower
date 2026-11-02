import { ArrowUp } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import { useCreateTask, useStartRun } from '@/renderer/features/workspace/hooks.js'
import type { WorkspaceRequest } from '@/renderer/features/workspace/lib.js'
import type { ConversationId, ProjectId, TaskId, WorkspaceCheckoutId } from '@/shared/schemas/workspace.js'
import type { WorkspaceProjectRegistration } from '@/shared/schemas/workspace-projects.js'
import type { WorkspaceProjectReadPage } from '@/shared/schemas/workspace-store.js'

import { shouldSubmitComposerKey } from './composer-state.js'
import { useInspectWorkspaceConnection, useWorkspaceConnections } from './connection-hooks.js'
import { useEnsureScratchProject, useNewChatDraft, useNewChatProject, useNewChatProjects } from './new-chat-hooks.js'
import { NEW_CHAT_DRAFT_MAX_LENGTH, newChatTaskTitle } from './new-chat-state.js'
import { canClearCapturedDraft } from './pending-start-state.js'
import { usePendingStart } from './use-pending-start.js'
import { WorkspaceProjectPicker } from './WorkspaceProjectPicker.js'

type Props = {
  readonly projectId: ProjectId | null
  readonly onStarted: (projectId: ProjectId, taskId: TaskId, conversationId: ConversationId) => void
  readonly onProjectChange: (projectId: ProjectId | null) => void
}

type CreationIntent = {
  readonly commandId: string
  readonly projectId: ProjectId | null
  readonly checkoutId: WorkspaceCheckoutId | null
  readonly connectionId: string
  readonly driverId: string
  readonly modelId: string | null
  readonly modeId: string | null
  readonly title: string
  readonly prompt: string
  readonly draftValue: string
  readonly startCommandId: string
}

const projectRequest = (projectId: ProjectId | null): WorkspaceRequest<'workspace:getProject'> | null =>
  projectId ? { projectId } : null

export function WorkspaceNewChat({ projectId, onStarted, onProjectChange }: Props) {
  const { draft, setDraft, clearDraft, copyDraftToConversation, clearConversationDraft, saveConversationPreference } =
    useNewChatDraft()
  const draftRef = useRef(draft)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const creationLock = useRef(false)
  const [connectionId, setConnectionId] = useState('')
  const [modelId, setModelId] = useState('')
  const [modeId, setModeId] = useState('')
  const [projectCursor, setProjectCursor] = useState<string | undefined>()
  const [priorProjectPages, setPriorProjectPages] = useState<WorkspaceProjectReadPage['items']>([])
  const [intent, setIntent] = useState<CreationIntent | null>(null)
  const [creating, setCreating] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const projectListRequest = useMemo<WorkspaceRequest<'workspace:listProjects'>>(
    () => ({ options: { limit: 50, ...(projectCursor ? { afterId: projectCursor } : {}) } }),
    [projectCursor],
  )
  const projects = useNewChatProjects(projectListRequest)
  const projectReadRequest = useMemo(() => projectRequest(projectId), [projectId])
  const project = useNewChatProject(projectReadRequest)
  const connections = useWorkspaceConnections()
  const inspect = useInspectWorkspaceConnection()
  const ensureScratch = useEnsureScratchProject()
  const createTask = useCreateTask()
  const startRun = useStartRun()
  const pendingStarts = usePendingStart()
  const inspected = inspect.data?.connectionId === connectionId ? inspect.data : null
  const selectedConnection = connections.data?.items.find(item => item.connectionId === connectionId) ?? null
  const capabilities = inspected?.capabilities
  const canSubmit = Boolean(
    selectedConnection &&
    inspected &&
    inspected.driverId === selectedConnection.driverId &&
    capabilities?.openSession.support === 'supported' &&
    capabilities.submit.support === 'supported',
  )
  const modelChoices = capabilities?.models.state === 'session-scoped' ? capabilities.models.items : []
  const modeChoices = capabilities?.modes.state === 'session-scoped' ? capabilities.modes.items : []
  const registeredProjects = useMemo(() => {
    const byId = new Map<string, WorkspaceProjectReadPage['items'][number]>()
    for (const candidate of [...priorProjectPages, ...(projects.data?.items ?? [])]) {
      if (!candidate.isScratch && !candidate.archivedAt) byId.set(candidate.id, candidate)
    }
    return [...byId.values()]
  }, [priorProjectPages, projects.data])
  const selectedProject = project.data?.project.isScratch ? null : (project.data?.project ?? null)
  const pickerProjects = useMemo(() => {
    if (
      !selectedProject ||
      selectedProject.isScratch ||
      selectedProject.archivedAt ||
      registeredProjects.some(item => item.id === selectedProject.id)
    )
      return registeredProjects
    return [selectedProject, ...registeredProjects]
  }, [registeredProjects, selectedProject])
  const archivedProject = selectedProject?.archivedAt ? selectedProject : null

  useEffect(() => {
    draftRef.current = draft
  }, [draft])

  const inspectConnection = () => {
    if (!connectionId) return
    setError(null)
    inspect.execute({ connectionId }).catch(cause => {
      setError(cause instanceof Error ? cause.message : 'Connection inspection failed.')
    })
  }

  const loadMoreProjects = () => {
    const page = projects.data
    if (!page?.nextAfterId) return
    setPriorProjectPages(current => {
      const byId = new Map(current.map(candidate => [candidate.id, candidate]))
      for (const candidate of page.items) byId.set(candidate.id, candidate)
      return [...byId.values()]
    })
    setProjectCursor(page.nextAfterId)
  }

  const createAndStart = async (creation: CreationIntent) => {
    if (creationLock.current || creating || starting) return
    creationLock.current = true
    setIntent(creation)
    setCreating(true)
    setError(null)
    try {
      let target: WorkspaceProjectRegistration | null = null
      let targetProjectId = creation.projectId
      if (!targetProjectId) {
        target = await ensureScratch.execute()
        targetProjectId = target.project.id
      }
      const receipt = await createTask.execute({
        commandId: creation.commandId,
        projectId: targetProjectId,
        title: creation.title,
        description: '',
      })
      setCreating(false)
      creationLock.current = false

      const checkoutId = target?.mainCheckout.id ?? creation.checkoutId
      if (!checkoutId) {
        const retained = draftRef.current
        copyDraftToConversation(receipt.conversationId, retained)
        onStarted(targetProjectId, receipt.taskId, receipt.conversationId)
        return
      }

      const retained = draftRef.current
      copyDraftToConversation(receipt.conversationId, retained)
      saveConversationPreference(receipt.conversationId, checkoutId, creation.connectionId)
      const command: WorkspaceRequest<'workspace:startRun'> = {
        commandId: creation.startCommandId,
        taskId: receipt.taskId,
        conversationId: receipt.conversationId,
        checkoutId,
        generation: 1,
        driverId: creation.driverId,
        connectionId: creation.connectionId,
        prompt: creation.prompt,
        modelId: creation.modelId,
        modeId: creation.modeId,
        nativeSessionId: null,
        retryOfRunId: null,
      }
      const captured = pendingStarts.capture({
        conversationId: receipt.conversationId,
        command,
        rawDraft: creation.draftValue,
      })
      if (captured.error || captured.records[receipt.conversationId]?.command.commandId !== command.commandId) {
        onStarted(targetProjectId, receipt.taskId, receipt.conversationId)
        setError(captured.error ?? 'The Run intent could not be saved. It was not started.')
        return
      }
      setStarting(true)
      onStarted(targetProjectId, receipt.taskId, receipt.conversationId)
      try {
        await startRun.execute(command)
        const cleared = pendingStarts.clear(receipt.conversationId, command.commandId)
        if (cleared.error || cleared.records[receipt.conversationId]) {
          setError(cleared.error ?? 'The Run completed, but its saved receipt could not be cleared.')
        } else if (canClearCapturedDraft(draftRef.current, creation.draftValue)) {
          clearDraft(creation.draftValue)
          clearConversationDraft(receipt.conversationId, creation.draftValue)
        }
      } catch (cause) {
        pendingStarts.markUncertain(receipt.conversationId, command.commandId)
        setError(
          cause instanceof Error ? cause.message : 'Run delivery is uncertain. Retry the saved command explicitly.',
        )
      } finally {
        setStarting(false)
      }
    } catch (cause) {
      setCreating(false)
      creationLock.current = false
      setError(
        cause instanceof Error ? cause.message : 'Task creation could not be confirmed. Retry this command safely.',
      )
    }
  }

  const submit = () => {
    const prompt = draft.trim()
    if (!prompt || !selectedConnection || !canSubmit || creating || starting || !projectReady || intent) return
    const creation: CreationIntent = {
      commandId: crypto.randomUUID(),
      projectId,
      checkoutId: projectId ? (project.data?.mainCheckout.id ?? null) : null,
      connectionId: selectedConnection.connectionId,
      driverId: selectedConnection.driverId,
      modelId: modelId || null,
      modeId: modeId || null,
      title: newChatTaskTitle(prompt),
      prompt,
      draftValue: draft,
      startCommandId: crypto.randomUUID(),
    }
    void createAndStart(creation)
  }

  const retryCreation = () => {
    if (intent) void createAndStart(intent)
  }

  const projectReady =
    projectId === null
      ? true
      : Boolean(
          project.data && !project.error && project.data.project.id === projectId && !project.data.project.archivedAt,
        )
  const keyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      !shouldSubmitComposerKey({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing })
    )
      return
    event.preventDefault()
    submit()
  }
  const selectProject = (projectId: ProjectId | null) => {
    onProjectChange(projectId)
    promptRef.current?.focus()
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto px-4 py-8">
      <section className="w-full max-w-3xl" aria-label="New chat">
        <div className="mb-8 flex flex-col items-center gap-2 text-center">
          {projectId && selectedProject && !archivedProject ? (
            <>
              <h1 className="flex w-full flex-wrap items-baseline justify-center gap-x-2 text-2xl font-normal tracking-tight sm:text-3xl">
                <span>What should we build in</span>
                <WorkspaceProjectPicker
                  projectId={projectId}
                  label={selectedProject.name}
                  projects={pickerProjects}
                  hasMore={Boolean(projects.data?.nextAfterId)}
                  disabled={creating || starting}
                  onSelect={selectProject}
                  onLoadMore={loadMoreProjects}
                  onRefresh={projects.refresh}
                />
                <span>?</span>
              </h1>
              <button
                type="button"
                disabled={creating || starting}
                className="text-muted-foreground hover:text-foreground rounded text-sm outline-none focus-visible:ring-2"
                onClick={() => selectProject(null)}
              >
                or start without a project
              </button>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-normal tracking-tight sm:text-3xl">What should we work on?</h1>
              <div className="text-muted-foreground text-sm">
                <WorkspaceProjectPicker
                  projectId={null}
                  label="No project"
                  projects={pickerProjects}
                  hasMore={Boolean(projects.data?.nextAfterId)}
                  disabled={creating || starting}
                  onSelect={selectProject}
                  onLoadMore={loadMoreProjects}
                  onRefresh={projects.refresh}
                />
              </div>
            </>
          )}
        </div>
        <div className="bg-card focus-within:border-ring focus-within:ring-ring/20 rounded-xl border shadow-sm focus-within:ring-2">
          <textarea
            ref={promptRef}
            aria-label="Prompt"
            autoFocus
            className="placeholder:text-muted-foreground min-h-32 w-full resize-y rounded-t-xl bg-transparent px-4 py-4 text-sm outline-none"
            placeholder="Describe the work to do…"
            maxLength={NEW_CHAT_DRAFT_MAX_LENGTH}
            value={draft}
            onChange={event => {
              draftRef.current = event.target.value
              setDraft(event.target.value)
            }}
            onKeyDown={keyDown}
          />
          <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
            <label className="sr-only" htmlFor="new-chat-connection">
              Harness connection
            </label>
            <select
              id="new-chat-connection"
              aria-label="Harness connection"
              className="bg-background max-w-64 rounded-md border px-2 py-1.5 text-xs"
              value={connectionId}
              onChange={event => {
                const selected = event.target.value
                setConnectionId(selected)
                setModelId('')
                setModeId('')
                if (selected) void inspect.execute({ connectionId: selected }).catch(() => {})
              }}
            >
              <option value="">Choose an agent</option>
              {connections.data?.items.map(connection => (
                <option key={connection.connectionId} value={connection.connectionId}>
                  {connection.label}
                </option>
              ))}
            </select>
            <span className="text-muted-foreground text-xs" role="status">
              {inspect.pending ? 'Checking connection…' : canSubmit ? 'Ready to send' : ''}
            </span>
            <span className="flex-1" />
            <Button
              type="button"
              size="icon-sm"
              className="rounded-full"
              aria-label="Send"
              title="Send"
              disabled={!draft.trim() || !canSubmit || creating || starting || !projectReady || Boolean(intent)}
              onClick={submit}
            >
              <ArrowUp />
            </Button>
          </div>
        </div>
        <details className="mt-3">
          <summary className="text-muted-foreground cursor-pointer text-xs">Run settings</summary>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!connectionId || inspect.pending}
              onClick={inspectConnection}
            >
              Check connection
            </Button>
            <p className="text-muted-foreground text-xs">Sign-in has not been verified.</p>
            <label className="flex items-center gap-2 text-xs">
              Model
              <select
                className="bg-background rounded-md border px-2 py-1.5"
                value={modelId}
                onChange={event => setModelId(event.target.value)}
                disabled={!modelChoices.length}
              >
                <option value="">
                  {capabilities?.models.state === 'session-scoped' ? 'Driver default' : 'Unknown · driver default'}
                </option>
                {modelChoices.map(choice => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-xs">
              Effort / mode
              <select
                className="bg-background rounded-md border px-2 py-1.5"
                value={modeId}
                onChange={event => setModeId(event.target.value)}
                disabled={!modeChoices.length}
              >
                <option value="">
                  {capabilities?.modes.state === 'session-scoped' ? 'Driver default' : 'Unknown · driver default'}
                </option>
                {modeChoices.map(choice => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </label>
            {project.data?.nextAfterCheckoutId && (
              <span className="text-muted-foreground text-xs">
                Checkout list is paged; the main checkout will be used.
              </span>
            )}
          </div>
          {capabilities &&
            (capabilities.openSession.restrictions.length > 0 || capabilities.submit.restrictions.length > 0) && (
              <p className="text-muted-foreground mt-2 text-xs" role="status">
                Restrictions:{' '}
                {[...new Set([...capabilities.openSession.restrictions, ...capabilities.submit.restrictions])].join(
                  ' · ',
                )}
              </p>
            )}
        </details>
        {inspected && !canSubmit && (
          <p className="text-muted-foreground mt-3 text-center text-xs" role="status">
            This agent cannot start a conversation with the selected setup.
          </p>
        )}
        {(error || inspect.error) && (
          <div className="mt-3 flex items-center justify-center gap-2 text-sm" role="alert">
            <span className="text-destructive">{error ?? inspect.error}</span>
            {intent && !creating && (
              <Button type="button" size="sm" variant="outline" onClick={retryCreation}>
                Retry
              </Button>
            )}
          </div>
        )}
        {(projects.error || connections.error || project.error) && (
          <p className="text-destructive mt-3 text-center text-sm" role="alert">
            {projects.error || connections.error || project.error}
          </p>
        )}
        {projectId && !project.data && !project.error && (
          <p className="text-muted-foreground mt-3 text-center text-xs" role="status">
            Loading selected Project…
          </p>
        )}
        {archivedProject && (
          <div className="mt-3 flex items-center justify-center gap-2 text-sm" role="status">
            <span>This Project is archived.</span>
            <Button type="button" size="sm" variant="outline" onClick={() => onProjectChange(null)}>
              Continue with No project
            </Button>
          </div>
        )}
        <p className="text-muted-foreground mt-3 text-center text-xs">
          Enter sends · Shift+Enter adds a line. Drafts stay in this new chat until you send.
        </p>
      </section>
    </div>
  )
}
