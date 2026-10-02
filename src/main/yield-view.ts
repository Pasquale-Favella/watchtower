import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

import * as Schema from 'effect/Schema'

import {
  type YieldBucket,
  type YieldCategory,
  type YieldDetail,
  type YieldPayload,
  yieldPayloadSchema,
} from '../shared/schemas/yield.js'
import { groupSummariesIntoProjects, scopeDateRange } from './optimize-view.js'
import { overviewDateRange, type OverviewScope } from './overview.js'
import type { ProjectSummary, SessionSummary } from './pipeline/types.js'
import { buildSessionSummaries } from './store/aggregate.js'
import type { LedgerStore } from './store/ledger.js'

export type { YieldBucket, YieldCategory, YieldDetail, YieldPayload } from '../shared/schemas/yield.js'

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 5_000

/**
 * The Optimize section's Reverts/Abandoned-work tabs (ADR 0008). Yield is
 * computed ON DEMAND, query-time, via a live git spawn in the main process —
 * never persisted at scan time, because categorization is inherently
 * range-dependent. The same session slice as the Waste/Fixes payload
 * (`overviewDateRange`/`scopeDateRange`), then a window-correlation approach:
 * each project's working directory is resolved to its
 * canonical repository identity, commits in the window are correlated to
 * sessions by time window (tightest window wins), and reverts are detected
 * from `"This reverts commit <sha>"` bodies anywhere in history.
 *
 * There is no CLI `cwd` to fall back to, so
 * a project whose path is not (or no longer) a git work tree simply gets no
 * commits — its sessions read as abandoned/ambiguous, matching the
 * "no corresponding commit" rule. All git calls are time-boxed and fail
 * silently to an empty result.
 */

type CommitInfo = {
  sha: string
  timestamp: Date
  inMain: boolean
  /** Set when a LATER commit's body says "This reverts commit <sha>" — i.e.
   * the work in this commit was reverted out of main. */
  wasReverted: boolean
}

type SessionWindow = {
  start: Date
  end: Date
  sessionId: string
}

type SessionAttribution = {
  window: SessionWindow | null
  commits: CommitInfo[]
  lostCandidacy: boolean
}

function runGit(args: string[], cwd: string): Promise<string | null> {
  return execFileAsync('git', args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    encoding: 'utf-8',
  })
    .then(out => out.stdout.trim())
    .catch(() => null)
}

type RepoIdentity = {
  /** Canonical group key: the absolute git-common-dir (shared object store). */
  key: string
  /** A member directory to run `git log` from; --all spans the whole store. */
  gitDir: string
}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/** Resolve a directory to its canonical repository identity, or null when it
 * is not inside a git work tree. Keyed on `git-common-dir` so monorepo
 * subdirectories and linked worktrees of one repo collapse to one group.
 * Cached per directory. */
async function resolveRepoIdentity(dir: string, cache: Map<string, RepoIdentity | null>): Promise<RepoIdentity | null> {
  const cached = cache.get(dir)
  if (cached !== undefined) return cached

  let identity: RepoIdentity | null = null
  const out = await runGit(['rev-parse', '--is-inside-work-tree', '--git-common-dir'], dir)
  if (out) {
    const [insideWorkTree, commonDir] = out.split('\n')
    if (insideWorkTree === 'true' && commonDir) {
      identity = { key: canonicalPath(resolve(dir, commonDir)), gitDir: dir }
    }
  }
  cache.set(dir, identity)
  return identity
}

const SAFE_REF_PATTERN = /^[A-Za-z0-9._/-]+$/

async function getMainBranch(cwd: string): Promise<string> {
  const result = await runGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], cwd)
  if (result) {
    const branch = result.replace('refs/remotes/origin/', '')
    if (SAFE_REF_PATTERN.test(branch)) return branch
  }

  const branches = (await runGit(['branch', '-a'], cwd)) ?? ''
  if (branches.includes('main')) return 'main'
  if (branches.includes('master')) return 'master'
  return 'main'
}

/** Find SHAs that were the target of a `git revert` ANYWHERE in the repo's
 * history (not just the window). The standard revert body format is
 * "This reverts commit <SHA>." which we grep out. */
async function getRevertedShas(cwd: string): Promise<Set<string>> {
  const bodies = (await runGit(['log', '--all', '--grep=^This reverts commit', '--format=%B%x1e'], cwd)) ?? ''
  const set = new Set<string>()
  const re = /This reverts commit ([0-9a-f]{7,40})/g
  let m: RegExpExecArray | null
  while ((m = re.exec(bodies)) !== null) {
    set.add(m[1]!.toLowerCase())
  }
  return set
}

async function getCommitsInRange(cwd: string, since: Date, until: Date, mainBranch: string): Promise<CommitInfo[]> {
  const log = await runGit(
    ['log', '--all', `--since=${since.toISOString()}`, `--until=${until.toISOString()}`, '--format=%H|%aI|%s'],
    cwd,
  )
  if (!log) return []

  const mainCommits = new Set(
    ((await runGit(['log', mainBranch, '--format=%H'], cwd)) ?? '').split('\n').filter(Boolean),
  )
  const revertedShas = await getRevertedShas(cwd)

  return log
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [sha, timestamp] = line.split('|')
      return {
        sha: sha ?? '',
        timestamp: new Date(timestamp ?? ''),
        inMain: mainCommits.has(sha ?? ''),
        // Compare against the full SHA AND its 7-char short prefix to be safe;
        // git revert sometimes records the short form.
        wasReverted:
          revertedShas.has((sha ?? '').toLowerCase()) || revertedShas.has((sha ?? '').toLowerCase().slice(0, 7)),
      }
    })
}

function sessionWindow(session: SessionSummary): SessionWindow | null {
  if (!session.firstTimestamp) return null
  const start = new Date(session.firstTimestamp)
  const lastTs = session.lastTimestamp ?? session.firstTimestamp
  const end = new Date(new Date(lastTs).getTime() + 60 * 60 * 1000)
  return { start, end, sessionId: session.sessionId }
}

/** Award each commit to the session whose window contains it with the
 * tightest span (ties broken by earlier start, then sessionId). Windows that
 * merely overlap a commit a tighter window won lose candidacy. */
function attributeCommits(sessions: SessionSummary[], commits: CommitInfo[]): SessionAttribution[] {
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
      if (current === null) return candidate
      const currentSpan = current.window.end.getTime() - current.window.start.getTime()
      const candidateSpan = candidate.window.end.getTime() - candidate.window.start.getTime()
      if (candidateSpan !== currentSpan) return candidateSpan < currentSpan ? candidate : current
      if (candidate.window.start.getTime() !== current.window.start.getTime()) {
        return candidate.window.start < current.window.start ? candidate : current
      }
      return candidate.window.sessionId < current.window.sessionId ? candidate : current
    }, null)

    for (const candidate of candidates) {
      if (candidate !== owner) candidate.lostCandidacy = true
    }
    owner?.commits.push(commit)
  }

  return attributions
}

function categorizeSession(
  session: SessionSummary,
  commits: CommitInfo[],
  lostCandidacy: boolean,
): { category: YieldCategory; commitCount: number } {
  if (!session.firstTimestamp) {
    return { category: 'abandoned', commitCount: 0 }
  }

  if (commits.length === 0) {
    return {
      category: lostCandidacy ? 'ambiguous' : 'abandoned',
      commitCount: 0,
    }
  }

  const inMainCount = commits.filter(c => c.inMain).length
  // A session is "reverted" when at least half of its in-main commits were
  // later reverted out (revert detected via "This reverts commit <sha>"
  // anywhere later in history).
  const revertedCount = commits.filter(c => c.inMain && c.wasReverted).length

  if (revertedCount > 0 && revertedCount >= inMainCount / 2) {
    return { category: 'reverted', commitCount: commits.length }
  }
  if (inMainCount > 0) {
    return { category: 'productive', commitCount: inMainCount }
  }
  return { category: 'abandoned', commitCount: commits.length }
}

type RepoGroup = {
  commits: CommitInfo[]
  sessions: SessionSummary[]
  projectNames: string[]
}

async function buildRepoGroups(
  projects: ProjectSummary[],
  range: { start: Date; end: Date },
): Promise<Map<string, RepoGroup>> {
  const repoIdentityCache = new Map<string, RepoIdentity | null>()
  const repoGroups = new Map<string, RepoGroup>()

  for (const project of projects) {
    const identity = project.projectPath ? await resolveRepoIdentity(project.projectPath, repoIdentityCache) : null
    const groupKey = identity ? identity.key : project.projectPath

    let group = repoGroups.get(groupKey)
    if (!group) {
      group = {
        commits: identity
          ? await getCommitsInRange(identity.gitDir, range.start, range.end, await getMainBranch(identity.gitDir))
          : [],
        sessions: [],
        projectNames: [],
      }
      repoGroups.set(groupKey, group)
    }
    for (const session of project.sessions) {
      group.sessions.push(session)
      group.projectNames.push(project.project)
    }
  }

  return repoGroups
}

function emptyBucket(): YieldBucket {
  return { costUSD: 0, sessions: 0, costPercent: 0, sessionPercent: 0 }
}

/** The Optimize section's Reverts/Abandoned tabs payload (ADR 0008), computed
 * on demand via live git spawns against each project's working directory.
 * Uses the same window attribution and revert detection as the Waste/Fixes
 * findings, scoped exactly like them. The ledger-backed path
 * (`buildYieldViewFromLedger`) groups through `groupSummariesIntoProjects`
 * before this same core. */
export async function buildYieldPayload(
  projects: ProjectSummary[],
  scope: OverviewScope,
  opts: { now?: Date } = {},
): Promise<YieldPayload> {
  const now = opts.now ?? new Date()
  const dateRange = scopeDateRange(scope, now)
  const range = dateRange ?? { start: new Date(0), end: now }

  const summary = {
    productive: emptyBucket(),
    reverted: emptyBucket(),
    abandoned: emptyBucket(),
    ambiguous: emptyBucket(),
  }
  const details: YieldDetail[] = []
  let totalCost = 0
  let totalSessions = 0

  const repoGroups = await buildRepoGroups(projects, range)
  for (const group of repoGroups.values()) {
    const attributions = attributeCommits(group.sessions, group.commits)
    for (const [index, session] of group.sessions.entries()) {
      const attribution = attributions[index]!
      const { category, commitCount } = categorizeSession(session, attribution.commits, attribution.lostCandidacy)
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

  const pct = (value: number): number => (totalCost > 0 ? Math.round((value / totalCost) * 1000) / 10 : 0)
  const sessionPct = (value: number): number =>
    totalSessions > 0 ? Math.round((value / totalSessions) * 1000) / 10 : 0

  return {
    period: { start: range.start.toISOString(), end: range.end.toISOString() },
    summary: {
      productive: {
        ...summary.productive,
        costPercent: pct(summary.productive.costUSD),
        sessionPercent: sessionPct(summary.productive.sessions),
      },
      reverted: {
        ...summary.reverted,
        costPercent: pct(summary.reverted.costUSD),
        sessionPercent: sessionPct(summary.reverted.sessions),
      },
      abandoned: {
        ...summary.abandoned,
        costPercent: pct(summary.abandoned.costUSD),
        sessionPercent: sessionPct(summary.abandoned.sessions),
      },
      ambiguous: {
        ...summary.ambiguous,
        costPercent: pct(summary.ambiguous.costUSD),
        sessionPercent: sessionPct(summary.ambiguous.sessions),
      },
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

/**
 * Ledger-backed Yield payload (map 07): the aggregation seam applies the
 * scope's range/provider at the SQL read and groups through
 * `groupSummariesIntoProjects` (whose `projectPath` is the canonical checkout
 * path, so the git-backed categorization reads the real tree; orphan-bucket
 * sessions without any path read abandoned/ambiguous) before the same
 * `buildYieldPayload` core.
 */
export async function buildYieldViewFromLedger(
  store: LedgerStore,
  scope: OverviewScope,
  opts: { now?: Date } = {},
): Promise<YieldPayload> {
  const now = opts.now ?? new Date()
  const summaries = buildSessionSummaries(store, {
    range: overviewDateRange(scope, now),
    provider: scope.provider,
  })
  return Schema.decodeUnknownSync(yieldPayloadSchema)(
    await buildYieldPayload(groupSummariesIntoProjects(summaries), scope, opts),
  )
}
