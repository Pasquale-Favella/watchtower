import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'

import { queryYieldView } from '../src/main/application/yield-query.js'
import type { CachedCall, CachedFile } from '../src/main/pipeline/session-cache.js'
import { LedgerIngest } from '../src/main/store/ledger-ports.js'
import type { YieldPayload } from '../src/shared/schemas/yield.js'
import { buildFixtureCachedCall, buildFixtureCachedFile, buildFixtureCachedTurn } from './fixtures/cached-file.js'
import { atTime, openLedgerFixture, viewInputs } from './fixtures/ledger-runtime.js'

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

describe('queryYieldView (ADR 0008)', () => {
  it('returns a zeroed summary for an empty report', async () => {
    const { runtime } = openLedgerFixture()
    const payload = await yieldView(runtime, { period: 'lifetime' })
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

      const payload = await nativeYieldPayload([
        {
          sessionId: 'sess-prod',
          project: 'app',
          workingDirectory: repoDir,
          firstTimestamp: tightWindow.firstTimestamp,
          lastTimestamp: tightWindow.lastTimestamp,
          cost: 5,
        },
      ])

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

      const payload = await nativeYieldPayload([
        {
          sessionId: 'sess-rev',
          project: 'app',
          workingDirectory: repoDir,
          firstTimestamp: tightWindow.firstTimestamp,
          lastTimestamp: tightWindow.lastTimestamp,
          cost: 8,
        },
      ])

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

      const payload = await nativeYieldPayload([
        {
          sessionId: 'sess-rev-short',
          project: 'app',
          workingDirectory: repoDir,
          firstTimestamp: tightWindow.firstTimestamp,
          lastTimestamp: tightWindow.lastTimestamp,
          cost: 3,
        },
      ])

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

      const payload = await nativeYieldPayload([
        {
          sessionId: 'sess-aban',
          project: 'app',
          workingDirectory: repoDir,
          firstTimestamp: tightWindow.firstTimestamp,
          lastTimestamp: tightWindow.lastTimestamp,
          cost: 12,
        },
      ])

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

      const payload = await nativeYieldPayload([
        {
          sessionId: 'sess-tight',
          project: 'app',
          workingDirectory: repoDir,
          firstTimestamp: tightWindow.firstTimestamp,
          lastTimestamp: tightWindow.lastTimestamp,
          cost: 5,
        },
        {
          sessionId: 'sess-broad',
          project: 'app',
          workingDirectory: repoDir,
          firstTimestamp: broadWindow.firstTimestamp,
          lastTimestamp: broadWindow.lastTimestamp,
          cost: 3,
        },
      ])

      expect(payload.details.find(d => d.sessionId === 'sess-tight')).toMatchObject({
        category: 'productive',
        commitCount: 1,
      })
      expect(payload.details.find(d => d.sessionId === 'sess-broad')).toMatchObject({
        category: 'ambiguous',
        commitCount: 0,
      })
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
      for (const [dir, name] of [
        [repo1, 'one'],
        [repo2, 'two'],
      ] as const) {
        initRepo(dir)
        commitAt(dir, 'file.txt', `${name}\n`, `feat: ${name}`, '2026-01-01T10:30:00Z')
      }
      const payload = await nativeYieldPayload([
        {
          sessionId: 'r1',
          project: 'r1',
          workingDirectory: repo1,
          firstTimestamp: broadWindow.firstTimestamp,
          lastTimestamp: broadWindow.lastTimestamp,
          cost: 4,
        },
        {
          sessionId: 'r2',
          project: 'r2',
          workingDirectory: repo2,
          firstTimestamp: broadWindow.firstTimestamp,
          lastTimestamp: broadWindow.lastTimestamp,
          cost: 4,
        },
      ])

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

      const payload = await nativeYieldPayload([
        {
          sessionId: 'sub-a',
          project: 'pkg-a',
          workingDirectory: subA,
          firstTimestamp: tightWindow.firstTimestamp,
          lastTimestamp: tightWindow.lastTimestamp,
          cost: 5,
        },
        {
          sessionId: 'sub-b',
          project: 'pkg-b',
          workingDirectory: subB,
          firstTimestamp: broadWindow.firstTimestamp,
          lastTimestamp: broadWindow.lastTimestamp,
          cost: 3,
        },
      ])

      const productive = payload.details.filter(d => d.category === 'productive')
      expect(productive.map(d => d.sessionId)).toEqual(['sub-a'])
      expect(productive[0]!.commitCount).toBe(1)
      expect(payload.details.find(d => d.sessionId === 'sub-b')!.category).toBe('ambiguous')
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })
})

// ── Application Yield query ───────────────────────────────────────────────

const LEDGER_NOW = new Date('2026-07-15T12:00:00Z')

type YieldRuntime = ReturnType<typeof openLedgerFixture>['runtime']

type YieldSessionInput = {
  sessionId: string
  project: string
  workingDirectory: string
  firstTimestamp: string
  lastTimestamp: string
  cost: number
}

function yieldView(runtime: YieldRuntime, scope: Parameters<typeof viewInputs>[0]): Promise<YieldPayload> {
  return runtime.runPromise(atTime(queryYieldView(viewInputs(scope)), LEDGER_NOW))
}

async function nativeYieldPayload(sessions: YieldSessionInput[]): Promise<YieldPayload> {
  const { runtime } = openLedgerFixture()
  yieldPort(
    runtime,
    sessions.map((session, index) =>
      yieldCachedFile(index, {
        sessionId: session.sessionId,
        project: session.project,
        workingDirectory: session.workingDirectory,
        iso: session.firstTimestamp,
        lastIso: session.lastTimestamp,
        cost: session.cost,
      }),
    ),
  )
  return yieldView(runtime, { period: 'lifetime', range: RANGE })
}

function yieldCachedFile(
  index: number,
  opts: {
    sessionId: string
    project?: string
    workingDirectory?: string
    iso: string
    lastIso?: string
    cost?: number
  },
): CachedFile {
  const timestamps = opts.lastIso && opts.lastIso !== opts.iso ? [opts.iso, opts.lastIso] : [opts.iso]
  const turns = timestamps.map((timestamp, turnIndex) => {
    const call: CachedCall = {
      ...buildFixtureCachedCall(index + turnIndex),
      costUSD: (opts.cost ?? 1) / timestamps.length,
      timestamp,
    }
    return buildFixtureCachedTurn(index + turnIndex, `prompt ${index}-${turnIndex}`, {
      sessionId: opts.sessionId,
      timestamp,
      calls: [call],
    })
  })
  const file = buildFixtureCachedFile({
    canonicalProjectName: opts.project ?? 'app',
    title: '',
    turns,
    ...(opts.workingDirectory ? { workingDirectory: opts.workingDirectory } : {}),
  })
  // The shared fixture defaults to a Claude-style canonicalCwd that would
  // shadow the working directory under test; these fixtures never set one.
  delete (file as { canonicalCwd?: string }).canonicalCwd
  return file
}

function yieldPort(runtime: YieldRuntime, files: CachedFile[]): void {
  files.forEach((file, i) => {
    runtime.runSync(
      Effect.flatMap(LedgerIngest, ingest =>
        ingest.portIn({
          provider: 'claude',
          envFingerprint: 'env-demo',
          filePath: `/cache/claude/${file.turns[0]?.sessionId ?? `sess-${i}`}.jsonl`,
          verdict: 'new',
          cachedFile: file,
        }),
      ),
    )
  })
}

describe('queryYieldView', () => {
  it('returns a zeroed summary for an empty ledger', async () => {
    const { runtime } = openLedgerFixture()
    const payload = await yieldView(runtime, { period: 'lifetime' })
    expect(payload.summary.total).toEqual({ costUSD: 0, sessions: 0 })
    expect(payload.details).toEqual([])
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
      const { runtime } = openLedgerFixture()
      yieldPort(runtime, [file])
      const payload = await yieldView(runtime, {
        period: 'lifetime',
        range: { since: '2026-07-12', until: '2026-07-14' },
      })
      expect(payload.summary.productive).toMatchObject({ costUSD: 1, sessions: 1 })
      expect(payload.summary.abandoned.sessions).toBe(0)
      expect(payload.details[0]).toMatchObject({ sessionId: 'sess-yprod', category: 'productive', commitCount: 1 })
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  it('scopes to the selected date range and excludes out-of-range sessions', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'yield-ledger-range-'))
    try {
      initRepo(repoDir)
      commitAt(repoDir, 'file.txt', 'in\n', 'feat: in range', '2026-01-01T10:30:00Z')
      const { runtime } = openLedgerFixture()
      yieldPort(runtime, [
        yieldCachedFile(0, {
          sessionId: 'sess-in',
          workingDirectory: repoDir,
          iso: '2026-01-01T10:15:00.000Z',
          cost: 5,
        }),
        yieldCachedFile(1, {
          sessionId: 'sess-out',
          workingDirectory: repoDir,
          iso: '2026-02-01T10:15:00.000Z',
          cost: 7,
        }),
      ])
      const payload = await yieldView(runtime, { period: 'lifetime', range: RANGE })

      expect(payload.details).toHaveLength(1)
      expect(payload.details[0]!.sessionId).toBe('sess-in')
      expect(payload.summary.total).toMatchObject({ costUSD: 5, sessions: 1 })
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })
})
