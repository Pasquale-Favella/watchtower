import type { YieldBucket, YieldCategory, YieldDetail, YieldPayload } from '../shared/schemas/yield.js'
import type { CommitInfo, InspectionIssue } from './application/repository-inspection.js'
import type { ProjectSummary, SessionSummary } from './pipeline/types.js'

export type YieldRepoGroup = {
  readonly commits: readonly CommitInfo[]
  readonly sessions: readonly SessionSummary[]
  readonly projectNames: readonly string[]
  readonly inspected?: boolean
  readonly mainRef?: string | null
  readonly inspectionIssues?: readonly InspectionIssue[]
}

type SessionWindow = { start: Date; end: Date; key: string }
type SessionAttribution = { window: SessionWindow | null; commits: CommitInfo[]; lostCandidacy: boolean }

function detailKey(session: SessionSummary): string {
  return JSON.stringify([session.sourceId ?? session.workingDirectory ?? session.project, session.sessionId])
}

function sessionWindow(session: SessionSummary): SessionWindow | null {
  const start = new Date(session.firstTimestamp)
  const last = new Date(session.lastTimestamp || session.firstTimestamp)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(last.getTime()) || last < start) return null
  const end = new Date(last.getTime() + 60 * 60 * 1000)
  if (!Number.isFinite(end.getTime())) return null
  return { start, end, key: detailKey(session) }
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
    if (!Number.isFinite(commit.timestamp.getTime())) continue
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
      if (current.window.start.getTime() !== candidate.window.start.getTime())
        return candidate.window.start < current.window.start ? candidate : current
      return candidate.window.key < current.window.key ? candidate : current
    }, null)
    for (const candidate of candidates) if (candidate !== owner) candidate.lostCandidacy = true
    owner?.commits.push(commit)
  }
  return attributions
}

const explanations: Record<YieldDetail['reasonCode'], string> = {
  'main-commits-survive': 'Matched commits are present on the inspected main reference with no detected revert.',
  'main-commits-reverted': 'All matched main commits have a detected revert on the inspected main reference.',
  'main-commits-mixed': 'Matched main commits include both reverted and surviving commits.',
  'no-matched-commits':
    'No commit matched the session window. Research, delayed delivery and squash merges can remain unmatched.',
  'off-main-commits': 'Matched commits are outside the inspected main reference. They may still be pending delivery.',
  'overlapping-windows': 'A matching commit was assigned to another session with a tighter or earlier window.',
  'invalid-session-window': 'The recorded timestamps cannot define a valid attribution window.',
  'inspection-unavailable': 'Local repository evidence was unavailable, so the delivery outcome is unknown.',
  'membership-unavailable': 'Main membership or revert evidence was unavailable for matched commits.',
}

export function categorizeYieldSession(
  session: SessionSummary,
  commits: readonly CommitInfo[],
  lostCandidacy: boolean,
  inspected = true,
): { category: YieldCategory; commitCount: number; reasonCode: YieldDetail['reasonCode']; explanation: string } {
  const result = (category: YieldCategory, reasonCode: YieldDetail['reasonCode']) => ({
    category,
    commitCount: commits.length,
    reasonCode,
    explanation: explanations[reasonCode],
  })
  if (!sessionWindow(session)) return result('unknown', 'invalid-session-window')
  if (!inspected) return result('unknown', 'inspection-unavailable')
  if (commits.length === 0)
    return lostCandidacy ? result('ambiguous', 'overlapping-windows') : result('unmatched', 'no-matched-commits')
  if (commits.some(commit => commit.inMain === null || (commit.inMain && commit.wasReverted === null)))
    return result('unknown', 'membership-unavailable')
  const main = commits.filter(commit => commit.inMain)
  if (main.length === 0) return result('unmerged', 'off-main-commits')
  const reverted = main.filter(commit => commit.wasReverted).length
  if (reverted === main.length) return result('reverted', 'main-commits-reverted')
  if (reverted > 0) return result('mixed', 'main-commits-mixed')
  return result('productive', 'main-commits-survive')
}

function emptyBucket(): YieldBucket {
  return { costUSD: 0, sessions: 0, costPercent: 0, sessionPercent: 0 }
}

/** Bucket the selected spending once; attribution describes evidence, not economic loss. */
export function calculateYieldPayload(
  groups: Iterable<YieldRepoGroup>,
  range: { readonly start: Date; readonly end: Date },
  observedAt = range.end,
  evidenceRange = range,
): YieldPayload {
  const summary = {
    productive: emptyBucket(),
    reverted: emptyBucket(),
    mixed: emptyBucket(),
    unmatched: emptyBucket(),
    unmerged: emptyBucket(),
    ambiguous: emptyBucket(),
    unknown: emptyBucket(),
  }
  const details: YieldDetail[] = []
  let totalCost = 0
  let inspectedSessions = 0
  for (const group of groups) {
    const validCommits = group.commits.filter(
      commit =>
        commit.timestamp <= observedAt &&
        commit.timestamp >= evidenceRange.start &&
        commit.timestamp <= evidenceRange.end,
    )
    const attributions = attributeYieldCommits(group.sessions, validCommits)
    for (const [index, session] of group.sessions.entries()) {
      const attribution = attributions[index]
      if (!attribution) continue
      const inspected = group.inspected ?? true
      const result = categorizeYieldSession(
        session,
        attribution.commits,
        attribution.lostCandidacy,
        inspected && group.mainRef !== null,
      )
      if (inspected) inspectedSessions++
      totalCost += session.totalCostUSD
      summary[result.category].costUSD += session.totalCostUSD
      summary[result.category].sessions += 1
      const issues = [
        ...(group.inspectionIssues ?? []),
        ...attribution.commits.flatMap(commit => commit.inspectionIssues ?? []),
      ]
      details.push({
        key: detailKey(session),
        sourceId: session.sourceId ?? null,
        sessionId: session.sessionId,
        project: group.projectNames[index] ?? session.project,
        costUSD: session.totalCostUSD,
        ...result,
        mainRef: group.mainRef ?? null,
        window: {
          start: attribution.window?.start.toISOString() ?? null,
          end: attribution.window
            ? new Date(Math.min(attribution.window.end.getTime(), observedAt.getTime())).toISOString()
            : null,
        },
        inspectionIssues: [...new Map(issues.map(issue => [issue.operation, issue])).values()],
        commits: attribution.commits.map(commit => ({
          sha: commit.sha,
          timestamp: commit.timestamp.toISOString(),
          inMain: commit.inMain,
          wasReverted: commit.wasReverted,
        })),
      })
    }
  }
  for (const value of Object.values(summary)) {
    value.costPercent = totalCost > 0 ? Math.round((value.costUSD / totalCost) * 1000) / 10 : 0
    value.sessionPercent = details.length > 0 ? Math.round((value.sessions / details.length) * 1000) / 10 : 0
  }
  return {
    period: { start: range.start.toISOString(), end: range.end.toISOString() },
    summary: {
      ...summary,
      total: { costUSD: totalCost, sessions: details.length },
      productiveToRevertedCostRatio:
        summary.reverted.costUSD > 0
          ? Math.round((summary.productive.costUSD / summary.reverted.costUSD) * 100) / 100
          : null,
    },
    methodology: 'timestamp-window',
    costBasis: 'scoped-session-spend',
    observedAt: observedAt.toISOString(),
    coverage: {
      totalSessions: details.length,
      inspectedSessions,
      unknownSessions: summary.unknown.sessions,
      matchedSessions: details.filter(detail => detail.commitCount > 0).length,
    },
    attribution: {
      graceMinutes: 60,
      evidenceStart: evidenceRange.start.toISOString(),
      evidenceEnd: evidenceRange.end.toISOString(),
      historyScope: 'selected-sessions',
      limitations: [
        'Timestamp proximity using Git committer times is an attribution heuristic, not proof of authorship.',
        'Only sessions with spending in the selected Scope compete for commits.',
        'Squash, rebase, cherry-pick and later delivery can remain unmatched.',
        'Git references and revert messages are inspected locally without fetching.',
        'Revert evidence uses standard commit messages; custom messages and revert-of-revert outcomes require review.',
      ],
    },
    details,
  }
}

export function yieldProjectsToGroups(projects: readonly ProjectSummary[]): YieldRepoGroup[] {
  return projects.map(project => ({
    commits: [],
    sessions: project.sessions,
    projectNames: project.sessions.map(() => project.project),
    inspected: false,
    mainRef: null,
  }))
}
