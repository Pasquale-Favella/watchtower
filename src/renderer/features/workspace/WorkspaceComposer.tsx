import { useMemo, useRef, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import type { WorkspaceRequest } from '@/renderer/features/workspace/lib.js'
import type { ConversationId, Task, WorkspaceCheckoutId } from '@/shared/schemas/workspace.js'

import {
  currentConversationRuns,
  isRunActive,
  shouldSubmitComposerKey,
  validateResumeSelection,
} from './composer-state.js'
import { useInspectWorkspaceConnection, useWorkspaceConnections } from './connection-hooks.js'
import { WORKSPACE_DRAFT_MAX_LENGTH } from './draft-storage.js'
import {
  useCancelQueuedFollowUp,
  useEnqueueFollowUp,
  useInterruptRun,
  usePromoteQueuedFollowUp,
  useStartRun,
  useSteerRun,
  useWorkspaceNativeAgentSessions,
  useWorkspaceProject,
  useWorkspaceQueuedFollowUps,
  useWorkspaceTaskSnapshot,
} from './hooks.js'
import type { WorkspaceCommandInput } from './lib.js'
import { canClearCapturedDraft } from './pending-start-state.js'
import { usePendingStart } from './use-pending-start.js'
import { useWorkspaceDraft } from './use-workspace-draft.js'

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
const activityLabels: Readonly<Record<string, string>> = {
  queued: 'Queued',
  starting: 'Starting…',
  running: 'Working…',
  awaitingInput: 'Waiting for your response',
  interruptRequested: 'Stopping…',
}

/** Pinned prompt controls for one Conversation; execution ownership remains with the application. */
export function WorkspaceComposer({
  task,
  conversationId,
}: {
  readonly task: Task
  readonly conversationId: ConversationId
}) {
  const { draft, setDraft, preferences, setPreferences } = useWorkspaceDraft(conversationId)
  const [selectedCheckoutId, setSelectedCheckoutId] = useState<WorkspaceCheckoutId | ''>('')
  const [selectedConnectionId, setSelectedConnectionId] = useState('')
  const [resumeSessionId, setResumeSessionId] = useState('')
  const [resumeMode, setResumeMode] = useState(false)
  const [modelId, setModelId] = useState('')
  const [modeId, setModeId] = useState('')
  const [intent, setIntent] = useState<Intent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const draftRef = useRef(draft)
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
  const sessions = useWorkspaceNativeAgentSessions({ taskId: task.id, options: { limit: 50 } })
  const followUps = useWorkspaceQueuedFollowUps({ conversationId, options: { limit: 50 } })
  const connections = useWorkspaceConnections()
  const inspect = useInspectWorkspaceConnection()
  const startRun = useStartRun()
  const enqueue = useEnqueueFollowUp()
  const steerRun = useSteerRun()
  const interrupt = useInterruptRun()
  const cancelFollowUp = useCancelQueuedFollowUp()
  const promoteFollowUp = usePromoteQueuedFollowUp()
  const pendingStarts = usePendingStart()

  const checkoutChoices = useMemo(() => {
    if (!project.data) return []
    return [project.data.mainCheckout, ...project.data.otherCheckouts].filter(checkout => !checkout.archivedAt)
  }, [project.data])
  const availableCheckoutIds = useMemo(() => new Set(checkoutChoices.map(checkout => checkout.id)), [checkoutChoices])
  const sessionChoices = sessions.data?.items ?? []
  const selectedSession = resumeSessionId
    ? (sessionChoices.find(session => session.id === resumeSessionId) ?? null)
    : null
  const preferredCheckout = checkoutChoices.find(
    checkout => checkout.id === selectedCheckoutId || checkout.id === preferences?.checkoutId,
  )
  const checkoutId = (resumeMode && selectedSession?.checkoutId) || preferredCheckout?.id || ''
  const connectionId =
    (resumeMode && selectedSession?.connectionId) ||
    (connections.data?.items.some(item => item.connectionId === (selectedConnectionId || preferences?.connectionId))
      ? selectedConnectionId || preferences?.connectionId
      : '')
  const selectedConnection = connections.data?.items.find(item => item.connectionId === connectionId) ?? null
  const inspected = inspect.data?.connectionId === connectionId ? inspect.data : null
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
  const activeRun = runs.find(isRunActive) ?? null
  const activeRunContext = activeRun ? (runContexts.find(context => context.runId === activeRun.id) ?? null) : null
  const unresolvedRun = runs.find(run => run.status === 'uncertain' || run.status === 'recoveryRequired') ?? null
  const queueExhaustive = Boolean(
    followUps.data && !followUps.data.truncated && followUps.data.nextAfterPosition === null,
  )
  const capabilities = inspected?.capabilities
  const submitSupport = resumeMode ? capabilities?.loadSession : capabilities?.openSession
  const submitAvailable = Boolean(
    selectedConnection &&
    inspected &&
    inspected.driverId === selectedConnection.driverId &&
    submitSupport?.support === 'supported' &&
    capabilities?.submit.support === 'supported',
  )
  const modelChoices = capabilities?.models.state === 'session-scoped' ? capabilities.models.items : []
  const modeChoices = capabilities?.modes.state === 'session-scoped' ? capabilities.modes.items : []
  const busy = activeRun !== null
  const pendingStart = pendingStarts.store.records[conversationId] ?? null
  const blocked =
    !contextComplete || Boolean(unresolvedRun) || Boolean(pendingStart) || Boolean(pendingStarts.store.error)
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

  const requestInspection = () => {
    if (!connectionId) return
    setError(null)
    inspect
      .execute({ connectionId })
      .catch(cause => setError(cause instanceof Error ? cause.message : 'Connection inspection failed.'))
  }

  const sendIntent = async (nextIntent: Intent) => {
    setError(null)
    setIntent(nextIntent)
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
        await startRun.execute(nextIntent.command)
        const cleared = pendingStarts.clear(conversationId, nextIntent.command.commandId)
        if (cleared.error || cleared.records[conversationId]) {
          setError(
            cleared.error ??
              'The Run completed, but its saved receipt could not be cleared. Resolve it before sending again.',
          )
          setIntent(null)
          return
        }
      } else if (nextIntent.kind === 'enqueue') await enqueue.execute(nextIntent.command)
      else await steerRun.execute(nextIntent.command)
      if (canClearCapturedDraft(draftRef.current, nextIntent.draftValue)) setDraft('')
      setIntent(null)
    } catch (cause) {
      if (nextIntent.kind === 'start') {
        pendingStarts.markUncertain(conversationId, nextIntent.command.commandId)
        setIntent(null)
      }
      setError(
        cause instanceof Error
          ? cause.message
          : 'The command could not be confirmed. The same command can be retried safely.',
      )
    }
  }

  const submit = () => {
    const prompt = draft.trim()
    if (!prompt || !actionStateReady || blocked || pendingStart || pendingStarts.store.error || intent) return
    if (busy) {
      if (!queueExhaustive || !checkoutId || !selectedConnection) return
      const command: WorkspaceCommandInput<'workspace:enqueueFollowUp'> = {
        commandId: crypto.randomUUID(),
        taskId: task.id,
        conversationId,
        prompt,
        driverId: selectedConnection.driverId,
        connectionId,
        modelId: modelId || null,
        modeId: modeId || null,
      }
      void sendIntent({ kind: 'enqueue', command, prompt, draftValue: draft })
      return
    }
    if (!submitAvailable || !checkoutId || !selectedConnection) return
    if (resumeMode && !validatedSession) return
    const command: WorkspaceRequest<'workspace:startRun'> = {
      commandId: crypto.randomUUID(),
      taskId: task.id,
      conversationId,
      checkoutId,
      generation: validatedSession?.generation ?? 1,
      driverId: validatedSession?.driverId ?? selectedConnection.driverId,
      connectionId: validatedSession?.connectionId ?? selectedConnection.connectionId,
      prompt,
      modelId: modelId || null,
      modeId: modeId || null,
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

  const inspectActiveRunConnection = () => {
    if (!activeRunContext) return
    setError(null)
    inspect
      .execute({ connectionId: activeRunContext.connectionId })
      .catch(cause => setError(cause instanceof Error ? cause.message : 'Connection inspection failed.'))
  }

  const stopSupported = Boolean(
    activeRunContext &&
    inspect.data?.connectionId === activeRunContext.connectionId &&
    inspect.data.driverId === activeRunContext.driverId &&
    inspect.data.capabilities.interrupt.support === 'supported',
  )
  const steerAvailable = Boolean(
    activeRun?.nativeTurnId &&
    activeRunContext &&
    inspect.data?.connectionId === activeRunContext.connectionId &&
    inspect.data.driverId === activeRunContext.driverId &&
    inspect.data.capabilities.steer.support === 'supported',
  )
  const steer = () => {
    if (!activeRun?.nativeTurnId || !steerAvailable || blocked || intent || !draft.trim()) return
    const prompt = draft.trim()
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
    if (
      !queueExhaustive ||
      blocked ||
      !contextComplete ||
      !checkoutId ||
      !item.driverId ||
      !item.connectionId ||
      intent
    )
      return
    const command: WorkspaceCommandInput<'workspace:promoteQueuedFollowUp'> = {
      commandId: commandIdFor(`promote:${item.commandId}`),
      taskId: task.id,
      conversationId,
      checkoutId,
      generation: 1,
      driverId: item.driverId,
      connectionId: item.connectionId,
      prompt: item.prompt,
      modelId: item.modelId ?? null,
      modeId: item.modeId ?? null,
      nativeSessionId: null,
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

  const keyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === 'Enter' &&
      (event.metaKey || event.ctrlKey) &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault()
      if (steerAvailable) steer()
      return
    }
    if (
      !shouldSubmitComposerKey({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing })
    )
      return
    event.preventDefault()
    submit()
  }

  return (
    <section className="bg-background shrink-0 border-t px-4 py-3" aria-label="Conversation composer">
      {pendingStarts.store.error && (
        <p className="mb-2 text-sm text-amber-700" role="alert">
          {pendingStarts.store.error}
        </p>
      )}
      {pendingStart && (
        <div className="mb-3 rounded-md border px-3 py-2 text-sm" role="status">
          <details>
            <summary className="cursor-pointer font-medium">Unconfirmed message</summary>
            <p className="text-muted-foreground mt-1 text-xs">
              {pendingStart.state === 'pending'
                ? 'Confirming message delivery…'
                : 'The message is saved. Retry to confirm delivery or send it if it was not accepted.'}
            </p>
            <p className="mt-2 break-words whitespace-pre-wrap">{pendingStart.rawDraft}</p>
          </details>
          {pendingStart.state === 'uncertain' && (
            <Button
              className="mt-2"
              type="button"
              variant="outline"
              size="sm"
              disabled={Boolean(intent) || startRun.pending}
              onClick={() => void retryPendingStart()}
            >
              Retry saved message
            </Button>
          )}
        </div>
      )}
      {(activeRun || unresolvedRun) && (
        <div className="mb-3 flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm" role="status">
          <span>
            {unresolvedRun
              ? 'Message delivery needs confirmation.'
              : (activityLabels[activeRun?.status ?? 'running'] ?? 'Working…')}
          </span>
          {activeRun && stopSupported && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={interrupt.pending}
              onClick={() => void stopRun()}
            >
              Stop Run
            </Button>
          )}
          {activeRun && !stopSupported && activeRunContext && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={inspect.pending}
              onClick={inspectActiveRunConnection}
            >
              Inspect Run connection to enable Stop
            </Button>
          )}
          {steerAvailable && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!draft.trim() || Boolean(intent) || steerRun.pending}
              onClick={steer}
            >
              Steer Run
            </Button>
          )}
        </div>
      )}
      {followUps.data?.items.length ? (
        <ol className="mb-3 max-h-36 space-y-2 overflow-auto" aria-label="Queued prompts">
          {followUps.data.items.map(item => (
            <li
              key={item.commandId}
              className="flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-sm"
            >
              <div className="min-w-0">
                <p className="text-muted-foreground text-xs">Queued #{item.position} · Waiting to dispatch</p>
                <p className="break-words whitespace-pre-wrap">{item.prompt}</p>
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
                <Button
                  type="button"
                  size="sm"
                  disabled={
                    !queueExhaustive ||
                    busy ||
                    blocked ||
                    !contextComplete ||
                    !item.driverId ||
                    !item.connectionId ||
                    promoteFollowUp.pending
                  }
                  onClick={() => void dispatchQueued(item)}
                >
                  Dispatch
                </Button>
              </div>
            </li>
          ))}
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

      <details className="mb-3">
        <summary className="text-muted-foreground cursor-pointer text-xs">Run settings</summary>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="flex min-w-0 flex-col gap-1 text-xs">
            Checkout
            <select
              className="bg-background min-w-0 rounded-md border px-2 py-1.5"
              value={checkoutId}
              onChange={event => {
                const nextCheckoutId = event.target.value as WorkspaceCheckoutId
                setSelectedCheckoutId(nextCheckoutId)
                setPreferences({ checkoutId: nextCheckoutId, connectionId })
              }}
              disabled={!checkoutChoices.length}
            >
              {checkoutChoices.map(checkout => (
                <option key={checkout.id} value={checkout.id}>
                  {checkout.branch ? `${checkout.kind} · ${checkout.branch}` : checkout.kind} · {checkout.path}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-xs">
            Harness connection
            <select
              className="bg-background min-w-0 rounded-md border px-2 py-1.5"
              value={connectionId}
              onChange={event => {
                setSelectedConnectionId(event.target.value)
                setResumeSessionId('')
                setModelId('')
                setModeId('')
                setPreferences({ checkoutId, connectionId: event.target.value })
              }}
            >
              <option value="">Choose a connection</option>
              {connections.data?.items.map(connection => (
                <option key={connection.connectionId} value={connection.connectionId}>
                  {connection.label}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!connectionId || inspect.pending}
              onClick={requestInspection}
            >
              {inspect.pending ? 'Inspecting…' : inspected ? 'Refresh inspection' : 'Inspect connection'}
            </Button>
            <span className="text-muted-foreground max-w-52 text-xs" role="status">
              {inspected
                ? `Authentication ${inspected.authentication}; protocol ${inspected.protocol.state}`
                : 'Capabilities unknown until inspected'}
            </span>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={resumeMode}
              onChange={event => {
                setResumeMode(event.target.checked)
                setResumeSessionId('')
              }}
            />
            Resume a native session
          </label>
          {resumeMode && (
            <label className="flex min-w-0 flex-col gap-1 text-xs sm:col-span-2">
              Native session
              <select
                className="bg-background min-w-0 rounded-md border px-2 py-1.5"
                value={resumeSessionId}
                onChange={event => {
                  setResumeSessionId(event.target.value)
                  const session = sessionChoices.find(choice => choice.id === event.target.value)
                  if (session) setPreferences({ checkoutId: session.checkoutId, connectionId: session.connectionId })
                }}
              >
                <option value="">Choose a validated session</option>
                {sessionChoices
                  .filter(
                    session =>
                      session.conversationId === conversationId &&
                      availableCheckoutIds.has(session.checkoutId) &&
                      (session.status === 'active' || session.status === 'suspended'),
                  )
                  .map(session => (
                    <option key={session.id} value={session.id}>
                      {session.driverId} · {session.connectionId} · generation {session.generation} · {session.status}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <label className="flex min-w-0 flex-col gap-1 text-xs">
            Model
            <select
              className="bg-background min-w-0 rounded-md border px-2 py-1.5"
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
          <label className="flex min-w-0 flex-col gap-1 text-xs">
            Effort / mode
            <select
              className="bg-background min-w-0 rounded-md border px-2 py-1.5"
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
        </div>
        {project.data?.nextAfterCheckoutId && (
          <p className="mt-2 text-sm text-amber-700" role="status">
            Checkout list is truncated. Listed checkouts remain selectable; unlisted sessions cannot be resumed.
          </p>
        )}
      </details>
      {inspect.error && (
        <p className="text-destructive mb-2 text-sm" role="alert">
          {inspect.error}
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
          {snapshot.error || project.error || connections.error || sessions.error || followUps.error || 'Loading chat…'}
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
      {!submitAvailable && !busy && (
        <p className="text-muted-foreground mb-2 text-xs" role="status">
          Select or check your agent in Run settings to continue.
        </p>
      )}
      <div className="flex items-end gap-3">
        <textarea
          aria-label="Prompt"
          className="bg-background max-h-60 min-h-24 min-w-0 flex-1 resize-y rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2"
          placeholder={busy ? 'Write a follow-up; Enter queues it' : 'Describe the work to do…'}
          value={draft}
          maxLength={WORKSPACE_DRAFT_MAX_LENGTH}
          onChange={event => {
            draftRef.current = event.target.value
            setDraft(event.target.value)
          }}
          onKeyDown={keyDown}
        />
        <Button
          type="button"
          disabled={
            !draft.trim() ||
            !actionStateReady ||
            blocked ||
            Boolean(pendingStart) ||
            Boolean(pendingStarts.store.error) ||
            Boolean(intent) ||
            (busy ? !queueExhaustive : !submitAvailable || (resumeMode && !validatedSession))
          }
          onClick={submit}
        >
          {intent ? 'Command pending' : busy ? 'Queue follow-up' : 'Send'}
        </Button>
      </div>
      <p className="text-muted-foreground mt-2 text-xs">
        Enter {busy ? 'queues' : 'sends'} · Shift+Enter adds a line
        {steerAvailable ? ' · Ctrl/⌘+Enter steers the active Run' : ''}. Drafts stay with this Conversation.
      </p>
    </section>
  )
}
