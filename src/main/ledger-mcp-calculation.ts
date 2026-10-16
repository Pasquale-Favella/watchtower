import type { LedgerMcpCall, LedgerMcpScopeResult } from '../shared/schemas/ledger-mcp-results.js'
import type { OverviewScope } from '../shared/schemas/overview.js'
import type { DateRange } from './pipeline/types.js'
import type { LedgerScope } from './store/aggregate-calculation.js'

function isWithinRange(timestamp: string, range: DateRange): boolean {
  const ms = new Date(timestamp).getTime()
  return !Number.isNaN(ms) && ms >= range.start.getTime() && ms <= range.end.getTime()
}

export type LedgerMcpCallsInput = {
  readonly scope: OverviewScope
  readonly limit?: number | undefined
  readonly model?: string | undefined
  readonly project?: string | undefined
  readonly category?: string | undefined
  readonly tool?: string | undefined
}

export function calculateLedgerMcpScope(
  data: LedgerScope,
  scope: OverviewScope,
  range: DateRange,
): LedgerMcpScopeResult {
  const startMs = range.start.getTime()
  const endMs = range.end.getTime()
  const calls = data.calls.filter(call => isWithinRange(call.timestamp, range))
  const inScopeSessions = new Set(calls.map(call => `${call.sourceId}\0${call.sessionId}`))

  return {
    scope,
    range: { startMs, endMs },
    sessions: data.sessions.filter(session => inScopeSessions.has(`${session.sourceId}\0${session.sessionId}`)).length,
    calls: calls.length,
    providers: [...new Set(calls.map(call => call.provider))].sort(),
  }
}

export function calculateLedgerMcpCalls(
  data: LedgerScope,
  input: LedgerMcpCallsInput,
  range: DateRange,
): LedgerMcpCall[] {
  const { calls, turns } = data
  const categoryByTurn = new Map<string, string>()
  for (const turn of turns) {
    categoryByTurn.set(`${turn.sourceId}\0${turn.sessionId}\0${turn.turnIndex}`, turn.category)
  }

  const limit = input.limit ?? 20
  return calls
    .filter(call => {
      if (!isWithinRange(call.timestamp, range)) return false
      if (input.model && call.resolvedModel !== input.model && call.model !== input.model) return false
      if (input.project && call.project !== input.project) return false
      if (
        input.category &&
        categoryByTurn.get(`${call.sourceId}\0${call.sessionId}\0${call.turnIndex}`) !== input.category
      ) {
        return false
      }
      if (input.tool && !call.tools.includes(input.tool)) return false
      return true
    })
    .sort((left, right) => (left.timestamp < right.timestamp ? 1 : left.timestamp > right.timestamp ? -1 : 0))
    .slice(0, limit)
    .map(call => ({
      timestamp: call.timestamp,
      provider: call.provider,
      model: call.resolvedModel,
      project: call.project ?? null,
      working_directory: call.workingDirectory ?? null,
      display_cost_usd: call.displayCostUSD,
      savings_usd: call.savingsUSD,
      estimated: call.isEstimated === 1,
      tokens: {
        input: call.inputTokens,
        output: call.outputTokens,
        cache_read: call.cacheReadInputTokens,
        cache_write: call.cacheCreationInputTokens,
        reasoning: call.reasoningTokens,
      },
      tools: call.tools,
      skills: call.skills,
      bash_commands: call.bashCommands,
      subagents: call.subagentTypes,
    }))
}
