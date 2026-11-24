import type { DelegationRecord } from '@/shared/schemas/delegation.js'

import { elapsedBetween } from '../timeline/duration.js'
import { hasPendingWake, isLiveDelegation } from './delegation-status.js'

type TimedDelegation = Pick<DelegationRecord, 'status' | 'settledAt' | 'createdAt'>
type DelegationWithWake = TimedDelegation & Pick<DelegationRecord, 'wakeState'>

export function groupDelegationDetails<Record extends DelegationWithWake>(
  records: readonly Record[],
): { readonly active: readonly Record[]; readonly pending: readonly Record[]; readonly previous: readonly Record[] } {
  const newestFirst = [...records].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  const active: Record[] = []
  const pending: Record[] = []
  const previous: Record[] = []
  for (const record of newestFirst) {
    if (isLiveDelegation(record)) active.push(record)
    else if (hasPendingWake(record)) pending.push(record)
    else previous.push(record)
  }
  return { active, pending, previous }
}

export function delegationDetailsElapsed(record: TimedDelegation, now: number | null): number | null {
  if (record.settledAt !== null) return elapsedBetween(record.createdAt, record.settledAt)
  if (!isLiveDelegation(record) || now === null) return null

  const startedAt = Date.parse(record.createdAt)
  return Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : null
}
