import type { Hotkey } from '@tanstack/react-hotkeys'

import { displayShortcutText } from '@/renderer/app/shortcuts.js'
import type { AgentRun } from '@/shared/schemas/execution.js'
import type { Platform } from '@/shared/schemas/renderer.js'
import type { ConversationId, TaskId, WorkspaceCheckoutId } from '@/shared/schemas/workspace.js'
import type { WorkspaceNativeAgentSession, WorkspaceRunContext } from '@/shared/schemas/workspace-store.js'

export function pausedFollowUpHead<T extends { readonly held?: boolean | undefined }>(
  items: readonly T[],
): T | undefined {
  const head = items[0]
  return head?.held ? head : undefined
}

export function shouldSubmitComposerKey(input: {
  readonly key: string
  readonly shiftKey: boolean
  readonly isComposing: boolean
}): boolean {
  return input.key === 'Enter' && !input.shiftKey && !input.isComposing
}

export type ComposerDispatch = 'send' | 'queue' | 'steer'

/** While a Run is active a prompt queues; the alternate modifier steers when the running agent supports it. */
export function resolveComposerDispatch(input: {
  readonly busy: boolean
  readonly canSteer: boolean
  readonly alternate: boolean
}): ComposerDispatch {
  if (!input.busy) return 'send'
  return input.alternate && input.canSteer ? 'steer' : 'queue'
}

/** Stop takes the primary slot while a Run is active and there is nothing to send. */
export function isStopPrimary(input: {
  readonly busy: boolean
  readonly canStop: boolean
  readonly hasContent: boolean
}): boolean {
  return input.busy && input.canStop && !input.hasContent
}

/** The picker stays closed until its queue read and pending submissions are known. */
export function canOpenAgentPicker(input: {
  readonly queueExhaustive: boolean
  readonly pendingStart: boolean
  readonly submissionPending: boolean
  readonly handoffPendingRun: boolean
}): boolean {
  return input.queueExhaustive && !input.pendingStart && !input.submissionPending && !input.handoffPendingRun
}

/** Changing connections starts a new native session, so do not switch during a Run or queued delivery. */
export function canSwitchAgentConnection(input: {
  readonly busy: boolean
  readonly queueExhaustive: boolean
  readonly queuedCount: number
  readonly pendingStart: boolean
  readonly submissionPending: boolean
}): boolean {
  return (
    !input.busy && input.queueExhaustive && input.queuedCount === 0 && !input.pendingStart && !input.submissionPending
  )
}

/** Keys the composer reacts to: Enter submits (queues while a Run is active), Shift+Enter is a new line,
 * the platform modifier with Enter (or a click) steers. No key stops a Run. */
const SUBMIT_HOTKEY: Hotkey = 'Enter'
const NEW_LINE_HOTKEY: Hotkey = 'Shift+Enter'
const STEER_HOTKEY: Hotkey = 'Mod+Enter'

export interface ComposerActionHintRow {
  readonly label: string
  /** The formatted key chip, absent for an informational line. */
  readonly keys?: string
  /** A formatted pointer alternative to the key, such as `Ctrl+click`. */
  readonly orClick?: string
  /** A short explanation shown below the label. */
  readonly detail?: string
  readonly muted?: boolean
}

/** What the submit button's tooltip says about sending, queueing and steering. */
export function composerActionHintRows(input: {
  readonly busy: boolean
  readonly canSteer: boolean
  readonly platform?: Platform
}): readonly ComposerActionHintRow[] {
  const keys = (hotkey: Hotkey) => displayShortcutText(hotkey, input.platform)
  if (!input.busy)
    return [
      { label: 'Send', keys: keys(SUBMIT_HOTKEY) },
      { label: 'New line', keys: keys(NEW_LINE_HOTKEY) },
    ]
  const queue: ComposerActionHintRow = {
    label: 'Queue follow-up',
    keys: keys(SUBMIT_HOTKEY),
    detail: 'Sent when the current turn ends',
  }
  return input.canSteer
    ? [
        queue,
        {
          label: 'Steer the running turn',
          keys: keys(STEER_HOTKEY),
          orClick: `${displayShortcutText('Mod', input.platform)}+click`,
        },
      ]
    : [queue, { label: "This agent doesn't support steering", muted: true }]
}

export type ComposerAwaiting = 'approval' | 'question' | null

/** Placeholder that points at what the agent is waiting for, or how a follow-up will be delivered. */
export function composerPlaceholder(input: {
  readonly busy: boolean
  readonly awaiting: ComposerAwaiting
  readonly canSteer: boolean
  readonly hideFileMentions?: boolean
  readonly platform?: Platform
}): string | undefined {
  if (input.awaiting === 'question') return 'Answer the question above, or queue a follow-up'
  if (input.awaiting === 'approval') return 'Approve or decline the request above, or queue a follow-up'
  if (!input.busy) return undefined
  return input.canSteer
    ? `Queue a follow-up, or ${displayShortcutText(STEER_HOTKEY, input.platform)} to steer the running turn`
    : `Queue a follow-up. ${input.hideFileMentions ? '' : '@ files, '}/ commands, $ skills`
}

const activeRunStatuses = new Set<AgentRun['status']>([
  'queued',
  'starting',
  'running',
  'awaitingInput',
  'interruptRequested',
])

export function isRunActive(run: AgentRun): boolean {
  return activeRunStatuses.has(run.status)
}

export function currentConversationRuns(
  runs: readonly AgentRun[],
  contexts: readonly WorkspaceRunContext[],
  conversationId: ConversationId,
): AgentRun[] {
  const contextByRun = new Map(contexts.map(context => [context.runId, context]))
  return runs.filter(run => contextByRun.get(run.id)?.conversationId === conversationId)
}

/**
 * The checkout the server bound the Conversation's newest Run to. A "No project" chat starts from the
 * scratch root but runs in its own folder, so this, not the saved preference, names where it works.
 */
export function latestConversationCheckoutId(
  runs: readonly AgentRun[],
  contexts: readonly WorkspaceRunContext[],
  conversationId: ConversationId | null | undefined,
): WorkspaceCheckoutId | undefined {
  if (!conversationId) return undefined
  const checkoutByRun = new Map(
    contexts.filter(context => context.conversationId === conversationId).map(context => [context.runId, context]),
  )
  const latest = runs
    .filter(run => checkoutByRun.has(run.id))
    .sort((left, right) => right.submittedAt.localeCompare(left.submittedAt) || right.id.localeCompare(left.id))[0]
  return latest ? checkoutByRun.get(latest.id)?.checkoutId : undefined
}

/**
 * The model and effort a chat last ran with: the composer shows it
 * until the user picks another. A Delegated Task's chat saves no picker choice, so this is how its composer shows
 * the model the parent agent chose. It does not carry over to another connection.
 */
export function conversationAgentChoice(input: {
  readonly runs: readonly AgentRun[]
  readonly contexts: readonly WorkspaceRunContext[]
  readonly conversationId: ConversationId
  readonly connectionId: string
}): { readonly modelId: string; readonly modeId: string } {
  const contextByRun = new Map(
    input.contexts.filter(context => context.conversationId === input.conversationId).map(c => [c.runId, c]),
  )
  const latest = input.runs
    .filter(run => contextByRun.has(run.id))
    .sort((left, right) => right.submittedAt.localeCompare(left.submittedAt) || right.id.localeCompare(left.id))[0]
  const context = latest ? contextByRun.get(latest.id) : undefined
  if (context?.connectionId !== input.connectionId) return { modelId: '', modeId: '' }
  return { modelId: context.modelId ?? '', modeId: context.modeId ?? '' }
}

/** Only the newest attempt can make the current composer state uncertain. Older terminal
 * uncertainty remains in history, but must not shadow a newer completed attempt. */
export function latestUnresolvedRun(runs: readonly AgentRun[]): AgentRun | null {
  const latest = [...runs].sort(
    (left, right) => right.submittedAt.localeCompare(left.submittedAt) || right.id.localeCompare(left.id),
  )[0]
  return latest && (latest.status === 'uncertain' || latest.status === 'recoveryRequired') ? latest : null
}

export function latestConversationSession(
  runs: readonly AgentRun[],
  sessions: readonly WorkspaceNativeAgentSession[],
  conversationId: ConversationId,
  checkoutId: WorkspaceCheckoutId | '',
  connectionId: string,
): WorkspaceNativeAgentSession | null {
  const byId = new Map(sessions.map(session => [session.id, session]))
  for (const run of [...runs].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))) {
    const session = run.sessionId ? byId.get(run.sessionId) : undefined
    if (
      session &&
      session.conversationId === conversationId &&
      session.checkoutId === checkoutId &&
      session.connectionId === connectionId &&
      (session.status === 'active' || session.status === 'suspended')
    )
      return session
  }
  return null
}

/**
 * The native session a Conversation continues, whichever agent ran it, as long as that agent is still detected.
 * A started chat stays with that agent and resumes its context on every message.
 */
export function boundConversationSession(
  runs: readonly AgentRun[],
  sessions: readonly WorkspaceNativeAgentSession[],
  conversationId: ConversationId,
  checkoutId: WorkspaceCheckoutId | '',
  detectedConnectionIds: ReadonlySet<string>,
): WorkspaceNativeAgentSession | null {
  const byId = new Map(sessions.map(session => [session.id, session]))
  for (const run of [...runs].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))) {
    const session = run.sessionId ? byId.get(run.sessionId) : undefined
    if (!session || session.conversationId !== conversationId || session.checkoutId !== checkoutId) continue
    // Only the newest session counts: an ended one means the next message starts fresh.
    if (session.status !== 'active' && session.status !== 'suspended') return null
    return detectedConnectionIds.has(session.connectionId) ? session : null
  }
  return null
}

/** A different Harness Connection needs a new native session in the same Conversation. */
export function connectionHandoffTarget(
  continuation: WorkspaceNativeAgentSession | null,
  selectedConnectionId: string,
): WorkspaceNativeAgentSession | null {
  return continuation && selectedConnectionId && continuation.connectionId !== selectedConnectionId
    ? continuation
    : null
}
/** Why the requested agent cannot take the next message, or null while it can or is still being inspected. */
export function targetSelectionError(input: {
  readonly connectionId: string
  readonly detectedConnectionIds: ReadonlySet<string>
  readonly inspected: { readonly canSubmit: boolean } | null
}): string | null {
  if (!input.connectionId) return null
  if (!input.detectedConnectionIds.has(input.connectionId))
    return 'The selected agent is no longer available. Choose another agent to continue.'
  if (input.inspected && !input.inspected.canSubmit) return 'The selected agent cannot continue this chat.'
  return null
}

export interface ResumeSelection {
  readonly taskId: TaskId
  readonly conversationId: ConversationId
  readonly checkoutId: WorkspaceCheckoutId
  readonly driverId: string
  readonly connectionId: string
  readonly nativeSessionId: string
  readonly generation: number
}

export function validateResumeSelection(
  selection: ResumeSelection,
  sessions: readonly WorkspaceNativeAgentSession[],
  availableCheckoutIds: ReadonlySet<WorkspaceCheckoutId>,
): WorkspaceNativeAgentSession | null {
  if (!availableCheckoutIds.has(selection.checkoutId)) return null
  return (
    sessions.find(
      session =>
        session.taskId === selection.taskId &&
        session.conversationId === selection.conversationId &&
        session.checkoutId === selection.checkoutId &&
        session.driverId === selection.driverId &&
        session.connectionId === selection.connectionId &&
        session.nativeSessionId === selection.nativeSessionId &&
        session.generation === selection.generation &&
        (session.status === 'active' || session.status === 'suspended'),
    ) ?? null
  )
}
