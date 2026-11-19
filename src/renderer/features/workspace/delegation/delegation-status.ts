import type { DelegationRecord, DelegationStatus } from '@/shared/schemas/delegation.js'

export type DelegationTone = 'active' | 'attention' | 'success' | 'failure' | 'neutral'

const statusLabels: Record<DelegationStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting: 'Waiting',
  completed: 'Completed',
  failed: 'Failed',
  interrupted: 'Stopped',
  cancelled: 'Cancelled',
  uncertain: 'Needs attention',
}

const statusTones: Record<DelegationStatus, DelegationTone> = {
  queued: 'active',
  running: 'active',
  waiting: 'attention',
  completed: 'success',
  failed: 'failure',
  interrupted: 'neutral',
  cancelled: 'neutral',
  uncertain: 'attention',
}

const liveStatuses: ReadonlySet<DelegationStatus> = new Set(['queued', 'running', 'waiting'])

export function delegationStatusLabel(status: DelegationStatus): string {
  return statusLabels[status]
}

export function delegationStatusTone(status: DelegationStatus): DelegationTone {
  return statusTones[status]
}

/** A Delegated Task that has not settled yet. Its wake, if any, has not been queued. */
export function isLiveDelegation(record: Pick<DelegationRecord, 'status' | 'settledAt'>): boolean {
  return record.settledAt === null && liveStatuses.has(record.status)
}

/**
 * A settled Delegated Task whose result waits for the user. The wake is held when the parent Task
 * has no active Run to receive it, so the parent shows a note instead of starting work on its own.
 */
export function heldWake(record: Pick<DelegationRecord, 'settledAt' | 'wakeState'>, parentRunActive: boolean): boolean {
  return record.settledAt !== null && record.wakeState === 'pending' && !parentRunActive
}

/** Records the parent strip shows: live delegations and settled ones whose wake is still held. */
export function stripDelegations(
  records: readonly DelegationRecord[],
  parentRunActive: boolean,
): readonly DelegationRecord[] {
  return records.filter(record => isLiveDelegation(record) || heldWake(record, parentRunActive))
}

export interface DelegationTally {
  readonly running: number
  readonly queued: number
  readonly needsAnswer: number
  readonly needsApproval: number
}

/** Counts live delegations by what they are doing. A pending request takes precedence over the status. */
export function delegationTally(records: readonly DelegationRecord[]): DelegationTally {
  const tally = { running: 0, queued: 0, needsAnswer: 0, needsApproval: 0 }
  for (const record of records) {
    if (!isLiveDelegation(record)) continue
    if (record.pendingRequest?.kind === 'question') tally.needsAnswer += 1
    else if (record.pendingRequest?.kind === 'approval') tally.needsApproval += 1
    else if (record.status === 'queued') tally.queued += 1
    else tally.running += 1
  }
  return tally
}

/** `2 running · 1 needs answer`, or null when nothing is live. */
export function delegationTallyLabel(tally: DelegationTally): string | null {
  const parts = [
    tally.running > 0 ? `${tally.running} running` : null,
    tally.queued > 0 ? `${tally.queued} queued` : null,
    tally.needsAnswer > 0 ? `${tally.needsAnswer} needs answer` : null,
    tally.needsApproval > 0 ? `${tally.needsApproval} needs approval` : null,
  ].filter((part): part is string => part !== null)
  return parts.length > 0 ? parts.join(' · ') : null
}

/** The waiting request of one delegation, as the parent should describe it. */
export function delegateWaitingLabel(record: Pick<DelegationRecord, 'pendingRequest'>): string | null {
  if (record.pendingRequest?.kind === 'question') return 'Delegate waiting · Needs answer'
  if (record.pendingRequest?.kind === 'approval') return 'Delegate waiting · Needs approval'
  return null
}
