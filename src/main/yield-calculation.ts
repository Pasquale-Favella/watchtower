import type { YieldBucket, YieldCategory, YieldDetail, YieldPayload } from '../shared/schemas/yield.js'
import type { CommitInfo } from './application/repository-inspection.js'
import type { ProjectSummary, SessionSummary } from './pipeline/types.js'

export type YieldRepoGroup = {
  readonly commits: readonly CommitInfo[]
  readonly sessions: readonly SessionSummary[]
  readonly projectNames: readonly string[]
}

type SessionWindow = { start: Date; end: Date; sessionId: string }
type SessionAttribution = { window: SessionWindow | null; commits: CommitInfo[]; lostCandidacy: boolean }

function sessionWindow(session: SessionSummary): SessionWindow | null {
  if (!session.firstTimestamp) return null
  const start = new Date(session.firstTimestamp)
  const lastTimestamp = session.lastTimestamp || session.firstTimestamp
  const end = new Date(new Date(lastTimestamp).getTime() + 60 * 60 * 1000)
  return { start, end, sessionId: session.sessionId }
}

/** Award each commit to the tightest containing session window. */
export function attributeYieldCommits(
  sessions: readonly SessionSummary[],
  commits: readonly CommitInfo[],
): SessionAttribution[] {
  const attributions: SessionAttribution[] = sessions.map(session => ({
    window: sessionWindow(session),
    commits: [],
    lostCandidacy: false,
  }))

  for (const commit of commits) {
    const candidates = attributions.filter(
      (attribution): attribution is SessionAttribution & { window: SessionWindow } =>
        attribution.window !== null &&
        commit.timestamp >= attribution.window.start &&
        commit.timestamp <= attribution.window.end,
    )
    const owner = candidates.reduce<(SessionAttribution & { window: SessionWindow }) | null>((current, candidate) => {
      if (!current) return candidate
      const currentSpan = current.window.end.getTime() - current.window.start.getTime()
      const candidateSpan = candidate.window.end.getTime() - candidate.window.start.getTime()
      if (currentSpan !== candidateSpan) return candidateSpan < currentSpan ? candidate : current
      if (current.window.start.getTime() !== candidate.window.start.getTime()) {
        return candidate.window.start < current.window.start ? candidate : current
      }
      return candidate.window.sessionId < current.window.sessionId ? candidate : current
    }, null)

    for (const candidate of candidates) if (candidate !== owner) candidate.lostCandidacy = true
    owner?.commits.push(commit)
  }
  return attributions
}

export function categorizeYieldSession(
  session: SessionSummary,
  commits: readonly CommitInfo[],
  lostCandidacy: boolean,
): { category: YieldCategory; commitCount: number } {
  if (!session.firstTimestamp) return { category: 'abandoned', commitCount: 0 }
  if (commits.length === 0) return { category: lostCandidacy ? 'ambiguous' : 'abandoned', commitCount: 0 }

  const inMainCount = commits.filter(commit => commit.inMain).length
  const revertedCount = commits.filter(commit => commit.inMain && commit.wasReverted).length
  if (revertedCount > 0 && revertedCount >= inMainCount / 2) {
    return { category: 'reverted', commitCount: commits.length }
  }
  if (inMainCount > 0) return { category: 'productive', commitCount: inMainCount }
  return { category: 'abandoned', commitCount: commits.length }
}

function emptyBucket(): YieldBucket {
  return { costUSD: 0, sessions: 0, costPercent: 0, sessionPercent: 0 }
}

/** Pure timestamp-window attribution and yield payload calculation. */
export function calculateYieldPayload(
  groups: Iterable<YieldRepoGroup>,
  range: { readonly start: Date; readonly end: Date },
): YieldPayload {
  const summary = {
    productive: emptyBucket(),
    reverted: emptyBucket(),
    abandoned: emptyBucket(),
    ambiguous: emptyBucket(),
  }
  const details: YieldDetail[] = []
  let totalCost = 0
  let totalSessions = 0

  for (const group of groups) {
    const attributions = attributeYieldCommits(group.sessions, group.commits)
    for (const [index, session] of group.sessions.entries()) {
      const attribution = attributions[index]
      if (!attribution) continue
      const { category, commitCount } = categorizeYieldSession(session, attribution.commits, attribution.lostCandidacy)
      totalCost += session.totalCostUSD
      totalSessions += 1
      summary[category].costUSD += session.totalCostUSD
      summary[category].sessions += 1
      details.push({
        sessionId: session.sessionId,
        project: group.projectNames[index] ?? session.project,
        costUSD: session.totalCostUSD,
        category,
        commitCount,
      })
    }
  }

  const costPercent = (value: number): number => (totalCost > 0 ? Math.round((value / totalCost) * 1000) / 10 : 0)
  const sessionPercent = (value: number): number =>
    totalSessions > 0 ? Math.round((value / totalSessions) * 1000) / 10 : 0
  const bucket = (value: YieldBucket): YieldBucket => ({
    ...value,
    costPercent: costPercent(value.costUSD),
    sessionPercent: sessionPercent(value.sessions),
  })

  return {
    period: { start: range.start.toISOString(), end: range.end.toISOString() },
    summary: {
      productive: bucket(summary.productive),
      reverted: bucket(summary.reverted),
      abandoned: bucket(summary.abandoned),
      ambiguous: bucket(summary.ambiguous),
      total: { costUSD: totalCost, sessions: totalSessions },
      productiveToRevertedCostRatio:
        summary.reverted.costUSD > 0
          ? Math.round((summary.productive.costUSD / summary.reverted.costUSD) * 100) / 100
          : null,
    },
    methodology: 'timestamp-window',
    details,
  }
}

/** Preserve the project shells needed by legacy builder callers. */
export function yieldProjectsToGroups(projects: readonly ProjectSummary[]): YieldRepoGroup[] {
  return projects.map(project => ({
    commits: [],
    sessions: project.sessions,
    projectNames: project.sessions.map(() => project.project),
  }))
}
