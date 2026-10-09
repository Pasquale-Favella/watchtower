import type { PullRequestsPayload } from '../shared/schemas/pull-requests.js'
import { buildPrAttribution } from './pipeline/pr-attribution.js'
import type { PricingCatalogue } from './pipeline/pricing-calculation.js'
import type { SessionSummary } from './pipeline/types.js'

export function calculatePullRequestsPayload(
  sessions: SessionSummary[],
  catalogue: PricingCatalogue,
): PullRequestsPayload {
  const { rows, totals } = buildPrAttribution(sessions, [], catalogue)
  const attributedCost = rows.reduce((sum, row) => sum + row.cost, 0)
  return {
    rows: rows.map(
      ({ url, label, cost, sessions, calls, firstStarted, lastEnded, models, modelProvenance, categories }) => ({
        url,
        label,
        cost,
        sessions,
        calls,
        firstStarted,
        lastEnded,
        models,
        ...(modelProvenance && Object.keys(modelProvenance).length > 0 ? { modelProvenance } : {}),
        ...(categories?.length ? { categories } : {}),
      }),
    ),
    distinctCost: attributedCost + totals.unattributedCost,
    distinctSessions: totals.sessions,
    subagentSessions: totals.subagentSessions,
    attributedCost,
    unattributedCost: totals.unattributedCost,
  }
}
