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
