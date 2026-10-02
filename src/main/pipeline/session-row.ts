import type { ProjectSummary, SessionSummary } from './types.js'

export type SessionRow = {
  sessionId: string
  title: string
  project: string
  provider: string
  models: string[]
  modelProvenance?: Record<string, string[]>
  cost: number
  savingsUSD: number
  calls: number
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  startedAt: string
  endedAt: string
  durationMs: number
}

export function inferProvider(session: SessionSummary): string {
  for (const turn of session.turns) {
    const provider = turn.assistantCalls[0]?.provider
    if (provider) return provider
  }
  const model = Object.keys(session.modelBreakdown)[0]?.toLowerCase() ?? ''
  if (model.startsWith('claude')) return 'claude'
  if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4'))
    return 'codex'
  if (model.startsWith('gemini')) return 'gemini'
  if (model.includes('/')) return model.split('/', 1)[0] || 'unknown'
  return 'unknown'
}

function durationMs(startedAt: string, endedAt: string): number {
  const duration = new Date(endedAt).getTime() - new Date(startedAt).getTime()
  return Number.isFinite(duration) ? duration : 0
}

export function sessionRowFromSummary(session: SessionSummary, project: string): SessionRow {
  const provenance: Record<string, string[]> = {}
  for (const [model, breakdown] of Object.entries(session.modelBreakdown)) {
    if (breakdown.sourceModels?.length) provenance[model] = [...breakdown.sourceModels].sort()
  }
  return {
    sessionId: session.sessionId,
    title: session.title ?? '',
    project: session.project || project,
    provider: inferProvider(session),
    models: Object.keys(session.modelBreakdown),
    ...(Object.keys(provenance).length > 0 ? { modelProvenance: provenance } : {}),
    cost: session.totalCostUSD,
    savingsUSD: session.totalSavingsUSD,
    calls: session.apiCalls,
    turns: session.turns.length,
    inputTokens: session.totalInputTokens,
    outputTokens: session.totalOutputTokens,
    cacheReadTokens: session.totalCacheReadTokens,
    cacheWriteTokens: session.totalCacheWriteTokens,
    startedAt: session.firstTimestamp,
    endedAt: session.lastTimestamp,
    durationMs: durationMs(session.firstTimestamp, session.lastTimestamp),
  }
}

export function aggregateSessionRows(projects: ProjectSummary[]): SessionRow[] {
  return projects.flatMap(project => project.sessions.map(session => sessionRowFromSummary(session, project.project)))
}
