import type { LedgerMcpCall, LedgerMcpScopeResult } from '../../../shared/schemas/ledger-mcp-results.js'
import type { ModelsPayload } from '../../../shared/schemas/models.js'
import type { OverviewPayload, OverviewScope } from '../../../shared/schemas/overview.js'
import type { SkillsPayload } from '../../../shared/schemas/skills.js'
import type { SessionRow } from '../../../shared/schemas/views.js'
import type { LedgerMcpCallsInput } from '../../ledger-mcp-calculation.js'

export type { LedgerMcpCallsInput } from '../../ledger-mcp-calculation.js'

/** Promise boundary for MCP handlers, backed by the sidecar's process runtime. */
export interface LedgerMcpQueries {
  scope(scope: OverviewScope): Promise<LedgerMcpScopeResult>
  overview(scope: OverviewScope): Promise<OverviewPayload>
  sessions(scope: OverviewScope): Promise<SessionRow[]>
  models(scope: OverviewScope): Promise<ModelsPayload>
  skills(scope: OverviewScope): Promise<SkillsPayload>
  calls(input: LedgerMcpCallsInput): Promise<LedgerMcpCall[]>
}
