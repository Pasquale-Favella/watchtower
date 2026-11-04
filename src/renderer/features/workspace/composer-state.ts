import type { AgentRun } from '@/shared/schemas/execution.js'
import type { ConversationId, TaskId, WorkspaceCheckoutId } from '@/shared/schemas/workspace.js'
import type { WorkspaceNativeAgentSession, WorkspaceRunContext } from '@/shared/schemas/workspace-store.js'

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

export type ComposerAwaiting = 'approval' | 'question' | null

/** Placeholder that points at what the agent is waiting for, or how a follow-up will be delivered. */
export function composerPlaceholder(input: {
  readonly busy: boolean
  readonly awaiting: ComposerAwaiting
  readonly canSteer: boolean
}): string | undefined {
  if (input.awaiting === 'question') return 'Answer the question above, or queue a follow-up'
  if (input.awaiting === 'approval') return 'Approve or decline the request above, or queue a follow-up'
  if (!input.busy) return undefined
  return input.canSteer
    ? 'Queue a follow-up, or Ctrl+Enter to steer the running turn'
    : 'Queue a follow-up. @ files, / skills and commands'
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
