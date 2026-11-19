import type { DelegationSettledStatus, DelegationStatus } from '@/shared/schemas/delegation.js'
import type { AgentRunStatus } from '@/shared/schemas/execution.js'

const SETTLED: ReadonlySet<DelegationStatus> = new Set<DelegationStatus>([
  'completed',
  'failed',
  'interrupted',
  'cancelled',
  'uncertain',
])

export const isSettledDelegationStatus = (status: DelegationStatus): status is DelegationSettledStatus =>
  SETTLED.has(status)

/**
 * The parent's view of a child, derived from the child Run's status. `null` means the child has no Run yet. An
 * interrupt that was requested by the parent reads as `cancelled`, never as a failure. A pending request on a live
 * Run reads as `waiting`.
 */
export function delegationStatusFromRun(input: {
  readonly runStatus: AgentRunStatus | null
  readonly cancelRequested: boolean
  readonly pendingRequest: boolean
}): DelegationStatus {
  switch (input.runStatus) {
    case null:
    case 'queued':
      return 'queued'
    case 'starting':
    case 'running':
    case 'interruptRequested':
      return input.pendingRequest ? 'waiting' : 'running'
    case 'awaitingInput':
      return 'waiting'
    case 'completed':
      return 'completed'
    case 'interrupted':
      return input.cancelRequested ? 'cancelled' : 'interrupted'
    case 'failed':
      return 'failed'
    case 'uncertain':
    case 'recoveryRequired':
      return 'uncertain'
  }
}
