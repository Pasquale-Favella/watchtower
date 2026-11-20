import type { AgentRun } from '@/shared/schemas/execution.js'

const activeStatuses = new Set<AgentRun['status']>([
  'queued',
  'starting',
  'running',
  'awaitingInput',
  'interruptRequested',
])

export type SideChatStatus =
  | 'notStarted'
  | 'queued'
  | 'running'
  | 'waiting'
  | 'stopping'
  | 'completed'
  | 'stopped'
  | 'failed'
  | 'needsAttention'
  | 'recovering'

/** Prefer the active attempt; otherwise report the latest durable attempt. */
export function sideChatStatus(runs: readonly AgentRun[]): SideChatStatus {
  if (runs.length === 0) return 'notStarted'
  const sorted = [...runs].sort(
    (left, right) => right.submittedAt.localeCompare(left.submittedAt) || right.id.localeCompare(left.id),
  )
  const latest = sorted.find(run => activeStatuses.has(run.status)) ?? sorted[0]
  if (!latest) return 'notStarted'
  switch (latest.status) {
    case 'queued':
      return 'queued'
    case 'starting':
    case 'running':
      return 'running'
    case 'awaitingInput':
      return 'waiting'
    case 'interruptRequested':
      return 'stopping'
    case 'completed':
      return 'completed'
    case 'interrupted':
      return 'stopped'
    case 'failed':
      return 'failed'
    case 'uncertain':
      return 'needsAttention'
    case 'recoveryRequired':
      return 'recovering'
  }
}

export type SideChatTabState = 'needsApproval' | 'needsInput' | 'running'

/** Tab dot state; null means no dot. A pending approval or question outranks the Run's own status. */
export function sideChatTabState(input: {
  readonly runs: readonly AgentRun[]
  readonly pendingRequestKind: 'approval' | 'question' | null | undefined
}): SideChatTabState | null {
  if (input.pendingRequestKind === 'approval') return 'needsApproval'
  if (input.pendingRequestKind === 'question') return 'needsInput'
  const status = sideChatStatus(input.runs)
  if (status === 'waiting') return 'needsInput'
  return status === 'queued' || status === 'running' || status === 'stopping' ? 'running' : null
}

/** Composer rule: a side chat cannot start another side chat, and it carries text only. */
export function sideChatCommandBlock(input: {
  readonly embedded: boolean
  readonly attachmentCount: number
}): { readonly reason: string } | null {
  if (input.embedded) return { reason: 'Side chats cannot start side chats.' }
  if (input.attachmentCount > 0)
    return { reason: 'Side chats take text only. Remove the attachments and context, then send it again.' }
  return null
}

export function sideChatStatusLabel(status: SideChatStatus): string {
  switch (status) {
    case 'notStarted':
      return 'Not started'
    case 'queued':
      return 'Queued'
    case 'running':
      return 'Running'
    case 'waiting':
      return 'Waiting'
    case 'stopping':
      return 'Stopping'
    case 'completed':
      return 'Completed'
    case 'stopped':
      return 'Stopped'
    case 'failed':
      return 'Failed'
    case 'needsAttention':
      return 'Needs attention'
    case 'recovering':
      return 'Recovering'
  }
}

const tabStateLabel: Record<SideChatTabState, string> = {
  needsApproval: 'needs approval',
  needsInput: 'needs input',
  running: 'running',
}

/** The tab's accessible name: its live title, followed by its state when one applies. */
export function sideChatTabName(title: string, state: SideChatTabState | null): string {
  return state ? `${title}, ${tabStateLabel[state]}` : title
}
