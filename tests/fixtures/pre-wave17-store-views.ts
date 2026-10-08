/**
 * Frozen legacy store-list/search/detail builders copied from
 * `git show 05d56de:src/main/views.ts` (issue #148 wave17 baseline).
 * This test-only reference remains until the new application query paths have
 * shipped. Keep the bodies and their legacy dependencies aligned with that
 * baseline; production code must not import this module.
 */
import * as Schema from 'effect/Schema'

import { sessionRowFromSummary } from '../../src/main/pipeline/sessions-report.js'
import type { SessionSummary } from '../../src/main/pipeline/types.js'
import { CATEGORY_LABELS } from '../../src/main/pipeline/types.js'
import {
  buildSessionRowsFromSnapshot,
  buildSessionSummariesFromSnapshot,
  sessionProjectKey,
} from '../../src/main/store/aggregate-calculation.js'
import type { LedgerStore } from '../../src/main/store/ledger.js'
import { type LedgerQuerySnapshot, loadLedgerQuerySnapshot } from '../../src/main/store/query-snapshot.js'
import {
  type ProjectRow,
  projectRowSchema,
  type SearchHit,
  searchHitSchema,
  type SessionDetail,
  sessionDetailSchema,
  type SessionRow,
  sessionRowSchema,
} from '../../src/shared/schemas/views.js'

/** All-time window used by the baseline builders. */
const ALL_TIME_RANGE = { start: new Date(-8640000000000000), end: new Date(8640000000000000) } as const

export function legacySearchSessionsFromLedger(store: LedgerStore, query: string): SearchHit[] {
  const term = query.trim().toLowerCase()
  if (!term) return []
  return Schema.decodeUnknownSync(Schema.mutable(Schema.Array(searchHitSchema)))(legacySearchSessionsCore(store, term))
}

function legacySearchSessionsCore(store: LedgerStore, term: string): SearchHit[] {
  const hits: SearchHit[] = []
  const seen = new Set<string>()
  const summaries = buildSessionSummariesFromSnapshot(loadLedgerQuerySnapshot(store), { range: ALL_TIME_RANGE })

  for (const session of summaries) {
    const provider = sessionRowFromSummary(session, session.project).provider
    const push = (kind: 'message' | 'bash', timestamp: string, snippet: string): void => {
      if (seen.has(session.sessionId) || hits.length >= 500) return
      seen.add(session.sessionId)
      hits.push({ sessionId: session.sessionId, project: session.project, provider, timestamp, kind, snippet })
    }
    for (const turn of session.turns) {
      if (turn.userMessage.toLowerCase().includes(term)) push('message', turn.timestamp, turn.userMessage)
      for (const call of turn.assistantCalls) {
        for (const cmd of call.bashCommands) {
          if (cmd.toLowerCase().includes(term)) push('bash', call.timestamp, cmd)
        }
      }
    }
  }
  return hits
}

export function legacyBuildProjectRowsFromLedger(store: LedgerStore): ProjectRow[] {
  const snapshot = loadLedgerQuerySnapshot(store)
  return Schema.decodeUnknownSync(Schema.mutable(Schema.Array(projectRowSchema)))(legacyBuildProjectRowsCore(snapshot))
}

function legacyBuildProjectRowsCore(snapshot: LedgerQuerySnapshot): ProjectRow[] {
  const summaries = buildSessionSummariesFromSnapshot(snapshot, { range: ALL_TIME_RANGE })
  const projectPathBySession = new Map<string, string>()
  for (const s of snapshot.sessions) {
    if (!projectPathBySession.has(s.sessionId)) projectPathBySession.set(s.sessionId, s.projectPath ?? '')
  }
  const byProject = new Map<string, ProjectRow>()
  for (const s of summaries) {
    const key = sessionProjectKey(s)
    let row = byProject.get(key)
    if (!row) {
      row = {
        project: s.project,
        projectPath: s.projectPath ?? projectPathBySession.get(s.sessionId) ?? '',
        cost: 0,
        calls: 0,
        sessions: 0,
        firstTimestamp: '',
        lastTimestamp: '',
      }
      byProject.set(key, row)
    }
    row.cost += s.totalCostUSD
    row.calls += s.apiCalls
    row.sessions += 1
    if (!row.firstTimestamp || s.firstTimestamp < row.firstTimestamp) row.firstTimestamp = s.firstTimestamp
    if (!row.lastTimestamp || s.lastTimestamp > row.lastTimestamp) row.lastTimestamp = s.lastTimestamp
    if (!row.repoUrl) row.repoUrl = s.repoUrl
  }
  return Array.from(byProject.values()).sort((a, b) => b.cost - a.cost)
}

export function legacyQuerySessionRowsFromLedger(
  store: LedgerStore,
  filter: { project?: string; since?: string; until?: string },
): SessionRow[] {
  const sinceMs = filter.since ? new Date(filter.since).getTime() : Number.NEGATIVE_INFINITY
  const untilMs = filter.until ? new Date(filter.until).getTime() : Number.POSITIVE_INFINITY
  const rows = buildSessionRowsFromSnapshot(loadLedgerQuerySnapshot(store), { range: ALL_TIME_RANGE })
    .filter(row => {
      if (filter.project && row.project !== filter.project) return false
      const start = new Date(row.startedAt).getTime()
      if (Number.isFinite(start) && start < sinceMs) return false
      if (Number.isFinite(start) && start > untilMs) return false
      return true
    })
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
  return Schema.decodeUnknownSync(Schema.mutable(Schema.Array(sessionRowSchema)))(rows)
}

function legacySessionDetailFromSummary(session: SessionSummary): SessionDetail {
  const provider = sessionRowFromSummary(session, session.project).provider
  return {
    sessionId: session.sessionId,
    project: session.project,
    provider,
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
      Object.entries(session.modelBreakdown).map(([model, b]) => [model, { calls: b.calls, costUSD: b.costUSD }]),
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

export function legacyGetSessionDetailFromLedger(store: LedgerStore, sessionId: string): SessionDetail | null {
  const summaries = buildSessionSummariesFromSnapshot(loadLedgerQuerySnapshot(store), { range: ALL_TIME_RANGE })
  const session = summaries.find(s => s.sessionId === sessionId)
  return session ? Schema.decodeUnknownSync(sessionDetailSchema)(legacySessionDetailFromSummary(session)) : null
}
