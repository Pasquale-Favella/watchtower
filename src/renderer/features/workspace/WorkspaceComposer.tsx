import { ArrowUp, ListPlus, Square } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import type { WorkspaceRequest } from '@/renderer/features/workspace/lib.js'
import type { AgentAccessMode } from '@/shared/schemas/execution.js'
import type { ConversationId, Task, WorkspaceCheckout } from '@/shared/schemas/workspace.js'

import { useWorkspaceAgentPreferences } from './agent-preferences.js'
import type { CheckoutMode } from './checkout-strip-state.js'
import {
  boundConversationSession,
  type ComposerAwaiting,
  composerPlaceholder,
  currentConversationRuns,
  isRunActive,
  isStopPrimary,
  resolveComposerDispatch,
  shouldSubmitComposerKey,
  validateResumeSelection,
} from './composer-state.js'
import { configOptionsForModel, configValuesForOptions, withoutModelSpecificConfigValues } from './config-values.js'
import {
  useInspectWorkspaceConnection,
  useWorkspaceConnectionCatalog,
  useWorkspaceConnections,
} from './connection-hooks.js'
import { WORKSPACE_DRAFT_MAX_LENGTH } from './draft-storage.js'
import {
  useCancelQueuedFollowUp,
  useCreateWorktree,
  useEnqueueFollowUp,
  useInterruptRun,
  usePromoteQueuedFollowUp,
  useStartRun,
  useSteerRun,
  useSwitchBranch,
  useWorkspaceBranches,
  useWorkspaceNativeAgentSessions,
  useWorkspacePendingRequests,
  useWorkspaceProject,
  useWorkspaceQueuedFollowUps,
  useWorkspaceTaskSnapshot,
} from './hooks.js'
import { createInitialCheckoutPreparation, initialWorktreeError } from './initial-checkout.js'
import type { WorkspaceCommandInput } from './lib.js'
import { resolveAccessMode } from './model-picker/access-mode.js'
import { PermissionsChip } from './model-picker/permissions.js'
import { canClearCapturedDraft } from './pending-start-state.js'
import { activeGoalControl, parseWorkspacePromptCommand } from './prompt-command.js'
import { usePromptAttachments } from './prompt-context-hooks.js'
import { promptWithAttachments, visiblePromptAttachments } from './prompt-editor.js'
import { firstPendingRequest } from './request-drawer-state.js'
import { promptWithReviewComments, reviewCommentsIncludedInPrompt } from './review/review-comments.js'
import { useReviewComments } from './review/use-review-comments.js'
import { useCreateSideChat } from './side-chat/hooks.js'
import { usePendingStart } from './use-pending-start.js'
import { usePromptHistory } from './use-prompt-history.js'
import { useDraftAppend, useWorkspaceDraft } from './use-workspace-draft.js'
import { WorkspaceAgentPicker } from './WorkspaceAgentPicker.js'
import { CheckoutStrip } from './WorkspaceCheckoutStrip.js'
import { WorkspacePromptInput } from './WorkspacePromptInput.js'
import { WorkspaceRequests } from './WorkspaceRequests.js'

type Intent =
  | {
      readonly kind: 'start'
      readonly command: WorkspaceRequest<'workspace:startRun'>
      readonly prompt: string
      readonly draftValue: string
    }
  | {
      readonly kind: 'enqueue'
      readonly command: WorkspaceCommandInput<'workspace:enqueueFollowUp'>
      readonly prompt: string
      readonly draftValue: string
    }
  | {
      readonly kind: 'steer'
      readonly command: WorkspaceCommandInput<'workspace:steer'>
      readonly prompt: string
      readonly draftValue: string
    }

const snapshotRequest = (taskId: Task['id']): WorkspaceRequest<'workspace:readTaskSnapshot'> => ({
  taskId,
  runLimit: 100,
})

type WorkspaceComposerProps = {
  readonly task: Task
  readonly conversationId: ConversationId
  readonly allowInitialCheckoutChoice?: boolean | undefined
  readonly onSideChatCreated?: ((id: string) => void) | undefined
}

/** Pinned prompt controls for one Conversation; execution ownership remains with the application. */
export function WorkspaceComposer(props: WorkspaceComposerProps): React.JSX.Element {
  return (
    <WorkspaceComposerContent
      key={JSON.stringify([props.task.projectId, props.task.id, props.conversationId])}
      {...props}
    />
  )
}

function WorkspaceComposerContent({
  task,
  conversationId,
  allowInitialCheckoutChoice = false,
  onSideChatCreated,
}: WorkspaceComposerProps) {
  const appendDraft = useDraftAppend()
  const { draft, setDraft, preferences, setPreferences } = useWorkspaceDraft(conversationId)
  const { accessMode: defaultAccessMode } = useWorkspaceAgentPreferences()
  const attachments = usePromptAttachments(conversationId)
  const reviewComments = useReviewComments(conversationId)
  const inspectionRequested = useRef('')
  const agentPickerRef = useRef<{ open: (query?: string) => void }>(null)
  const [selectedConnectionId, setSelectedConnectionId] = useState('')
  const [selectedModelId, setModelId] = useState<string | null>(null)
  const [selectedModeId, setModeId] = useState<string | null>(null)
  const modelId = selectedModelId ?? preferences?.modelId ?? ''
  const modeId = selectedModeId ?? preferences?.modeId ?? ''
  const [intent, setIntent] = useState<Intent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checkoutMode, setCheckoutMode] = useState<CheckoutMode>('local')
  const [baseBranch, setBaseBranch] = useState<string | null>(null)
  const [createdCheckout, setCreatedCheckout] = useState<WorkspaceCheckout | null>(null)
  const [preparingCheckout, setPreparingCheckout] = useState(false)
  const checkoutPreparation = useRef(createInitialCheckoutPreparation(() => crypto.randomUUID()))
  const checkoutPreparationLock = useRef(false)
  const draftRef = useRef(draft)
  useEffect(() => {
    draftRef.current = draft
  }, [draft])
  const actionCommandIds = useRef(new Map<string, string>())
  const commandIdFor = (key: string) => {
    const existing = actionCommandIds.current.get(key)
    if (existing) return existing
    const commandId = crypto.randomUUID()
    actionCommandIds.current.set(key, commandId)
    return commandId
  }

  const project = useWorkspaceProject({ projectId: task.projectId })
  const snapshot = useWorkspaceTaskSnapshot(snapshotRequest(task.id))
  const conversationHistory = usePromptHistory(task.id, conversationId)
  const sessions = useWorkspaceNativeAgentSessions({ taskId: task.id, options: { limit: 50 } })
  const followUps = useWorkspaceQueuedFollowUps({ conversationId, options: { limit: 50 } })
  const connections = useWorkspaceConnections()
  const inspect = useInspectWorkspaceConnection()
  const startRun = useStartRun()
  const createSideChat = useCreateSideChat()
  const createWorktree = useCreateWorktree()
  const enqueue = useEnqueueFollowUp()
  const steerRun = useSteerRun()
  const interrupt = useInterruptRun()
  const cancelFollowUp = useCancelQueuedFollowUp()
  const promoteFollowUp = usePromoteQueuedFollowUp()
  const pendingStarts = usePendingStart()
  const submission = pendingStarts.submissions[conversationId] ?? null
  const recoveryAttempt = useRef('')
  const capturePending = pendingStarts.capture
  const savedStart = pendingStarts.store.records[conversationId]
  const executeStart = startRun.execute
  useEffect(() => {
    if (savedStart?.state !== 'uncertain' || recoveryAttempt.current === savedStart.command.commandId) return
    recoveryAttempt.current = savedStart.command.commandId
    const captured = capturePending(savedStart)
    if (!captured.error)
      void executeStart(savedStart.command)
        .then(() => {
          attachments.clearCaptured(savedStart.command.attachments ?? [])
          reviewComments.clearCaptured(reviewCommentsIncludedInPrompt(savedStart.command.prompt, reviewComments.items))
        })
        .catch(() => {})
  }, [savedStart, capturePending, executeStart, attachments, reviewComments])
  // Same page the request drawer reads, so the composer knows what the agent waits for without another read.
  const pendingRequests = useWorkspacePendingRequests(firstPendingRequest(task.id))

  const checkoutChoices = useMemo(() => {
    if (!project.data) return []
    const choices = [project.data.mainCheckout, ...project.data.otherCheckouts].filter(checkout => !checkout.archivedAt)
    if (createdCheckout && !choices.some(checkout => checkout.id === createdCheckout.id)) choices.push(createdCheckout)
    return choices
  }, [project.data, createdCheckout])
  const availableCheckoutIds = useMemo(() => new Set(checkoutChoices.map(checkout => checkout.id)), [checkoutChoices])
  const sessionChoices = useMemo(() => sessions.data?.items ?? [], [sessions.data])
  // The checkout is fixed when the chat starts; only its branch can change afterwards.
  const preferredCheckout =
    checkoutChoices.find(checkout => checkout.id === (createdCheckout?.id ?? preferences?.checkoutId)) ??
    checkoutChoices[0]
  const detectedConnectionIds = useMemo(
    () => new Set(connections.data?.items.map(item => item.connectionId) ?? []),
    [connections.data],
  )
  const preferredConnectionId = detectedConnectionIds.has(selectedConnectionId || preferences?.connectionId || '')
    ? selectedConnectionId || preferences?.connectionId || ''
    : ''
  const continuation = boundConversationSession(
    snapshot.data?.runs ?? [],
    sessionChoices,
    conversationId,
    preferredCheckout?.id ?? '',
    detectedConnectionIds,
  )
  const freshSessionRequested = preferences?.resumeNativeContext === false
  const freshSessionNotice = freshSessionRequested
  useEffect(() => {
    const previousSessionId = preferences?.resumeSessionId
    const runConversationIds = new Map(
      (snapshot.data?.runContexts ?? []).map(context => [context.runId, context.conversationId] as const),
    )
    const latestSessionId = [...(snapshot.data?.runs ?? [])]
      .filter(run => runConversationIds.get(run.id) === conversationId && run.sessionId)
      .sort((left, right) => right.submittedAt.localeCompare(left.submittedAt))[0]?.sessionId
    if (freshSessionRequested && previousSessionId && latestSessionId && latestSessionId !== previousSessionId) {
      setPreferences({ resumeNativeContext: true, resumeSessionId: '' })
    }
  }, [
    conversationId,
    freshSessionRequested,
    preferences?.resumeSessionId,
    setPreferences,
    snapshot.data?.runContexts,
    snapshot.data?.runs,
  ])
  // A started chat continues its agent session and stays with that agent.
  const resumeMode = continuation !== null && !freshSessionRequested
  const selectedSession = resumeMode ? continuation : null
  const checkoutId = (resumeMode && selectedSession?.checkoutId) || preferredCheckout?.id || ''
  const activeCheckout = checkoutChoices.find(checkout => checkout.id === checkoutId) ?? null
  const branchRequest = useMemo(
    () =>
      activeCheckout && project.data && (!project.data.project.isScratch || allowInitialCheckoutChoice)
        ? { projectId: task.projectId, checkoutId: activeCheckout.id }
        : null,
    [activeCheckout, project.data, task.projectId, allowInitialCheckoutChoice],
  )
  const branches = useWorkspaceBranches(branchRequest)
  const switchBranch = useSwitchBranch()
  const [branchError, setBranchError] = useState<string | null>(null)
  const connectionId = (resumeMode && selectedSession?.connectionId) || preferredConnectionId
  const selectedConnection = connections.data?.items.find(item => item.connectionId === connectionId) ?? null
  const inspection = inspect.data?.connectionId === connectionId ? inspect.data : null
  const observedSession = useMemo(() => {
    if (resumeMode && selectedSession) return selectedSession
    const byId = new Map(sessionChoices.map(session => [session.id, session]))
    return [...(snapshot.data?.runs ?? [])]
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
      .map(run => (run.sessionId ? byId.get(run.sessionId) : undefined))
      .find(
        session =>
          session?.conversationId === conversationId &&
          session.connectionId === connectionId &&
          session.checkoutId === checkoutId &&
          session.capabilities,
      )
  }, [sessionChoices, snapshot.data, resumeMode, selectedSession, conversationId, connectionId, checkoutId])
  const inspected = useMemo(
    () =>
      inspection && observedSession?.capabilities
        ? {
            ...inspection,
            capabilities: {
              ...inspection.capabilities,
              models: observedSession.capabilities.models.length
                ? { state: 'session-scoped' as const, items: observedSession.capabilities.models }
                : inspection.capabilities.models,
              modes: observedSession.capabilities.modes.length
                ? { state: 'session-scoped' as const, items: observedSession.capabilities.modes }
                : inspection.capabilities.modes,
              configOptions: observedSession.capabilities.configOptions ?? inspection.capabilities.configOptions,
            },
          }
        : inspection,
    [inspection, observedSession],
  )
  const declaredConfigOptions = inspected?.capabilities.configOptions ?? []
  const configOptions = configOptionsForModel(
    declaredConfigOptions,
    inspected?.capabilities.models.items.find(model => model.id === modelId),
  )
  const configValues = preferences?.configValues ?? {}
  const submittedConfigValues = configValuesForOptions(configOptions, configValues)
  const validatedSession =
    selectedSession && sessions.data && !sessions.data.truncated && sessions.data.nextAfterId === null
      ? validateResumeSelection(
          {
            taskId: task.id,
            conversationId,
            checkoutId: selectedSession.checkoutId,
            driverId: selectedSession.driverId,
            connectionId: selectedSession.connectionId,
            nativeSessionId: selectedSession.nativeSessionId,
            generation: selectedSession.generation,
          },
          sessionChoices,
          availableCheckoutIds,
        )
      : null
  const runContexts = snapshot.data?.runContexts ?? []
  const contextComplete = Boolean(
    snapshot.data &&
    !snapshot.data.runCoverage?.truncated &&
    snapshot.data.runCoverage?.returned === runContexts.length,
  )
  const runs = snapshot.data ? currentConversationRuns(snapshot.data.runs, runContexts, conversationId) : []
  const latestGoal = [...runs].sort((left, right) => right.submittedAt.localeCompare(left.submittedAt))[0]?.goal ?? null
  const promptHistory = useMemo(
    () =>
      [...(conversationHistory.data?.items ?? [])]
        .reverse()
        .flatMap(item => (item.userMessage ? [item.userMessage.content] : [])),
    [conversationHistory.data],
  )
  const choosingInitialCheckout = allowInitialCheckoutChoice && contextComplete && runs.length === 0 && !resumeMode
  let shownCheckoutMode: CheckoutMode = activeCheckout?.kind === 'worktree' ? 'worktree' : 'local'
  if (choosingInitialCheckout) shownCheckoutMode = checkoutMode
  const initialChoice = activeCheckout
    ? {
        mode: checkoutMode,
        checkout: activeCheckout,
        baseBranch: baseBranch ?? branches.data?.current ?? null,
        branches: branches.data,
      }
    : null
  const checkoutError = choosingInitialCheckout && initialChoice ? initialWorktreeError(initialChoice) : null
  const activeRun = runs.find(isRunActive) ?? null
  const activeRunContext = activeRun ? (runContexts.find(context => context.runId === activeRun.id) ?? null) : null
  // Stop and steer read the running agent's shared inspection, which is warm from startup.
  const runConnection = useWorkspaceConnectionCatalog(activeRunContext?.connectionId ?? '').inspection
  const unresolvedRun = runs.find(run => run.status === 'uncertain' || run.status === 'recoveryRequired') ?? null
  const queueExhaustive = Boolean(
    followUps.data && !followUps.data.truncated && followUps.data.nextAfterPosition === null,
  )
  const capabilities = inspected?.capabilities
  const access = resolveAccessMode(preferences?.accessMode ?? defaultAccessMode, inspected?.accessModes)
  const changeAccessMode = (mode: AgentAccessMode) => setPreferences({ accessMode: mode })
  const submitSupport = resumeMode ? capabilities?.loadSession : capabilities?.openSession
  const submitAvailable = Boolean(
    selectedConnection &&
    inspected &&
    inspected.driverId === selectedConnection.driverId &&
    submitSupport?.support === 'supported' &&
    capabilities?.submit.support === 'supported',
  )
  const attachmentBlocked = attachments.items.some(item =>
    item.mediaType.startsWith('image/') ? !capabilities?.promptContent?.images : !capabilities?.promptContent?.files,
  )
  const busy = activeRun !== null
  const pendingStart = pendingStarts.store.records[conversationId] ?? null
  const blocked = !contextComplete || Boolean(pendingStart) || Boolean(pendingStarts.store.error)
  const actionStateReady =
    snapshot.data !== null &&
    project.data !== null &&
    connections.data !== null &&
    sessions.data !== null &&
    followUps.data !== null &&
    !snapshot.error &&
    !project.error &&
    !connections.error &&
    !sessions.error &&
    !followUps.error
  let submissionHint = ''
  if (!selectedConnection) submissionHint = 'Choose an agent below to continue.'
  else if (inspected && resumeMode && !validatedSession)
    submissionHint = "This chat's agent session could not be confirmed. Start a new chat to continue."
  else if (inspected && !submitAvailable) submissionHint = 'The selected agent cannot continue this chat.'

  const inspectSelectedConnection = inspect.execute
  const inspectionPending = inspect.pending
  useEffect(() => {
    if (!connectionId || inspected || inspectionPending || inspectionRequested.current === connectionId) return
    inspectionRequested.current = connectionId
    void inspectSelectedConnection({ connectionId }).catch(() => {})
  }, [connectionId, inspected, inspectionPending, inspectSelectedConnection])

  const sendIntent = async (nextIntent: Intent) => {
    setError(null)
    setIntent(nextIntent)
    const capturedComments = reviewCommentsIncludedInPrompt(nextIntent.prompt, reviewComments.items)
    try {
      if (nextIntent.kind === 'start') {
        const captured = pendingStarts.capture({
          conversationId,
          command: nextIntent.command,
          rawDraft: nextIntent.draftValue,
        })
        if (captured.error || captured.records[conversationId]?.command.commandId !== nextIntent.command.commandId) {
          setError(captured.error ?? 'The Run intent could not be saved. It was not started.')
          setIntent(null)
          return
        }
        if (canClearCapturedDraft(draftRef.current, nextIntent.draftValue)) {
          draftRef.current = ''
          setDraft('')
        }
        await startRun.execute(nextIntent.command)
      } else if (nextIntent.kind === 'enqueue') await enqueue.execute(nextIntent.command)
      else await steerRun.execute(nextIntent.command)
      if (canClearCapturedDraft(draftRef.current, nextIntent.draftValue)) setDraft('')
      attachments.clearCaptured(nextIntent.command.attachments ?? [])
      reviewComments.clearCaptured(capturedComments)
      setIntent(null)
    } catch (cause) {
      if (nextIntent.kind === 'start') {
        setIntent(null)
        return
      }
      setError(
        cause instanceof Error
          ? cause.message
          : 'The command could not be confirmed. The same command can be retried safely.',
      )
    }
  }

  const submit = async () => {
    const promptCommand = parseWorkspacePromptCommand(draft, observedSession?.capabilities?.commands ?? [])
    const goalControl = activeGoalControl(promptCommand)
    if (promptCommand?.kind === 'model') {
      draftRef.current = ''
      setDraft('')
      agentPickerRef.current?.open(promptCommand.query)
      return
    }
    if (promptCommand?.kind === 'clear') {
      if (blocked || pendingStart || pendingStarts.store.error || intent) return
      if (followUps.data?.items.length) {
        setError('Send or remove queued messages before starting a fresh agent session.')
        return
      }
      if (!continuation) {
        setError('This Conversation already starts with a fresh agent session.')
        return
      }
      setError(null)
      setPreferences({ resumeNativeContext: false, resumeSessionId: continuation.nativeSessionId })
      draftRef.current = ''
      setDraft('')
      attachments.clearCaptured(attachments.items)
      return
    }
    if (goalControl && promptCommand?.kind === 'native') {
      if (
        !actionStateReady ||
        blocked ||
        unresolvedRun ||
        pendingStart ||
        pendingStarts.store.error ||
        intent ||
        !activeRun ||
        !activeRunContext ||
        runConnection?.connectionId !== activeRunContext.connectionId ||
        runConnection.driverId !== activeRunContext.driverId ||
        runConnection.capabilities.steer.support !== 'supported'
      ) {
        setError('The active agent goal cannot be controlled until this Run is confirmed and its connection is ready.')
        return
      }
      const command: WorkspaceCommandInput<'workspace:steer'> = {
        commandId: crypto.randomUUID(),
        runId: activeRun.id,
        generation: activeRun.generation,
        ...(activeRun.nativeTurnId ? { expectedNativeTurnId: activeRun.nativeTurnId } : {}),
        message: promptCommand.prompt,
        attachments: [],
      }
      void sendIntent({ kind: 'steer', command, prompt: promptCommand.prompt, draftValue: draft })
      return
    }
    if (promptCommand?.kind === 'side' || promptCommand?.kind === 'btw') {
      if (!actionStateReady || blocked || pendingStart || pendingStarts.store.error || intent) return
      const rawDraft = draft
      const prompt = promptCommand.prompt
      setError(null)
      try {
        const binding = await createSideChat.create({
          parentTaskId: task.id,
          parentConversationId: conversationId,
          ...(checkoutId ? { checkoutId } : {}),
          ...(prompt ? { title: prompt.slice(0, 200) } : {}),
        })
        if (!binding) return
        onSideChatCreated?.(binding.id)
        if (prompt) {
          if (
            selectedConnection &&
            inspected?.capabilities.openSession.support === 'supported' &&
            inspected.capabilities.submit.support === 'supported'
          ) {
            const sideCommand: WorkspaceRequest<'workspace:startRun'> = {
              commandId: crypto.randomUUID(),
              taskId: binding.taskId,
              conversationId: binding.conversationId,
              checkoutId: binding.checkoutId,
              generation: 1,
              driverId: selectedConnection.driverId,
              connectionId: selectedConnection.connectionId,
              prompt,
              attachments: [],
              modelId: modelId || null,
              modeId: modeId || null,
              accessMode: access.mode,
              ...(Object.keys(submittedConfigValues).length > 0 ? { configValues: submittedConfigValues } : {}),
              nativeSessionId: null,
              retryOfRunId: null,
            }
            const captured = pendingStarts.capture({
              conversationId: binding.conversationId,
              command: sideCommand,
              rawDraft: prompt,
            })
            if (captured.error || captured.records[binding.conversationId]?.command.commandId !== sideCommand.commandId)
              throw new Error(captured.error ?? 'The side chat message could not be saved.')
            if (canClearCapturedDraft(draftRef.current, rawDraft)) {
              draftRef.current = ''
              setDraft('')
              attachments.clearCaptured(attachments.items)
            }
            await startRun.execute(sideCommand)
          } else {
            appendDraft(binding.conversationId, prompt)
          }
        }
        if (canClearCapturedDraft(draftRef.current, rawDraft)) {
          draftRef.current = ''
          setDraft('')
          attachments.clearCaptured(attachments.items)
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not open a side chat.')
      }
      return
    }
    const prompt = promptWithReviewComments(promptWithAttachments(draft, attachments.items), reviewComments.items)
    if (
      !prompt ||
      attachmentBlocked ||
      !actionStateReady ||
      blocked ||
      pendingStart ||
      pendingStarts.store.error ||
      intent ||
      checkoutError ||
      checkoutPreparationLock.current
    )
      return
    if (busy) {
      if (freshSessionRequested || !queueExhaustive || !checkoutId || !selectedConnection) return
      const command: WorkspaceCommandInput<'workspace:enqueueFollowUp'> = {
        commandId: crypto.randomUUID(),
        taskId: task.id,
        conversationId,
        checkoutId,
        generation: validatedSession?.generation ?? activeRun?.generation ?? 1,
        nativeSessionId: validatedSession?.nativeSessionId ?? null,
        prompt,
        attachments: [...attachments.items],
        driverId: selectedConnection.driverId,
        connectionId,
        modelId: modelId || null,
        modeId: modeId || null,
        accessMode: access.mode,
        ...(Object.keys(submittedConfigValues).length > 0 ? { configValues: submittedConfigValues } : {}),
      }
      void sendIntent({ kind: 'enqueue', command, prompt, draftValue: draft })
      return
    }
    if (!submitAvailable || !checkoutId || !selectedConnection) return
    if (resumeMode && !validatedSession) return
    let startCheckoutId = checkoutId
    if (choosingInitialCheckout && initialChoice?.mode === 'worktree') {
      checkoutPreparationLock.current = true
      setPreparingCheckout(true)
      setError(null)
      try {
        const checkout = await checkoutPreparation.current(initialChoice, createWorktree.execute)
        startCheckoutId = checkout.id
        setCreatedCheckout(checkout)
        setPreferences({ checkoutId: checkout.id })
        setCheckoutMode('local')
        setBaseBranch(null)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not create a worktree.')
        return
      } finally {
        checkoutPreparationLock.current = false
        setPreparingCheckout(false)
      }
    }
    const command: WorkspaceRequest<'workspace:startRun'> = {
      commandId: crypto.randomUUID(),
      taskId: task.id,
      conversationId,
      checkoutId: startCheckoutId,
      generation: validatedSession?.generation ?? 1,
      driverId: validatedSession?.driverId ?? selectedConnection.driverId,
      connectionId: validatedSession?.connectionId ?? selectedConnection.connectionId,
      prompt,
      attachments: [...attachments.items],
      modelId: modelId || null,
      modeId: modeId || null,
      accessMode: access.mode,
      ...(Object.keys(submittedConfigValues).length > 0 ? { configValues: submittedConfigValues } : {}),
      nativeSessionId: validatedSession?.nativeSessionId ?? null,
      retryOfRunId: null,
    }
    void sendIntent({ kind: 'start', command, prompt, draftValue: draft })
  }

  const retryIntent = () => {
    if (intent) void sendIntent(intent)
  }

  const retryPendingStart = async () => {
    if (!pendingStart || pendingStart.state !== 'uncertain' || intent) return
    const restoredIntent: Intent = {
      kind: 'start',
      command: pendingStart.command,
      prompt: pendingStart.command.prompt,
      draftValue: pendingStart.rawDraft,
    }
    await sendIntent(restoredIntent)
  }

  const stopRun = async () => {
    if (!activeRun || !contextComplete) return
    setError(null)
    try {
      await interrupt.execute({ runId: activeRun.id, commandId: commandIdFor(`interrupt:${activeRun.id}`) })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not request Run interruption.')
    }
  }

  const stopSupported = Boolean(
    activeRunContext &&
    runConnection?.connectionId === activeRunContext.connectionId &&
    runConnection.driverId === activeRunContext.driverId &&
    runConnection.capabilities.interrupt.support === 'supported',
  )
  const steerAvailable = Boolean(
    activeRun?.nativeTurnId &&
    activeRunContext &&
    runConnection?.connectionId === activeRunContext.connectionId &&
    runConnection.driverId === activeRunContext.driverId &&
    runConnection.capabilities.steer.support === 'supported',
  )
  const awaiting: ComposerAwaiting =
    activeRun?.status === 'awaitingInput'
      ? (pendingRequests.data?.items
          .filter(item => item.runId === activeRun.id && item.request.generation === activeRun.generation)
          .sort((a, b) => a.sequence - b.sequence)[0]?.request.kind ?? null)
      : null
  const hasContent = Boolean(
    promptWithReviewComments(promptWithAttachments(draft, attachments.items), reviewComments.items),
  )
  const canStop = Boolean(activeRun && stopSupported)
  const stopPrimary = isStopPrimary({ busy, canStop, hasContent })
  const steer = () => {
    if (
      !activeRun?.nativeTurnId ||
      !steerAvailable ||
      blocked ||
      intent ||
      attachmentBlocked ||
      !promptWithReviewComments(promptWithAttachments(draft, attachments.items), reviewComments.items)
    )
      return
    const prompt = promptWithReviewComments(promptWithAttachments(draft, attachments.items), reviewComments.items)
    void sendIntent({
      kind: 'steer',
      prompt,
      draftValue: draft,
      command: {
        commandId: crypto.randomUUID(),
        runId: activeRun.id,
        generation: activeRun.generation,
        expectedNativeTurnId: activeRun.nativeTurnId,
        message: prompt,
        attachments: [...attachments.items],
      },
    })
  }

  const cancelQueued = async (commandId: string) => {
    try {
      await cancelFollowUp.execute({
        conversationId,
        targetCommandId: commandId,
        commandId: commandIdFor(`cancel:${commandId}`),
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not cancel the queued prompt.')
    }
  }

  const dispatchQueued = async (item: NonNullable<typeof followUps.data>['items'][number]) => {
    const queuedCheckoutId = item.checkoutId ?? (checkoutId ? checkoutId : null)
    const queuedDriverId = item.driverId ?? selectedSession?.driverId ?? selectedConnection?.driverId
    const queuedConnectionId = item.connectionId ?? selectedSession?.connectionId ?? connectionId
    if (!queueExhaustive || blocked || !contextComplete || intent) return
    if (!queuedCheckoutId || !queuedDriverId || !queuedConnectionId) return
    const queuedSession = item.nativeSessionId
      ? validateResumeSelection(
          {
            taskId: task.id,
            conversationId,
            checkoutId: queuedCheckoutId,
            driverId: queuedDriverId,
            connectionId: queuedConnectionId,
            nativeSessionId: item.nativeSessionId,
            generation: item.generation ?? 1,
          },
          sessionChoices,
          availableCheckoutIds,
        )
      : validatedSession &&
          validatedSession.checkoutId === queuedCheckoutId &&
          validatedSession.driverId === queuedDriverId &&
          validatedSession.connectionId === queuedConnectionId
        ? validatedSession
        : null
    if (item.nativeSessionId && !queuedSession) return
    const command: WorkspaceCommandInput<'workspace:promoteQueuedFollowUp'> = {
      commandId: commandIdFor(`promote:${item.commandId}`),
      taskId: task.id,
      conversationId,
      checkoutId: queuedCheckoutId,
      generation: item.generation ?? queuedSession?.generation ?? 1,
      driverId: queuedDriverId,
      connectionId: queuedConnectionId,
      prompt: item.prompt,
      attachments: item.attachments ?? [],
      modelId: item.modelId ?? null,
      modeId: item.modeId ?? null,
      ...(item.configValues ? { configValues: item.configValues } : {}),
      ...(item.accessMode ? { accessMode: item.accessMode } : {}),
      nativeSessionId: item.nativeSessionId ?? queuedSession?.nativeSessionId ?? null,
      retryOfRunId: null,
    }
    try {
      await promoteFollowUp.execute(command)
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Dispatch outcome is unresolved. Refresh the Task snapshot before retrying.',
      )
    }
  }

  const dispatchPrompt = (alternate: boolean) => {
    if (resolveComposerDispatch({ busy, canSteer: steerAvailable, alternate }) === 'steer') steer()
    else void submit()
  }

  const keyDown = (event: globalThis.KeyboardEvent) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      dispatchPrompt(true)
      return
    }
    if (!shouldSubmitComposerKey({ key: event.key, shiftKey: event.shiftKey, isComposing: event.isComposing })) return
    event.preventDefault()
    void submit()
  }

  return (
    <section className="bg-background shrink-0 px-4 pt-2 pb-3" aria-label="Conversation composer">
      <div className="max-w-chat mx-auto w-full">
        {pendingStarts.store.error && (
          <p className="mb-2 text-sm text-amber-700" role="alert">
            {pendingStarts.store.error}
          </p>
        )}
        {submission?.error && (
          <div className="mb-2 flex items-center gap-2 text-sm" role="alert">
            <p className="text-destructive">{submission.error}</p>
            {savedStart?.state === 'uncertain' && (
              <Button
                className="mt-2"
                type="button"
                variant="outline"
                size="sm"
                disabled={Boolean(intent) || startRun.pending}
                onClick={() => void retryPendingStart()}
              >
                Retry
              </Button>
            )}
          </div>
        )}
        {unresolvedRun && (
          <div
            className="mb-3 flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
            role="status"
          >
            <span>A previous message ended without a confirmed outcome.</span>
          </div>
        )}
        {followUps.data?.items.length ? (
          <ol className="mb-3 max-h-36 space-y-2 overflow-auto" aria-label="Queued prompts">
            {followUps.data.items.map((item, index) => {
              const queuedCheckoutId = item.checkoutId ?? checkoutId
              const queuedDriverId = item.driverId ?? selectedSession?.driverId ?? selectedConnection?.driverId
              const queuedConnectionId = item.connectionId ?? selectedSession?.connectionId ?? connectionId
              const validatedQueuedSession =
                queuedCheckoutId && item.nativeSessionId
                  ? validateResumeSelection(
                      {
                        taskId: task.id,
                        conversationId,
                        checkoutId: queuedCheckoutId,
                        driverId: queuedDriverId ?? '',
                        connectionId: queuedConnectionId ?? '',
                        nativeSessionId: item.nativeSessionId,
                        generation: item.generation ?? 1,
                      },
                      sessionChoices,
                      availableCheckoutIds,
                    )
                  : null
              const canResume = Boolean(
                queueExhaustive &&
                !busy &&
                !blocked &&
                contextComplete &&
                queuedCheckoutId &&
                queuedDriverId &&
                queuedConnectionId &&
                (!item.nativeSessionId || validatedQueuedSession) &&
                !promoteFollowUp.pending,
              )
              const visibleQueuedAttachments = visiblePromptAttachments(item.attachments ?? [])
              return (
                <li
                  key={item.commandId}
                  className="flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <p className="text-muted-foreground text-xs">
                      Queued #{index + 1} · {item.held ? 'Paused' : 'Sends when the agent is available'}
                    </p>
                    <p className="break-words whitespace-pre-wrap">{item.prompt}</p>
                    {visibleQueuedAttachments.length ? (
                      <p className="text-muted-foreground mt-1 text-xs">
                        {visibleQueuedAttachments.map(attachment => attachment.name).join(' · ')}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={cancelFollowUp.pending}
                      onClick={() => void cancelQueued(item.commandId)}
                    >
                      Cancel
                    </Button>
                    {item.held && index === 0 && (
                      <Button type="button" size="sm" disabled={!canResume} onClick={() => void dispatchQueued(item)}>
                        Resume
                      </Button>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>
        ) : null}
        {followUps.data?.truncated && (
          <p className="mb-2 text-sm text-amber-700" role="status">
            Queue history is truncated; dispatch is disabled until the full queue can be read.
          </p>
        )}
        {sessions.data && (sessions.data.truncated || sessions.data.nextAfterId !== null) && (
          <p className="mb-2 text-sm text-amber-700" role="status">
            Native session list is not exhaustive; resume is disabled because all sessions could not be validated.
          </p>
        )}
        {snapshot.data?.runCoverage?.truncated && (
          <p className="mb-2 text-sm text-amber-700" role="status">
            Run history is truncated; controls are disabled until the authoritative snapshot is complete.
          </p>
        )}
        {error && (
          <div className="mb-2 flex items-center gap-2 text-sm" role="alert">
            <span className="text-destructive">{error}</span>
            {intent && intent.kind !== 'start' && (
              <Button type="button" variant="outline" size="sm" onClick={retryIntent}>
                Retry same command
              </Button>
            )}
          </div>
        )}
        {!actionStateReady && (
          <p className="text-muted-foreground mb-2 text-sm" role="status">
            {snapshot.error ||
              project.error ||
              connections.error ||
              sessions.error ||
              followUps.error ||
              'Loading chat…'}
          </p>
        )}
        {actionStateReady && !contextComplete && (
          <p className="mb-2 text-sm text-amber-700" role="alert">
            Run snapshot is incomplete; sending and Stop are disabled.
          </p>
        )}
        {unresolvedRun && (
          <p className="mb-2 text-sm text-amber-700" role="alert">
            Message delivery is unresolved. More work is blocked until its status is confirmed.
          </p>
        )}
        {freshSessionNotice && (
          <div
            className="mb-2 flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
            role="status"
          >
            <span>
              {busy
                ? 'After this Run ends, the next message starts a fresh agent session. Earlier messages remain in this Conversation.'
                : 'The next message starts a fresh agent session. Earlier messages remain in this Conversation.'}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setPreferences({ resumeNativeContext: true, resumeSessionId: '' })
              }}
            >
              Keep current session
            </Button>
          </div>
        )}
        {latestGoal && (
          <section className="mb-2 rounded-md border px-3 py-2 text-xs" aria-label="Agent goal">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <strong>Agent goal · {latestGoal.status}</strong>
              <span>{latestGoal.tokensUsed.toLocaleString()} tokens used</span>
              {latestGoal.tokenBudget && <span>Budget {latestGoal.tokenBudget.toLocaleString()}</span>}
              <span>{latestGoal.timeUsedSeconds.toLocaleString()} seconds</span>
            </div>
            <p className="text-muted-foreground mt-1 line-clamp-2" title={latestGoal.objective}>
              {latestGoal.objective}
            </p>
          </section>
        )}
        {submissionHint && !busy && (
          <p className="text-muted-foreground mb-2 text-xs" role="status">
            {submissionHint}
          </p>
        )}
        <WorkspaceRequests taskId={task.id} conversationId={conversationId} />
        <WorkspacePromptInput
          reviewOwnerKey={conversationId}
          value={draft}
          autoFocus
          onChange={value => {
            draftRef.current = value
            setDraft(value)
          }}
          onKeyDown={keyDown}
          attachments={attachments}
          projectId={task.projectId}
          taskId={task.id}
          conversationId={conversationId}
          checkoutId={checkoutId}
          connectionId={connectionId}
          maxLength={WORKSPACE_DRAFT_MAX_LENGTH}
          nativeCommands={observedSession?.capabilities?.commands ?? []}
          onOpenModelPicker={query => agentPickerRef.current?.open(query)}
          history={promptHistory}
          onPromptCommand={
            onSideChatCreated
              ? name => {
                  setError(null)
                  void createSideChat
                    .create({
                      parentTaskId: task.id,
                      parentConversationId: conversationId,
                      ...(checkoutId ? { checkoutId } : {}),
                    })
                    .then(binding => {
                      if (binding) onSideChatCreated(binding.id)
                    })
                    .catch(cause => setError(cause instanceof Error ? cause.message : `Could not open a ${name} chat.`))
                }
              : undefined
          }
          placeholder={composerPlaceholder({ busy, awaiting, canSteer: steerAvailable })}
          contextStrip={
            activeCheckout && project.data && (!project.data.project.isScratch || choosingInitialCheckout) ? (
              <CheckoutStrip
                mode={shownCheckoutMode}
                lockedKind={choosingInitialCheckout ? undefined : activeCheckout.kind}
                onModeChange={
                  choosingInitialCheckout
                    ? mode => {
                        setCheckoutMode(mode)
                        setBaseBranch(null)
                        setBranchError(null)
                      }
                    : undefined
                }
                branch={
                  choosingInitialCheckout && checkoutMode === 'worktree'
                    ? (initialChoice?.baseBranch ?? null)
                    : (branches.data?.current ?? null)
                }
                branches={branches.data}
                pending={switchBranch.pending || preparingCheckout}
                // A running agent works on the checked-out branch, so it stays put until the Run ends.
                disabled={busy || switchBranch.pending || preparingCheckout || Boolean(pendingStart) || Boolean(intent)}
                onBranchSelect={branch => {
                  setBranchError(null)
                  if (choosingInitialCheckout && checkoutMode === 'worktree') {
                    setBaseBranch(branch)
                    return
                  }
                  switchBranch
                    .execute({ projectId: task.projectId, checkoutId: activeCheckout.id, branch })
                    .catch(cause =>
                      setBranchError(cause instanceof Error ? cause.message : 'Could not switch branches.'),
                    )
                }}
                error={branchError ?? branches.error ?? checkoutError}
              />
            ) : undefined
          }
          controls={
            <>
              <WorkspaceAgentPicker
                controlRef={agentPickerRef}
                connections={connections.data?.items ?? []}
                connectionId={connectionId}
                modelId={modelId}
                modeId={modeId}
                configValues={configValues}
                inspection={inspected}
                pending={inspect.pending}
                {...(continuation ? { lockedConnectionId: continuation.connectionId } : {})}
                access={{ ...access, onChange: changeAccessMode }}
                onConnectionChange={id => {
                  setSelectedConnectionId(id)
                  setModelId('')
                  setModeId('')
                  setPreferences({ checkoutId, connectionId: id, modelId: '', modeId: '', configValues: {} })
                }}
                onModelChange={id => {
                  setModelId(id)
                  setModeId('')
                  setPreferences({
                    modelId: id,
                    modeId: '',
                    configValues: withoutModelSpecificConfigValues(configValues, declaredConfigOptions),
                  })
                }}
                onModeChange={id => {
                  setModeId(id)
                  setPreferences({ modeId: id })
                }}
                onConfigValueChange={(id, value) => {
                  setPreferences({ configValues: { ...configValues, [id]: value } })
                }}
              />
              {/* The picker's footer always holds permissions; the chip only shows a mode that differs from the default. */}
              {access.mode !== defaultAccessMode && (
                <PermissionsChip mode={access.mode} options={access.options} onChange={changeAccessMode} />
              )}
            </>
          }
          actions={
            <>
              {canStop && activeRun && (
                <Button
                  type="button"
                  size="icon-sm"
                  variant={stopPrimary ? 'default' : 'outline'}
                  className="rounded-full"
                  aria-label="Stop Run"
                  title="Stop Run"
                  disabled={interrupt.pending || activeRun.status === 'interruptRequested'}
                  onClick={() => void stopRun()}
                >
                  <Square className="size-3 fill-current" />
                </Button>
              )}
              {!stopPrimary && (
                <Button
                  type="button"
                  size="icon-sm"
                  className="rounded-full"
                  aria-label={busy ? 'Queue follow-up' : 'Send'}
                  title={
                    busy
                      ? steerAvailable
                        ? 'Queue follow-up · Ctrl/⌘+click or Ctrl/⌘+Enter to steer the running turn'
                        : 'Queue follow-up'
                      : 'Send'
                  }
                  disabled={
                    !hasContent ||
                    attachmentBlocked ||
                    !actionStateReady ||
                    blocked ||
                    Boolean(pendingStart) ||
                    Boolean(pendingStarts.store.error) ||
                    Boolean(intent) ||
                    Boolean(checkoutError) ||
                    preparingCheckout ||
                    (busy
                      ? freshSessionRequested || (!queueExhaustive && (!steerAvailable || steerRun.pending))
                      : !submitAvailable || (resumeMode && !validatedSession))
                  }
                  onClick={event => dispatchPrompt(event.metaKey || event.ctrlKey)}
                >
                  {busy ? <ListPlus className="size-4" /> : <ArrowUp className="size-4" />}
                </Button>
              )}
            </>
          }
        />
        {attachmentBlocked && (
          <p className="text-muted-foreground mt-2 text-xs" role="status">
            The selected agent has not confirmed support for these attachments. Choose a compatible agent or remove
            them.
          </p>
        )}
      </div>
    </section>
  )
}
