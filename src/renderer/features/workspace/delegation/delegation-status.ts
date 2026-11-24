import type { DelegationRecord, DelegationStatus } from '@/shared/schemas/delegation.js'

export type DelegationTone = 'active' | 'attention' | 'success' | 'failure' | 'neutral'

const statusLabels: Record<DelegationStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting: 'Waiting',
  completed: 'Completed',
  failed: 'Failed',
  interrupted: 'Stopped',
  cancelled: 'Stopped',
  uncertain: 'Uncertain',
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

export function hasPendingWake(record: Pick<DelegationRecord, 'settledAt' | 'wakeState'>): boolean {
  return record.settledAt !== null && (record.wakeState === 'pending' || record.wakeState === 'queued')
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

/**
 * Queued prompts a person can act on. A delegation wake that is not paused delivers itself when the parent
 * Run is free, so it is left out of the list; a paused one stays because Resume lives on its row.
 * `queueIndex` is the place in the full queue and `number` the place in the shown list.
 */
export function visibleQueuedFollowUps<
  T extends { readonly origin?: 'user' | 'delegation' | undefined; readonly held?: boolean | undefined },
>(items: readonly T[]): readonly { readonly item: T; readonly queueIndex: number; readonly number: number }[] {
  const shown: { item: T; queueIndex: number; number: number }[] = []
  items.forEach((item, queueIndex) => {
    if (item.origin === 'delegation' && item.held !== true) return
    shown.push({ item, queueIndex, number: shown.length + 1 })
  })
  return shown
}

export interface DelegationTally {
  readonly running: number
  readonly queued: number
  /** Waiting without a request the user can act on. */
  readonly waiting: number
  readonly needsAnswer: number
  readonly needsApproval: number
}

/** Counts live delegations by their status. A pending request takes precedence over the status. */
export function delegationTally(records: readonly DelegationRecord[]): DelegationTally {
  const tally = { running: 0, queued: 0, waiting: 0, needsAnswer: 0, needsApproval: 0 }
  for (const record of records) {
    if (!isLiveDelegation(record)) continue
    if (record.pendingRequest?.kind === 'question') tally.needsAnswer += 1
    else if (record.pendingRequest?.kind === 'approval') tally.needsApproval += 1
    else if (record.status === 'queued') tally.queued += 1
    else if (record.status === 'waiting') tally.waiting += 1
    else tally.running += 1
  }
  return tally
}

/** `2 running · 1 queued · 1 needs answer`, or null when nothing is live. */
export function delegationTallyLabel(tally: DelegationTally): string | null {
  const parts = [
    tally.running > 0 ? `${tally.running} running` : null,
    tally.queued > 0 ? `${tally.queued} queued` : null,
    tally.waiting > 0 ? `${tally.waiting} waiting` : null,
    tally.needsAnswer > 0 ? `${tally.needsAnswer} needs answer` : null,
    tally.needsApproval > 0 ? `${tally.needsApproval} needs approval` : null,
  ].filter((part): part is string => part !== null)
  return parts.length > 0 ? parts.join(' · ') : null
}

export interface DelegationHeadline {
  /** The state to lead with: what needs the user first, then what is running, then what is queued. */
  readonly phase: 'Waiting' | 'Running' | 'Queued'
  readonly tone: DelegationTone
  /** What follows the phase: `2 delegates`, or the requests that need the user. */
  readonly detail: string
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** The one-line summary of live delegations, or null when nothing is live. */
export function delegationHeadline(tally: DelegationTally): DelegationHeadline | null {
  const total = tally.running + tally.queued + tally.waiting + tally.needsAnswer + tally.needsApproval
  if (total === 0) return null
  if (tally.needsAnswer + tally.needsApproval + tally.waiting > 0) {
    const parts = [
      tally.needsApproval > 0 ? `${tally.needsApproval} needs approval` : null,
      tally.needsAnswer > 0 ? `${tally.needsAnswer} needs answer` : null,
      tally.waiting > 0 ? `${tally.waiting} waiting` : null,
    ].filter((part): part is string => part !== null)
    return { phase: 'Waiting', tone: 'attention', detail: parts.join(' · ') }
  }
  const phase = tally.running > 0 ? 'Running' : 'Queued'
  return { phase, tone: 'active', detail: plural(total, 'delegate', 'delegates') }
}

const attentionRank = (record: DelegationRecord): number => {
  if (record.pendingRequest !== null) return 0
  if (record.status === 'waiting') return 1
  if (record.status === 'running') return 2
  if (record.status === 'queued') return 3
  return 4
}

/** Rows in the order a person should read them: needs attention, running, queued, then held results. Newest first within a group. */
export function sortStripDelegations(records: readonly DelegationRecord[]): readonly DelegationRecord[] {
  return [...records].sort(
    (a, b) => attentionRank(a) - attentionRank(b) || Date.parse(b.createdAt) - Date.parse(a.createdAt),
  )
}

/** The waiting request of one delegation, as the parent should describe it. */
export function delegateWaitingLabel(record: Pick<DelegationRecord, 'pendingRequest'>): string | null {
  if (record.pendingRequest?.kind === 'question') return 'Delegate waiting · Needs answer'
  if (record.pendingRequest?.kind === 'approval') return 'Delegate waiting · Needs approval'
  return null
}
