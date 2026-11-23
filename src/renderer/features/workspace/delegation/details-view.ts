import type { DelegationRecord } from '@/shared/schemas/delegation.js'

import { elapsedBetween } from '../timeline/duration.js'
import { isLiveDelegation } from './delegation-status.js'

type TimedDelegation = Pick<DelegationRecord, 'status' | 'settledAt' | 'createdAt'>

export function groupDelegationDetails<Record extends TimedDelegation>(
  records: readonly Record[],
): { readonly active: readonly Record[]; readonly previous: readonly Record[] } {
  const newestFirst = [...records].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  return {
    active: newestFirst.filter(isLiveDelegation),
    previous: newestFirst.filter(record => !isLiveDelegation(record)),
  }
}

export function delegationDetailsElapsed(record: TimedDelegation, now: number | null): number | null {
  if (record.settledAt !== null) return elapsedBetween(record.createdAt, record.settledAt)
  if (!isLiveDelegation(record) || now === null) return null

  const startedAt = Date.parse(record.createdAt)
  return Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : null
}
