import type { SessionDetail } from '../shared/schemas/views.js'
import { inferProvider } from './pipeline/session-row.js'
import { CATEGORY_LABELS, type SessionSummary } from './pipeline/types.js'

export function calculateSessionDetail(session: SessionSummary): SessionDetail {
  return {
    sessionId: session.sessionId,
    project: session.project,
    provider: inferProvider(session),
    title: session.title ?? '',
    workingDirectory: session.workingDirectory,
    firstTimestamp: session.firstTimestamp,
    lastTimestamp: session.lastTimestamp,
    totalCostUSD: session.totalCostUSD,
    totalEstimatedCostUSD: session.totalEstimatedCostUSD ?? 0,
    totalSavingsUSD: session.totalSavingsUSD,
    totalInputTokens: session.totalInputTokens,
    totalOutputTokens: session.totalOutputTokens,
    totalCacheReadTokens: session.totalCacheReadTokens,
    totalCacheWriteTokens: session.totalCacheWriteTokens,
    totalReasoningTokens: session.totalReasoningTokens,
    apiCalls: session.apiCalls,
    prLinks: session.prLinks ?? [],
    modelBreakdown: Object.fromEntries(
      Object.entries(session.modelBreakdown).map(([model, breakdown]) => [
        model,
        { calls: breakdown.calls, costUSD: breakdown.costUSD },
      ]),
    ),
    turns: session.turns.map(turn => ({
      timestamp: turn.timestamp,
      userMessage: turn.userMessage,
      category: CATEGORY_LABELS[turn.category] ?? turn.category,
      gitBranch: turn.gitBranch,
      prRefs: turn.prRefs ?? [],
      retries: turn.retries,
      hasEdits: turn.hasEdits,
      assistantCalls: turn.assistantCalls.map(call => ({
        provider: call.provider,
        model: call.model,
        costUSD: call.costUSD,
        isEstimated: call.isEstimated,
        savingsUSD: call.savingsUSD,
        speed: call.speed,
        hasPlanMode: call.hasPlanMode,
        tools: call.tools,
        mcpTools: call.mcpTools,
        skills: call.skills,
        subagentTypes: call.subagentTypes,
        usage: {
          inputTokens: call.usage.inputTokens,
          outputTokens: call.usage.outputTokens,
          reasoningTokens: call.usage.reasoningTokens,
          cacheReadInputTokens: call.usage.cacheReadInputTokens,
          cacheCreationInputTokens: call.usage.cacheCreationInputTokens,
        },
      })),
    })),
  }
}
