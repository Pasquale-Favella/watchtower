import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { SessionSummary } from '../src/main/pipeline/types.js'
import type { CachedCall, CachedFile } from '../src/main/pipeline/session-cache.js'
import { LedgerStore } from '../src/main/store/ledger.js'
import { buildYieldPayload, buildYieldViewFromLedger } from '../src/main/yield-view.js'
import { buildFixtureCachedFile, buildFixtureCachedTurn, buildFixtureCachedCall } from './fixtures/cached-file.js'

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  }).trim()
}

function initRepo(dir: string): void {
  git(dir, ['init', '-b', 'main'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
}

/** Writes a file then commits it on main with an explicit UTC timestamp. */
function commitAt(dir: string, file: string, content: string, message: string, iso: string): void {
  writeFileSync(join(dir, file), content)
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', message], {
    GIT_AUTHOR_DATE: iso,
    GIT_COMMITTER_DATE: iso,
  })
}

/** Commits a revert whose body carries the standard "This reverts commit <sha>" line. */
function revertAt(dir: string, file: string, content: string, revertedSha: string, iso: string): void {
  writeFileSync(join(dir, file), content)
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', 'Revert feature', '-m', `This reverts commit ${revertedSha}.`], {
    GIT_AUTHOR_DATE: iso,
    GIT_COMMITTER_DATE: iso,
  })
}

function makeSession(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    sessionId: 'sess',
    project: 'app',
    firstTimestamp: '2026-01-01T10:15:00.000Z',
    lastTimestamp: '2026-01-01T10:45:00.000Z',
    totalCostUSD: 1,
    totalSavingsUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalReasoningTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: 1,
    turns: [],
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {} as SessionSummary['categoryBreakdown'],
    skillBreakdown: {},
    subagentBreakdown: {},
    ...overrides,
  }
}

const RANGE = { since: '2026-01-01', until: '2026-01-02' }

// Tighter window (span 1.5h): 10:15 -> 10:45 (+1h = 11:45). Wins any shared commit.
const tightWindow = {
  firstTimestamp: '2026-01-01T10:15:00.000Z',
  lastTimestamp: '2026-01-01T10:45:00.000Z',
}
// Broader window (span 2h): 10:00 -> 11:00 (+1h = 12:00). Loses the shared commit.
const broadWindow = {
  firstTimestamp: '2026-01-01T10:00:00.000Z',
  lastTimestamp: '2026-01-01T11:00:00.000Z',
}

describe('buildYieldPayload (ticket 29)', () => {
  it('returns a zeroed summary for an empty report', async () => {
    const payload = await buildYieldPayload([], { period: 'lifetime' })
    expect(payload.summary.total).toEqual({ costUSD: 0, sessions: 0 })
    for (const bucket of ['productive', 'reverted', 'abandoned', 'ambiguous'] as const) {
      expect(payload.summary[bucket]).toEqual({ costUSD: 0, sessions: 0, costPercent: 0, sessionPercent: 0 })
    }
    expect(payload.details).toEqual([])
    expect(payload.methodology).toBe('timestamp-window')
  })

  it('classifies a session whose window contains a main commit as productive', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'yield-productive-'))
    try {
      initRepo(repoDir)
      commitAt(repoDir, 'file.txt', 'hello\n', 'feat: shipped', '2026-01-01T10:30:00Z')

      const session = makeSession({ sessionId: 'sess-prod', project: 'app', ...tightWindow, totalCostUSD: 5 })
      const payload = await buildYieldPayload([{ project: 'app', projectPath: repoDir, sessions: [session], totalCostUSD: 5, totalSavingsUSD: 0, totalEstimatedCostUSD: 0, totalApiCalls: 1, totalProxiedCostUSD: 0 }],
        { period: 'lifetime', range: RANGE },
      )

      expect(payload.summary.productive).toMatchObject({ costUSD: 5, sessions: 1 })
      expect(payload.summary.abandoned.sessions).toBe(0)
      expect(payload.details[0]).toMatchObject({ sessionId: 'sess-prod', category: 'productive', commitCount: 1 })
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  it('flags a session as reverted when a later commit body says "This reverts commit <sha>"', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'yield-revert-'))
    try {
      initRepo(repoDir)
      commitAt(repoDir, 'file.txt', 'feature\n', 'feat: shipped', '2026-01-01T10:30:00Z')
      const featureSha = git(repoDir, ['rev-parse', 'HEAD'])
      revertAt(repoDir, 'file.txt', 'original\n', featureSha, '2026-01-01T11:00:00Z')

      const session = makeSession({ sessionId: 'sess-rev', project: 'app', ...tightWindow, totalCostUSD: 8 })
      const payload = await buildYieldPayload([{ project: 'app', projectPath: repoDir, sessions: [session], totalCostUSD: 8, totalSavingsUSD: 0, totalEstimatedCostUSD: 0, totalApiCalls: 1, totalProxiedCostUSD: 0 }],
        { period: 'lifetime', range: RANGE },
      )

      expect(payload.summary.reverted).toMatchObject({ costUSD: 8, sessions: 1 })
      expect(payload.details[0]).toMatchObject({ sessionId: 'sess-rev', category: 'reverted' })
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  it('matches the 7-char short SHA form in a revert body', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'yield-revert-short-'))
    try {
      initRepo(repoDir)
      commitAt(repoDir, 'file.txt', 'feature\n', 'feat: shipped', '2026-01-01T10:30:00Z')
      const shortSha = git(repoDir, ['rev-parse', '--short=7', 'HEAD'])
      revertAt(repoDir, 'file.txt', 'original\n', shortSha, '2026-01-01T11:00:00Z')

      const session = makeSession({ sessionId: 'sess-rev-short', project: 'app', ...tightWindow, totalCostUSD: 3 })
      const payload = await buildYieldPayload([{ project: 'app', projectPath: repoDir, sessions: [session], totalCostUSD: 3, totalSavingsUSD: 0, totalEstimatedCostUSD: 0, totalApiCalls: 1, totalProxiedCostUSD: 0 }],
        { period: 'lifetime', range: RANGE },
      )

      expect(payload.details[0]).toMatchObject({ sessionId: 'sess-rev-short', category: 'reverted' })
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  it('classifies a session with no commits in its window as abandoned', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'yield-abandon-'))
    try {
      initRepo(repoDir)
      commitAt(repoDir, 'file.txt', 'hello\n', 'feat: unrelated', '2026-01-01T16:00:00Z')

      const session = makeSession({ sessionId: 'sess-aban', project: 'app', ...tightWindow, totalCostUSD: 12 })
      const payload = await buildYieldPayload([{ project: 'app', projectPath: repoDir, sessions: [session], totalCostUSD: 12, totalSavingsUSD: 0, totalEstimatedCostUSD: 0, totalApiCalls: 1, totalProxiedCostUSD: 0 }],
        { period: 'lifetime', range: RANGE },
      )

      expect(payload.summary.abandoned).toMatchObject({ costUSD: 12, sessions: 1 })
      expect(payload.details[0]).toMatchObject({ sessionId: 'sess-aban', category: 'abandoned', commitCount: 0 })
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  it('awards a shared commit to the tightest window; the loser is ambiguous, never productive', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'yield-overlap-'))
    try {
      initRepo(repoDir)
      commitAt(repoDir, 'file.txt', 'hello\n', 'feat: shipped', '2026-01-01T10:30:00Z')

      const winner = makeSession({ sessionId: 'sess-tight', project: 'app', ...tightWindow, totalCostUSD: 5 })
      const loser = makeSession({ sessionId: 'sess-broad', project: 'app', ...broadWindow, totalCostUSD: 3 })
      const payload = await buildYieldPayload([{ project: 'app', projectPath: repoDir, sessions: [loser, winner], totalCostUSD: 8, totalSavingsUSD: 0, totalEstimatedCostUSD: 0, totalApiCalls: 2, totalProxiedCostUSD: 0 }],
        { period: 'lifetime', range: RANGE },
      )

      expect(payload.details.find(d => d.sessionId === 'sess-tight')).toMatchObject({ category: 'productive', commitCount: 1 })
      expect(payload.details.find(d => d.sessionId === 'sess-broad')).toMatchObject({ category: 'ambiguous', commitCount: 0 })
      expect(payload.summary.productive.sessions).toBe(1)
      expect(payload.summary.ambiguous).toMatchObject({ costUSD: 3, sessions: 1 })
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  it('keeps two distinct repos as independent groups', async () => {
    const repo1 = await mkdtemp(join(tmpdir(), 'yield-sep1-'))
    const repo2 = await mkdtemp(join(tmpdir(), 'yield-sep2-'))
    try {
      for (const [dir, name] of [[repo1, 'one'], [repo2, 'two']] as const) {
        initRepo(dir)
        commitAt(dir, 'file.txt', `${name}\n`, `feat: ${name}`, '2026-01-01T10:30:00Z')
      }
      const session1 = makeSession({ sessionId: 'r1', project: 'r1', ...broadWindow, totalCostUSD: 4 })
      const session2 = makeSession({ sessionId: 'r2', project: 'r2', ...broadWindow, totalCostUSD: 4 })
      const payload = await buildYieldPayload([
          { project: 'r1', projectPath: repo1, sessions: [session1], totalCostUSD: 4, totalSavingsUSD: 0, totalEstimatedCostUSD: 0, totalApiCalls: 1, totalProxiedCostUSD: 0 },
          { project: 'r2', projectPath: repo2, sessions: [session2], totalCostUSD: 4, totalSavingsUSD: 0, totalEstimatedCostUSD: 0, totalApiCalls: 1, totalProxiedCostUSD: 0 },
        ],
        { period: 'lifetime', range: RANGE },
      )

      const productive = payload.details.filter(d => d.category === 'productive')
      expect(productive.map(d => d.sessionId).sort()).toEqual(['r1', 'r2'])
      expect(payload.summary.ambiguous.sessions).toBe(0)
    } finally {
      await rm(repo1, { recursive: true, force: true })
      await rm(repo2, { recursive: true, force: true })
    }
  })

  it('collapses monorepo subdirectories of one repo into a single group', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'yield-mono-'))
    try {
      initRepo(repoDir)
      commitAt(repoDir, 'file.txt', 'hello\n', 'feat: shipped once', '2026-01-01T10:30:00Z')
      const subA = join(repoDir, 'packages', 'a')
      const subB = join(repoDir, 'packages', 'b')
      await mkdir(subA, { recursive: true })
      await mkdir(subB, { recursive: true })

      const sessionA = makeSession({ sessionId: 'sub-a', project: 'pkg-a', ...tightWindow, totalCostUSD: 5 })
      const sessionB = makeSession({ sessionId: 'sub-b', project: 'pkg-b', ...broadWindow, totalCostUSD: 3 })
      const payload = await buildYieldPayload([
          { project: 'pkg-a', projectPath: subA, sessions: [sessionA], totalCostUSD: 5, totalSavingsUSD: 0, totalEstimatedCostUSD: 0, totalApiCalls: 1, totalProxiedCostUSD: 0 },
          { project: 'pkg-b', projectPath: subB, sessions: [sessionB], totalCostUSD: 3, totalSavingsUSD: 0, totalEstimatedCostUSD: 0, totalApiCalls: 1, totalProxiedCostUSD: 0 },
        ],
        { period: 'lifetime', range: RANGE },
      )

      const productive = payload.details.filter(d => d.category === 'productive')
      expect(productive.map(d => d.sessionId)).toEqual(['sub-a'])
      expect(productive[0]!.commitCount).toBe(1)
      expect(payload.details.find(d => d.sessionId === 'sub-b')!.category).toBe('ambiguous')
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })
})

// ── Ledger-backed Yield view (map 07) ─────────────────────────────────────

const LEDGER_NOW = new Date('2026-07-15T12:00:00Z')

function yieldMakeLedger(): LedgerStore {
  return new LedgerStore(join(mkdtempSync(join(tmpdir(), 'tr-yld-')), 'data.db'))
}

function yieldCachedFile(index: number, opts: {
  sessionId: string
  project?: string
  workingDirectory?: string
  iso: string
  cost?: number
}): CachedFile {
  const call: CachedCall = {
    ...buildFixtureCachedCall(index),
    costUSD: opts.cost ?? 1,
    timestamp: opts.iso,
  }
  const turn = buildFixtureCachedTurn(index, `prompt ${index}`, {
    sessionId: opts.sessionId,
    timestamp: opts.iso,
    calls: [call],
  })
  return buildFixtureCachedFile({
    canonicalProjectName: opts.project ?? 'app',
    title: '',
    turns: [turn],
    ...(opts.workingDirectory ? { workingDirectory: opts.workingDirectory } : {}),
  })
}

function yieldPort(store: LedgerStore, files: CachedFile[]): void {
  files.forEach((file, i) => {
    store.portIn({
      provider: 'claude',
      envFingerprint: 'env-demo',
      filePath: `/cache/claude/${file.turns[0]?.sessionId ?? `sess-${i}`}.jsonl`,
      verdict: 'new',
      cachedFile: file,
    })
  })
}

describe('buildYieldViewFromLedger (aggregation seam scope)', () => {
  it('returns a zeroed summary for an empty ledger', async () => {
    const store = yieldMakeLedger()
    const payload = await buildYieldViewFromLedger(store, { period: 'lifetime' }, { now: LEDGER_NOW })
    expect(payload.summary.total).toEqual({ costUSD: 0, sessions: 0 })
    expect(payload.details).toEqual([])
    store.close()
  })

  it('classifies a ledger session as productive via its workingDirectory work tree', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'yield-ledger-prod-'))
    try {
      initRepo(repoDir)
      commitAt(repoDir, 'file.txt', 'hello\n', 'feat: shipped', '2026-07-13T10:30:00Z')
      const file = yieldCachedFile(0, {
        sessionId: 'sess-yprod',
        project: 'app',
        workingDirectory: repoDir,
        iso: '2026-07-13T10:15:00.000Z',
      })
      const store = yieldMakeLedger()
      yieldPort(store, [file])
      const payload = await buildYieldViewFromLedger(
        store,
        { period: 'lifetime', range: { since: '2026-07-12', until: '2026-07-14' } },
        { now: LEDGER_NOW },
      )
      expect(payload.summary.productive).toMatchObject({ costUSD: 1, sessions: 1 })
      expect(payload.summary.abandoned.sessions).toBe(0)
      expect(payload.details[0]).toMatchObject({ sessionId: 'sess-yprod', category: 'productive', commitCount: 1 })
      store.close()
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  it('scopes to the selected date range and excludes out-of-range sessions', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'yield-ledger-range-'))
    try {
      initRepo(repoDir)
      commitAt(repoDir, 'file.txt', 'in\n', 'feat: in range', '2026-01-01T10:30:00Z')
      const store = yieldMakeLedger()
      yieldPort(store, [
        yieldCachedFile(0, { sessionId: 'sess-in', workingDirectory: repoDir, iso: '2026-01-01T10:15:00.000Z', cost: 5 }),
        yieldCachedFile(1, { sessionId: 'sess-out', workingDirectory: repoDir, iso: '2026-02-01T10:15:00.000Z', cost: 7 }),
      ])
      const payload = await buildYieldViewFromLedger(
        store,
        { period: 'lifetime', range: RANGE },
        { now: LEDGER_NOW },
      )

      expect(payload.details).toHaveLength(1)
      expect(payload.details[0]!.sessionId).toBe('sess-in')
      expect(payload.summary.total).toMatchObject({ costUSD: 5, sessions: 1 })
      store.close()
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })
})
