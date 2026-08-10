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
 * folding) over the scoped set. The ticket builds ONLY the turn-by-turn
 * model: legacy whole-session-split rows (`approx`) are dropped, so every
 * returned row carries honest turn-level attribution and `attributedCost` is
 * summable across the rows. Kept in the main process so the sandboxed
 * renderer only receives serializable rows over IPC.
 */
function payloadFrom(sessions: SessionSummary[], anchors: SessionSummary[]): PullRequestsPayload {
  const { rows, totals } = buildPrAttribution(sessions, anchors)
  const visible = rows.filter(r => !r.approx)
  const attributedCost = visible.reduce((sum, r) => sum + r.cost, 0)
  return {
    rows: visible.map(({ url, label, cost, sessions, calls, firstStarted, lastEnded, models, categories }) => ({
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
