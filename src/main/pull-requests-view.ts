import { buildPrAttribution } from './pipeline/sessions-report.js'
import { overviewDateRange, type OverviewScope } from './overview.js'
import { buildSessionSummaries } from './store/aggregate.js'
import type { LedgerStore } from './store/ledger.js'
import type { SessionSummary } from './pipeline/types.js'
import {
  pullRequestsPayloadSchema,
  type PullRequestRow,
  type PullRequestsPayload,
} from '../shared/schemas/pull-requests.js'

export type { PullRequestRow, PullRequestsPayload } from '../shared/schemas/pull-requests.js'

/// One PR's aggregated row for the section UI. Omitted `categories` means the
/// PR has no per-category breakdown (no classified turn carried a category).

/**
 * The Pull Requests section's scoped payload (ADR 0008). Applies exactly the
 * same period / custom-range / provider scope as the Overview's
 * `overview:query`, then runs the turn-by-turn PR attribution (with subagent
 * folding) over the scoped set. Sessions whose transcript already expired keep
 * only session-level links and no per-turn refs: those attribute as legacy
 * whole-session splits (`approx`) and are INCLUDED with no category
 * breakdown, so the section degrades to an honest estimate instead of an
 * empty page. `attributedCost` stays summable across the rows: every session's
 * spend is distributed across its PRs exactly once. Kept in the main process
 * so the sandboxed renderer only receives serializable rows over IPC.
 */
function payloadFrom(sessions: SessionSummary[], anchors: SessionSummary[]): PullRequestsPayload {
  const { rows, totals } = buildPrAttribution(sessions, anchors)
  const attributedCost = rows.reduce((sum, r) => sum + r.cost, 0)
  return {
    rows: rows.map(({ url, label, cost, sessions, calls, firstStarted, lastEnded, models, categories }) => ({
      url,
      label,
      cost,
      sessions,
      calls,
      firstStarted,
      lastEnded,
      models,
      ...(categories?.length ? { categories } : {}),
    })),
    distinctCost: attributedCost + totals.unattributedCost,
    distinctSessions: totals.sessions,
    subagentSessions: totals.subagentSessions,
    attributedCost,
    unattributedCost: totals.unattributedCost,
  }
}

/**
 * Ledger-backed Pull Requests payload (map 03): the aggregation seam applies
 * the scope's range/provider at the SQL read and sessions count by their
 * in-range turns; the turn-by-turn PR attribution reducer then runs over the
 * seam's session summaries (no ProjectSummary shell reconstructed).
 */
export function buildPullRequestsViewFromLedger(store: LedgerStore, scope: OverviewScope, now = new Date()): PullRequestsPayload {
  const sessions = buildSessionSummaries(store, {
    range: overviewDateRange(scope, now),
    provider: scope.provider,
  })
  return pullRequestsPayloadSchema.parse(payloadFrom(sessions, []))
}
