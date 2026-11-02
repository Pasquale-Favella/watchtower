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
