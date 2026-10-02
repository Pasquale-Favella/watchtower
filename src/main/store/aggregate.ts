import { getShortModelName } from '../pipeline/models.js'
import { reportUnpricedModels } from '../pipeline/pricing-diagnostics.js'
import { type SessionRow, sessionRowFromSummary } from '../pipeline/session-row.js'
import type { ClassifiedTurn, DateRange, SessionSummary } from '../pipeline/types.js'
import {
  type AggregateScope,
  assembleSession as pureAssembleSession,
  buildSessionSummariesFromSnapshotResult,
  type LedgerScope,
  queryScopeFromSnapshotResult,
} from './aggregate-calculation.js'
import type { LedgerSessionRow, LedgerStore } from './ledger.js'
import type { LedgerQuerySnapshot } from './ledger-query-snapshot.js'
import { loadLedgerQuerySnapshot } from './query-snapshot.js'

export * from './aggregate-calculation.js'

/** Temporary synchronous adapters; retire after all query callers use Effect. */
export function queryScope(store: LedgerStore, scope: AggregateScope): LedgerScope {
  return queryScopeFromSnapshot(loadLedgerQuerySnapshot(store), scope)
}

export function queryScopeFromSnapshot(snapshot: LedgerQuerySnapshot, scope: AggregateScope): LedgerScope {
  const result = queryScopeFromSnapshotResult(snapshot, scope)
  reportUnpricedModels(result.unpricedModels)
  return result.scope
}

export function assembleSession(
  session: LedgerSessionRow,
  fullTurns: ClassifiedTurn[],
  range: DateRange,
): SessionSummary | null {
  return pureAssembleSession(session, fullTurns, range, getShortModelName)
}

export function buildSessionSummaries(store: LedgerStore, scope: AggregateScope): SessionSummary[] {
  return buildSessionSummariesFromSnapshot(loadLedgerQuerySnapshot(store), scope)
}

export function buildSessionSummariesFromSnapshot(
  snapshot: LedgerQuerySnapshot,
  scope: AggregateScope,
): SessionSummary[] {
  const result = buildSessionSummariesFromSnapshotResult(snapshot, scope)
  reportUnpricedModels(result.unpricedModels)
  return result.summaries
}

export function buildSessionRows(store: LedgerStore, scope: AggregateScope): SessionRow[] {
  const snapshot = loadLedgerQuerySnapshot(store)
  const result = buildSessionSummariesFromSnapshotResult(snapshot, scope)
  reportUnpricedModels(result.unpricedModels)
  return result.summaries.map(summary => sessionRowFromSummary(summary, summary.project))
}
