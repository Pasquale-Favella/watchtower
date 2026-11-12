import { ArrowUp } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import {
  useCreateTask,
  useCreateWorktree,
  useStartRun,
  useSwitchBranch,
  useWorkspaceBranches,
} from '@/renderer/features/workspace/hooks.js'
import type { WorkspaceRequest } from '@/renderer/features/workspace/lib.js'
import type { AgentAccessMode } from '@/shared/schemas/execution.js'
import type { PromptAttachment } from '@/shared/schemas/prompt-context.js'
import type { DraftTerminalTarget } from '@/shared/schemas/terminal.js'
import type { ConversationId, ProjectId, TaskId, WorkspaceCheckoutId } from '@/shared/schemas/workspace.js'
import type { WorkspaceProjectRegistration } from '@/shared/schemas/workspace-projects.js'
import type { WorkspaceProjectReadPage } from '@/shared/schemas/workspace-store.js'

import { useWorkspaceAgentPreferences } from './agent-preferences.js'
import type { CheckoutMode } from './checkout-strip-state.js'
import { shouldSubmitComposerKey } from './composer-state.js'
import { configOptionsForModel, configValuesForOptions } from './config-values.js'
import { useInspectWorkspaceConnection, useWorkspaceConnections } from './connection-hooks.js'
import { resolveAccessMode } from './model-picker/access-mode.js'
import { PermissionsChip } from './model-picker/permissions.js'
import { useEnsureScratchProject, useNewChatDraft, useNewChatProject, useNewChatProjects } from './new-chat-hooks.js'
import { NEW_CHAT_DRAFT_MAX_LENGTH, newChatTaskTitle } from './new-chat-state.js'
import { parseWorkspacePromptCommand } from './prompt-command.js'
import { usePromptAttachments } from './prompt-context-hooks.js'
import { filePromptToken, promptWithAttachments } from './prompt-editor.js'
import {
  promptWithReviewComments,
  type ReviewComment,
  reviewCommentsIncludedInPrompt,
} from './review/review-comments.js'
import { useReviewComments } from './review/use-review-comments.js'
import { rememberRightPanelSurface, resourceSurface, transferRightPanelState } from './right-panel/right-panel-state.js'
import { useRightPanel } from './right-panel/use-right-panel.js'
import { useTerminalAdoption } from './terminal/use-terminal-adoption.js'
import { useTerminalDrawer } from './terminal/use-terminal-drawer.js'
import { PREVIOUS_CHECKOUT_DRAWER } from './terminal/use-terminal-group-context.js'
import { type TerminalExcerpt, WorkspaceTerminalDrawer } from './terminal/WorkspaceTerminalDrawer.js'
import { usePendingStart } from './use-pending-start.js'
import { transferDraftPanelContext, useDraftPanelContext } from './use-workspace-panel-context.js'
import { useWorkspacePanelResources } from './use-workspace-panel-resources.js'
import { WorkspaceAgentPicker } from './WorkspaceAgentPicker.js'
import { WorkspaceChatHeader } from './WorkspaceChatHeader.js'
import { CheckoutStrip } from './WorkspaceCheckoutStrip.js'
import type { WorkspaceImageContext } from './WorkspaceImageAnnotation.js'
import { WorkspacePanelHost } from './WorkspacePanelHost.js'
import { WorkspaceProjectPicker } from './WorkspaceProjectPicker.js'
import type { PromptInputHandle } from './WorkspacePromptEditor.js'
import { WorkspacePromptInput } from './WorkspacePromptInput.js'
import { WorkspaceRunDetails } from './WorkspaceRunDetails.js'

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
  readonly configValues: Readonly<Record<string, string>>
  readonly accessMode: AgentAccessMode
  /** Set when the chat runs in a new worktree created from this base branch. */
  readonly worktree: { readonly commandId: string; readonly baseBranch: string } | null
  readonly title: string
  readonly prompt: string
  readonly draftValue: string
  readonly attachments: readonly PromptAttachment[]
  readonly startCommandId: string
  readonly terminalTarget: DraftTerminalTarget
  readonly panelKey: string
  readonly reviewComments: readonly ReviewComment[]
}

const projectRequest = (projectId: ProjectId | null): WorkspaceRequest<'workspace:getProject'> | null =>
  projectId ? { projectId } : null

export function WorkspaceNewChat({ projectId, onStarted, onProjectChange }: Props) {
  const panelContext = useDraftPanelContext(projectId)
  const panel = useRightPanel(panelContext.key)
  const terminal = useTerminalDrawer(panelContext.target)
  const terminalAdoption = useTerminalAdoption()
  const resources = useWorkspacePanelResources(panelContext.key, panel)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const { draft, setDraft, clearDraft, copyDraftToConversation, clearConversationDraft, saveConversationPreference } =
    useNewChatDraft()
  const attachments = usePromptAttachments('new-chat')
  const reviewComments = useReviewComments(panelContext.key)
  const draftRef = useRef(draft)
  const promptRef = useRef<PromptInputHandle>(null)
  const agentPickerRef = useRef<{ open: (query?: string) => void }>(null)
  const creationLock = useRef(false)
  const {
    connectionId,
    setConnectionId,
    modelId,
    setModelId,
    modeId,
    setModeId,
    configValues: rememberedConfigValues,
    setConfigValue,
    accessMode,
    setAccessMode,
  } = useWorkspaceAgentPreferences()
  const inspectedConnection = useRef('')
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
  const createWorktree = useCreateWorktree()
  const switchBranch = useSwitchBranch()
  const startRun = useStartRun()
  const pendingStarts = usePendingStart()
  const inspected = inspect.data?.connectionId === connectionId ? inspect.data : null
  const selectedConnection = connections.data?.items.find(item => item.connectionId === connectionId) ?? null
  const capabilities = inspected?.capabilities
  const configOptions = configOptionsForModel(
    capabilities?.configOptions ?? [],
    capabilities?.models.items.find(model => model.id === modelId),
  )
  const canSubmit = Boolean(
    selectedConnection &&
    inspected &&
    inspected.driverId === selectedConnection.driverId &&
    capabilities?.openSession.support === 'supported' &&
    capabilities.submit.support === 'supported',
  )
  const access = resolveAccessMode(accessMode, inspected?.accessModes)
  const attachmentBlocked = attachments.items.some(item =>
    item.mediaType.startsWith('image/') ? !capabilities?.promptContent?.images : !capabilities?.promptContent?.files,
  )
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
  // Keyed by Project, so choosing another Project starts again from its current checkout.
  const [checkoutChoice, setCheckoutChoice] = useState<{
    readonly projectId: ProjectId | null
    readonly mode: CheckoutMode
    readonly baseBranch: string | null
  }>({ projectId, mode: 'local', baseBranch: null })
  const checkout =
    checkoutChoice.projectId === projectId ? checkoutChoice : { projectId, mode: 'local' as const, baseBranch: null }
  const [branchError, setBranchError] = useState<string | null>(null)
  const gitProject = Boolean(projectId && selectedProject && !archivedProject)
  const branchRequest = useMemo(() => (gitProject && projectId ? { projectId } : null), [gitProject, projectId])
  const branches = useWorkspaceBranches(branchRequest)
  const currentBranch = branches.data?.current ?? null
  const shownBranch = checkout.mode === 'worktree' ? (checkout.baseBranch ?? currentBranch) : currentBranch
  const selectBranch = (branch: string) => {
    setBranchError(null)
    if (checkout.mode === 'worktree') {
      setCheckoutChoice({ projectId, mode: 'worktree', baseBranch: branch })
      return
    }
    if (!projectId || !project.data) return
    switchBranch
      .execute({ projectId, checkoutId: project.data.mainCheckout.id, branch })
      .catch(cause => setBranchError(cause instanceof Error ? cause.message : 'Could not switch branches.'))
  }

  useEffect(() => {
    draftRef.current = draft
  }, [draft])
  const inspectSelectedConnection = inspect.execute
  const inspectingConnection = inspect.pending
  useEffect(() => {
    if (!selectedConnection || inspected || inspectingConnection || inspectedConnection.current === connectionId) return
    inspectedConnection.current = connectionId
    void inspectSelectedConnection({ connectionId }).catch(() => {})
  }, [selectedConnection, inspected, inspectingConnection, connectionId, inspectSelectedConnection])

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
      // The worktree is made on send, before the Task, so a refused worktree leaves nothing behind.
      const worktree = creation.worktree
        ? await createWorktree.execute({
            commandId: creation.worktree.commandId,
            projectId: targetProjectId,
            baseBranch: creation.worktree.baseBranch,
          })
        : null
      const receipt = await createTask.execute({
        commandId: creation.commandId,
        projectId: targetProjectId,
        title: creation.title,
        description: '',
      })
      setCreating(false)
      creationLock.current = false

      reviewComments.copyTo(receipt.conversationId, creation.reviewComments)
      const checkoutId = worktree?.id ?? target?.mainCheckout.id ?? creation.checkoutId
      const adoptedTerminals = await terminalAdoption.adopt(
        creation.terminalTarget,
        receipt.taskId,
        checkoutId ?? undefined,
      )
      transferRightPanelState(creation.panelKey, receipt.taskId)
      const previousDrawer = terminalAdoption.drawerState(creation.terminalTarget)
      if (!adoptedTerminals && previousDrawer?.terminals?.length)
        rememberRightPanelSurface(
          receipt.taskId,
          resourceSurface('terminal', PREVIOUS_CHECKOUT_DRAWER),
          previousDrawer.open,
        )
      transferDraftPanelContext(creation.terminalTarget, creation.panelKey, receipt.taskId)
      if (!checkoutId) {
        const retained = draftRef.current
        copyDraftToConversation(receipt.conversationId, retained)
        onStarted(targetProjectId, receipt.taskId, receipt.conversationId)
        return
      }

      const retained = draftRef.current
      copyDraftToConversation(receipt.conversationId, retained)
      attachments.copyTo(receipt.conversationId, creation.attachments)
      saveConversationPreference(
        receipt.conversationId,
        checkoutId,
        creation.connectionId,
        creation.modelId ?? '',
        creation.modeId ?? '',
        creation.accessMode,
        creation.configValues,
      )
      const command: WorkspaceRequest<'workspace:startRun'> = {
        commandId: creation.startCommandId,
        taskId: receipt.taskId,
        conversationId: receipt.conversationId,
        checkoutId,
        generation: 1,
        driverId: creation.driverId,
        connectionId: creation.connectionId,
        prompt: creation.prompt,
        attachments: creation.attachments,
        modelId: creation.modelId,
        modeId: creation.modeId,
        accessMode: creation.accessMode,
        ...(Object.keys(creation.configValues).length > 0 ? { configValues: creation.configValues } : {}),
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
      clearDraft(creation.draftValue)
      clearConversationDraft(receipt.conversationId, creation.draftValue)
      attachments.clearCaptured(creation.attachments)
      onStarted(targetProjectId, receipt.taskId, receipt.conversationId)
      try {
        await startRun.execute(command)
        reviewComments.clearCaptured(creation.reviewComments)
        reviewComments.clearIn(receipt.conversationId, creation.reviewComments)
        attachments.clearIn(receipt.conversationId, creation.attachments)
      } catch {
        // The Conversation owns delivery errors after navigation.
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
    const promptCommand = parseWorkspacePromptCommand(draft, [])
    if (promptCommand?.kind === 'model') {
      writeDraft('')
      agentPickerRef.current?.open(promptCommand.query)
      return
    }
    if (promptCommand?.kind === 'clear') return
    const prompt = promptWithReviewComments(promptWithAttachments(draft, attachments.items), reviewComments.items)
    if (
      !prompt ||
      attachmentBlocked ||
      !selectedConnection ||
      !canSubmit ||
      creating ||
      starting ||
      !projectReady ||
      intent
    )
      return
    const creation: CreationIntent = {
      commandId: crypto.randomUUID(),
      projectId,
      checkoutId: projectId ? (project.data?.mainCheckout.id ?? null) : null,
      connectionId: selectedConnection.connectionId,
      driverId: selectedConnection.driverId,
      modelId: modelId || null,
      modeId: modeId || null,
      configValues: configValuesForOptions(configOptions, rememberedConfigValues),
      accessMode: access.mode,
      worktree:
        projectId && checkout.mode === 'worktree'
          ? { commandId: crypto.randomUUID(), baseBranch: shownBranch ?? 'HEAD' }
          : null,
      title: newChatTaskTitle(prompt),
      prompt,
      draftValue: draft,
      attachments: [...attachments.items],
      startCommandId: crypto.randomUUID(),
      terminalTarget: panelContext.target,
      panelKey: panelContext.key,
      reviewComments: [...reviewCommentsIncludedInPrompt(prompt, reviewComments.items)],
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
  const keyDown = (event: globalThis.KeyboardEvent) => {
    if (!shouldSubmitComposerKey({ key: event.key, shiftKey: event.shiftKey, isComposing: event.isComposing })) return
    event.preventDefault()
    submit()
  }
  const selectProject = (projectId: ProjectId | null) => {
    onProjectChange(projectId)
    promptRef.current?.focus()
  }
  const permissionsChip = (
    <PermissionsChip size="xs" mode={access.mode} options={access.options} onChange={setAccessMode} />
  )
  function writeDraft(text: string): void {
    draftRef.current = text
    setDraft(text)
  }
  function appendToDraft(addition: string): void {
    writeDraft(`${draftRef.current}${draftRef.current ? '\n\n' : ''}${addition}`)
    promptRef.current?.focus()
  }
  function addTerminalExcerpt(excerpt: TerminalExcerpt & { readonly label: string }): void {
    appendToDraft(`${excerpt.label}, lines ${excerpt.lineStart}-${excerpt.lineEnd}:\n${excerpt.text}`)
  }
  function referencePath(path: string): void {
    const text = draftRef.current
    writeDraft(`${text}${text && !/\s$/.test(text) ? ' ' : ''}${filePromptToken(path)}`)
    promptRef.current?.focus()
  }
  async function addImage(image: WorkspaceImageContext): Promise<void> {
    const separator = image.dataUrl.indexOf(',')
    const item = await attachments.importFile({
      name: 'workspace-screenshot.png',
      mediaType: 'image/png',
      data: image.dataUrl.slice(separator + 1),
    })
    attachments.add(item)
    appendToDraft(image.text)
  }

  return (
    <>
      <WorkspaceChatHeader
        project={selectedProject?.name ?? 'No project'}
        title="New chat"
        terminalOpen={terminal.open}
        onToggleTerminal={terminal.toggle}
        panelOpen={panel.open}
        onTogglePanel={panel.toggle}
        detailsOpen={detailsOpen}
        onToggleDetails={() => setDetailsOpen(open => !open)}
      />
      <WorkspaceRunDetails open={detailsOpen} onOpenChange={setDetailsOpen} />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${panel.maximized ? 'min-[980px]:hidden' : ''}`}
        >
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto px-4 py-8">
            <section className="max-w-chat w-full" aria-label="New chat">
              <div className="mb-8 flex flex-col items-center gap-2 text-center">
                {projectId && selectedProject && !archivedProject ? (
                  <>
                    <h2 className="flex w-full flex-wrap items-baseline justify-center gap-x-2 text-2xl font-normal tracking-tight sm:text-3xl">
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
                    </h2>
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
                    <h2 className="text-2xl font-normal tracking-tight sm:text-3xl">What should we work on?</h2>
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
              <WorkspacePromptInput
                reviewOwnerKey={panelContext.key}
                value={draft}
                onChange={writeDraft}
                onKeyDown={keyDown}
                inputRef={promptRef}
                autoFocus
                attachments={attachments}
                projectId={projectId}
                connectionId={connectionId}
                maxLength={NEW_CHAT_DRAFT_MAX_LENGTH}
                onOpenModelPicker={query => agentPickerRef.current?.open(query)}
                controls={
                  <WorkspaceAgentPicker
                    controlRef={agentPickerRef}
                    connections={connections.data?.items ?? []}
                    connectionId={connectionId}
                    modelId={modelId}
                    modeId={modeId}
                    configValues={rememberedConfigValues}
                    inspection={inspected}
                    pending={inspect.pending}
                    access={{ ...access, onChange: setAccessMode }}
                    onConnectionChange={selected => {
                      setConnectionId(selected)
                    }}
                    onModelChange={id => {
                      setModelId(id, inspected?.capabilities.configOptions ?? [])
                      setModeId('')
                    }}
                    onModeChange={setModeId}
                    onConfigValueChange={setConfigValue}
                  />
                }
                contextStrip={
                  gitProject ? (
                    <CheckoutStrip
                      mode={checkout.mode}
                      onModeChange={mode => {
                        setBranchError(null)
                        setCheckoutChoice({ projectId, mode, baseBranch: checkout.baseBranch })
                      }}
                      branch={shownBranch}
                      branches={branches.data}
                      pending={switchBranch.pending}
                      disabled={creating || starting || switchBranch.pending}
                      onBranchSelect={selectBranch}
                      error={branchError ?? branches.error}
                      trailing={permissionsChip}
                    />
                  ) : (
                    <div className="ms-auto">{permissionsChip}</div>
                  )
                }
                actions={
                  <Button
                    type="button"
                    size="icon-sm"
                    className="rounded-full"
                    aria-label="Send"
                    title="Send"
                    disabled={
                      !promptWithReviewComments(
                        promptWithAttachments(draft, attachments.items),
                        reviewComments.items,
                      ) ||
                      attachmentBlocked ||
                      !canSubmit ||
                      creating ||
                      starting ||
                      !projectReady ||
                      Boolean(intent)
                    }
                    onClick={submit}
                  >
                    <ArrowUp />
                  </Button>
                }
              />
              {attachmentBlocked && (
                <p className="text-muted-foreground mt-2 text-xs" role="status">
                  The selected agent has not confirmed support for these attachments. Choose a compatible agent or
                  remove them.
                </p>
              )}
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
              {archivedProject && (
                <div className="mt-3 flex items-center justify-center gap-2 text-sm" role="status">
                  <span>This Project is archived.</span>
                  <Button type="button" size="sm" variant="outline" onClick={() => onProjectChange(null)}>
                    Continue with No project
                  </Button>
                </div>
              )}
            </section>
          </div>
          <WorkspaceTerminalDrawer
            target={panelContext.target}
            open={terminal.open}
            onOpenLink={url => resources.openBrowser(url)}
            onAddToChat={addTerminalExcerpt}
          />
        </div>
        <WorkspacePanelHost
          projectId={projectReady ? (projectId ?? undefined) : undefined}
          panel={panel}
          resources={resources}
          ownerKey={panelContext.key}
          terminalTarget={panelContext.target}
          onToggleTerminal={terminal.toggle}
          onAddImage={addImage}
          onReferenceText={appendToDraft}
          refreshKey={0}
          onReferencePath={referencePath}
          onAddToChat={addTerminalExcerpt}
        />
      </div>
    </>
  )
}
