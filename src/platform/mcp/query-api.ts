import type { LedgerMcpCall, LedgerMcpScopeResult } from '@/shared/schemas/ledger-mcp-results.js'
import type { ModelsPayload } from '@/shared/schemas/models.js'
import type { OverviewPayload, OverviewScope } from '@/shared/schemas/overview.js'
import type { SkillsPayload } from '@/shared/schemas/skills.js'
import type { SessionRow } from '@/shared/schemas/views.js'
import type { LedgerMcpCallsInput } from '@/core/analytics/projections/ledger-mcp-calculation.js'
import type { DbWorkerClient } from '@/platform/electron/workers/client.js'

export type { LedgerMcpCallsInput } from '@/core/analytics/projections/ledger-mcp-calculation.js'

/** Read-only Promise boundary for MCP handlers. */
export interface LedgerMcpQueries {
  scope(scope: OverviewScope, signal?: AbortSignal): Promise<LedgerMcpScopeResult>
  overview(scope: OverviewScope, signal?: AbortSignal): Promise<OverviewPayload>
  sessions(scope: OverviewScope, signal?: AbortSignal): Promise<SessionRow[]>
  models(scope: OverviewScope, signal?: AbortSignal): Promise<ModelsPayload>
  skills(scope: OverviewScope, signal?: AbortSignal): Promise<SkillsPayload>
  calls(input: LedgerMcpCallsInput, signal?: AbortSignal): Promise<LedgerMcpCall[]>
}

export function createLedgerMcpQueries(
  // Electron supplies DbWorkerClient. Standalone query fixtures can supply just request.
  worker: Pick<DbWorkerClient, 'request'> & Partial<Pick<DbWorkerClient, 'requestRead'>>,
): LedgerMcpQueries {
  // The worker's typed RPC transport validates these results before returning them.
  async function read<A>(
    operation: string,
    input: OverviewScope | LedgerMcpCallsInput,
    signal?: AbortSignal,
  ): Promise<A> {
    signal?.throwIfAborted()
    const value =
      signal && worker.requestRead
        ? await worker.requestRead(operation, [input], signal)
        : await worker.request(operation, input)
    if (value == null) throw new Error('Ledger MCP query returned no result')
    return value as A
  }

  return {
    scope: (scope, signal) => read('ledger-mcp:scope', scope, signal),
    overview: (scope, signal) => read('overview:query', scope, signal),
    sessions: (scope, signal) => read('sessions:view', scope, signal),
    models: (scope, signal) => read('models:view', scope, signal),
    skills: (scope, signal) => read('skills:view', scope, signal),
    calls: (input, signal) => read('ledger-mcp:calls', input, signal),
  }
}
