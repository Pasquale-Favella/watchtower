import pc from 'picocolors'
import type { ProjectSummary } from './types.js'
import { formatCost } from './currency.js'

export { formatCost }

/**
 * Marker per costi stimati (~$0.05).
 */
export function markEstimated(costStr: string, isEstimated: boolean): string {
  return isEstimated ? `~${costStr}` : costStr
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '?'
  if (n < 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return Math.round(n).toString()
}

export function formatShortNumber(n: number): string {
  if (!Number.isFinite(n)) return '?'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return Math.round(n).toString()
}

export function formatMoney(n: number): string {
  return formatCost(n)
}

export function localDateString(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Aggregazione totali su tutta la finestra passata.
 */
export function aggregateTotals(projects: ProjectSummary[]) {
  let totalCost = 0
  let totalCalls = 0
  let totalInput = 0
  let totalOutput = 0
  let totalCacheRead = 0
  let totalCacheWrite = 0
  let totalReasoning = 0
  let totalSessions = 0
  let firstTs: string | undefined
  let lastTs: string | undefined

  for (const project of projects) {
    for (const session of project.sessions) {
      totalSessions += 1
      totalCost += session.totalCostUSD
      totalCalls += session.apiCalls
      totalInput += session.totalInputTokens
      totalOutput += session.totalOutputTokens
      totalCacheRead += session.totalCacheReadTokens
      totalCacheWrite += session.totalCacheWriteTokens
      totalReasoning += session.totalReasoningTokens
      if (!firstTs || session.firstTimestamp < firstTs) firstTs = session.firstTimestamp
      if (!lastTs || session.lastTimestamp > lastTs) lastTs = session.lastTimestamp
    }
  }

  return {
    totalCost,
    totalCalls,
    totalInput,
    totalOutput,
    totalCacheRead,
    totalCacheWrite,
    totalReasoning,
    totalSessions,
    totalProjects: projects.length,
    firstTs,
    lastTs,
  }
}

/**
 * Wrappers colorati basati su picocolors.
 */
export const color = {
  bold: (s: string) => pc.bold(s),
  dim: (s: string) => pc.dim(s),
  cost: (s: string) => pc.yellow(s),
  provider: (s: string) => pc.cyan(s),
  model: (s: string) => pc.magenta(s),
  ok: (s: string) => pc.green(s),
  warn: (s: string) => pc.yellow(s),
  err: (s: string) => pc.red(s),
  header: (s: string) => pc.bold(pc.underline(s)),
}
