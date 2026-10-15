import type * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { SqlError } from 'effect/unstable/sql/SqlError'

import type { ComparePair } from '../../shared/schemas/compare.js'
import type { OverviewScope } from '../../shared/schemas/overview.js'
import {
  DEFAULT_SKILLS_THRESHOLDS,
  type SkillsThresholds,
  skillsThresholdsSchema,
} from '../../shared/schemas/skills.js'
import type { AssistantSetup } from '../application/assistant-setup.js'
import { queryCompareView } from '../application/compare-query.js'
import type { ExportFiles } from '../application/export-files.js'
import { queryExport } from '../application/export-query.js'
import { queryModelsView } from '../application/models-query.js'
import { queryOptimizeView } from '../application/optimize-query.js'
import { queryOverview } from '../application/overview-query.js'
import type { PricingDiagnostics } from '../application/pricing-diagnostics.js'
import { queryPullRequestsView } from '../application/pull-requests-query.js'
import type { RepositoryInspection } from '../application/repository-inspection.js'
import { querySessionDetail } from '../application/session-detail-query.js'
import { querySessionSearch } from '../application/session-search-query.js'
import { querySessionsView } from '../application/sessions-query.js'
import { querySkillsView } from '../application/skills-query.js'
import { querySpendView } from '../application/spend-query.js'
import { queryProjectRows, querySessionRows } from '../application/store-row-queries.js'
import { queryAnalyticalViews, queryDashboardViews } from '../application/view-queries.js'
import { queryYieldView } from '../application/yield-query.js'
import { captureLocalModelSavings, captureModelPricingCatalogue, captureProxyPaths } from '../pipeline/models.js'
import type { LedgerExportReads } from '../store/ledger-export-reads.js'
import type { LedgerConfig, LedgerQueries } from '../store/ledger-ports.js'
import type { LedgerSessionReads } from '../store/ledger-session-reads.js'
import type { LedgerViewReads } from '../store/ledger-view-reads.js'

type QueryServices =
  | LedgerQueries
  | LedgerConfig
  | LedgerSessionReads
  | LedgerViewReads
  | LedgerExportReads
  | PricingDiagnostics
  | AssistantSetup
  | RepositoryInspection
  | ExportFiles

/** Transport chooses a query; the application Effect runs in the worker's existing runtime. */
export function ledgerQueryRequest(
  op: string,
  args: unknown[],
): Effect.Effect<unknown, SqlError | Schema.SchemaError, QueryServices> | undefined {
  switch (op) {
    case 'store:views':
      return queryDashboardViews({ catalogue: captureModelPricingCatalogue(), proxyPaths: captureProxyPaths() })

    case 'store:projects':
      return queryProjectRows({ catalogue: captureModelPricingCatalogue() })

    case 'store:sessions': {
      const filter = (args[0] ?? {}) as { project?: string; since?: string; until?: string }
      return querySessionRows({ catalogue: captureModelPricingCatalogue(), filter })
    }

    case 'sessions:view': {
      const scope = args[0] as OverviewScope
      return querySessionsView({ scope, catalogue: captureModelPricingCatalogue(), proxyPaths: captureProxyPaths() })
    }

    case 'pullRequests:view': {
      const scope = args[0] as OverviewScope
      return queryPullRequestsView({
        scope,
        catalogue: captureModelPricingCatalogue(),
        proxyPaths: captureProxyPaths(),
      })
    }

    case 'spend:view': {
      const scope = args[0] as OverviewScope
      return querySpendView({ scope, catalogue: captureModelPricingCatalogue(), proxyPaths: captureProxyPaths() })
    }

    case 'models:view': {
      const scope = args[0] as OverviewScope
      return queryModelsView({ scope, catalogue: captureModelPricingCatalogue(), proxyPaths: captureProxyPaths() })
    }

    case 'compare:view': {
      const scope = args[0] as OverviewScope
      const pair = args[1] as ComparePair | undefined
      return queryCompareView({
        scope,
        pair,
        catalogue: captureModelPricingCatalogue(),
        proxyPaths: captureProxyPaths(),
      })
    }

    case 'optimize:view': {
      const scope = args[0] as OverviewScope
      return queryOptimizeView({ scope, catalogue: captureModelPricingCatalogue(), proxyPaths: captureProxyPaths() })
    }

    case 'skills:view': {
      const scope = args[0] as OverviewScope
      const thresholds = args[1] as SkillsThresholds | undefined
      // Schema decoding requires positive integer thresholds and applies
      // defaults. Invalid IPC values use the default pair (ADR 0005).
      const parsed = Schema.decodeUnknownResult(skillsThresholdsSchema)(thresholds)
      // Dismissals ride every fetch (ticket 25): the not-a-skill store filters
      // rejected patterns out of drafts AND opportunities before the gate.
      return querySkillsView({
        scope,
        thresholds: parsed._tag === 'Success' ? parsed.success : DEFAULT_SKILLS_THRESHOLDS,
        catalogue: captureModelPricingCatalogue(),
        proxyPaths: captureProxyPaths(),
      })
    }

    case 'optimize:yield': {
      const scope = args[0] as OverviewScope
      return queryYieldView({ scope, catalogue: captureModelPricingCatalogue(), proxyPaths: captureProxyPaths() })
    }

    case 'store:session': {
      const sessionId = args[0] as string
      return querySessionDetail({
        sessionId,
        catalogue: captureModelPricingCatalogue(),
        proxyPaths: captureProxyPaths(),
      })
    }

    case 'store:analytics':
      return queryAnalyticalViews({ catalogue: captureModelPricingCatalogue(), proxyPaths: captureProxyPaths() })

    case 'overview:query': {
      const scope = args[0] as OverviewScope
      return queryOverview({
        scope,
        catalogue: captureModelPricingCatalogue(),
        proxyPaths: captureProxyPaths(),
        localSavings: captureLocalModelSavings(),
      })
    }

    case 'store:search': {
      const query = args[0] as string
      return querySessionSearch({ query, catalogue: captureModelPricingCatalogue() })
    }

    case 'export:csv': {
      return queryExport({
        kind: 'csv',
        outputPath: args[0] as string,
        catalogue: captureModelPricingCatalogue(),
        proxyPaths: captureProxyPaths(),
      })
    }

    case 'export:json': {
      return queryExport({
        kind: 'json',
        outputPath: args[0] as string,
        catalogue: captureModelPricingCatalogue(),
        proxyPaths: captureProxyPaths(),
      })
    }
    default:
      return undefined
  }
}
