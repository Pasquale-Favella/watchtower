import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'

import { querySpendView } from '../src/main/application/spend-query.js'
import { normalizeProjectPathKey } from '../src/main/pipeline/parser.js'
import {
  buildSessionRowsFromSnapshot,
  buildSessionSummariesFromSnapshot,
  groupSummariesIntoProjects,
} from '../src/main/store/aggregate-calculation.js'
import { LedgerIngest } from '../src/main/store/ledger-ports.js'
import { loadLedgerQuerySnapshotEffect } from '../src/main/store/ledger-query-snapshot.js'
import type { LedgerQuerySnapshot } from '../src/main/store/ledger-query-snapshot.js'
import type { SessionSummary } from '../src/main/pipeline/types.js'
import type { WorkerRuntime } from '../src/main/worker-runtime.js'
import type { SpendPayload } from '../src/shared/schemas/spend.js'
import type { PortInput } from '../src/shared/schemas/port.js'
import { buildFixtureCachedFile, buildFixtureCachedTurn } from './fixtures/cached-file.js'
import { atTime, openLedgerFixture, viewInputs } from './fixtures/ledger-runtime.js'

// Uniform project identity (#102/#105): ledger rows in, canonical project
// shells out. One checkout spelled four ways by four providers must form one
// project shell with summed cost; rows keep the canonical display label in
// session order; orphans and nested checkouts stay separate.

const NATIVE = process.platform === 'win32' ? 'C:/Users/tester/watchtower' : '/home/tester/watchtower'

const FULL_RANGE = { start: new Date('2026-06-02T00:00:00.000Z'), end: new Date('2026-08-01T00:00:00.000Z') }

function portIn(runtime: WorkerRuntime, input: PortInput): void {
  runtime.runSync(Effect.flatMap(LedgerIngest, ingest => ingest.portIn(input)))
}

function snapshot(runtime: WorkerRuntime): LedgerQuerySnapshot {
  const { catalogue, proxyPaths } = viewInputs({ period: 'lifetime' })
  return runtime.runSync(loadLedgerQuerySnapshotEffect({ catalogue, proxyPaths }))
}

function loadSummaries(runtime: WorkerRuntime): SessionSummary[] {
  return buildSessionSummariesFromSnapshot(snapshot(runtime), { range: FULL_RANGE })
}

function querySpend(runtime: WorkerRuntime): SpendPayload {
  const now = new Date('2026-08-01T00:00:00.000Z')
  return runtime.runSync(atTime(querySpendView(viewInputs({ period: 'lifetime' })), now))
}

function portSession(
  runtime: WorkerRuntime,
  opts: {
    provider: string
    sessionId: string
    filePath: string
    project: string
    costUSD: number
    workingDirectory?: string
    canonicalCwd?: string
  },
): void {
  const turn = buildFixtureCachedTurn(0, 'Do the thing', { sessionId: opts.sessionId })
  turn.calls[0]!.costUSD = opts.costUSD
  const file = buildFixtureCachedFile({
    turns: [turn],
    ...(opts.workingDirectory ? { workingDirectory: opts.workingDirectory } : {}),
    ...(opts.canonicalCwd ? { canonicalCwd: opts.canonicalCwd, canonicalProjectName: 'watchtower' } : {}),
  })
  if (!opts.canonicalCwd) {
    // The shared fixture defaults to Claude-style canonical attribution —
    // sessions without a known directory must carry none, or every orphan
    // would falsely unify under the fixture path and name.
    delete (file as { canonicalCwd?: string }).canonicalCwd
    delete (file as { canonicalProjectName?: string }).canonicalProjectName
  }
  portIn(runtime, {
    provider: opts.provider,
    envFingerprint: 'env-demo',
    filePath: opts.filePath,
    verdict: 'new',
    project: opts.project,
    ...(opts.workingDirectory ? { workingDirectory: opts.workingDirectory } : {}),
    cachedFile: file,
  })
}

function portCheckout(runtime: WorkerRuntime): void {
  portSession(runtime, {
    provider: 'opencode',
    sessionId: 'sess-a',
    filePath: '/tmp/tr-ident/opencode/sess-a.jsonl',
    project: 'C:-Users-tester-watchtower',
    costUSD: 0.1,
    workingDirectory: NATIVE,
  })
  portSession(runtime, {
    provider: 'codex',
    sessionId: 'sess-b',
    filePath: '/tmp/tr-ident/codex/sess-b.jsonl',
    project: 'Users-tester-watchtower',
    costUSD: 0.2,
    workingDirectory: NATIVE,
  })
  portSession(runtime, {
    provider: 'copilot',
    sessionId: 'sess-c',
    filePath: '/tmp/tr-ident/copilot/sess-c.jsonl',
    project: 'watchtower',
    costUSD: 0.3,
    workingDirectory: `${NATIVE}/`,
  })
  portSession(runtime, {
    provider: 'claude',
    sessionId: 'sess-d',
    filePath: '/tmp/tr-ident/claude/sess-d.jsonl',
    project: 'C--Users-tester-watchtower',
    costUSD: 0.4,
    canonicalCwd: NATIVE,
  })
}

describe('canonical project identity at the aggregation seam', () => {
  it('groups four spellings of one checkout into one shell with summed cost', () => {
    const { runtime } = openLedgerFixture()
    portCheckout(runtime)

    const summaries = loadSummaries(runtime)
    expect(summaries).toHaveLength(4)
    for (const summary of summaries) {
      expect(summary.projectKey).toBe(summaries[0]!.projectKey)
    }

    const shells = groupSummariesIntoProjects(summaries)
    expect(shells).toHaveLength(1)
    expect(shells[0]!.project).toBe('watchtower')
    expect(shells[0]!.projectPath).toBe(NATIVE)
    expect(shells[0]!.totalCostUSD).toBeCloseTo(1.0, 9)
    // No verbatim provider label survives on the aggregation path: all four
    // sessions sit in the one canonical shell.
    expect(shells[0]!.sessions).toHaveLength(4)
  })

  it('keeps session rows per-row with the canonical display label in session order', () => {
    const { runtime } = openLedgerFixture()
    portCheckout(runtime)

    const rows = buildSessionRowsFromSnapshot(snapshot(runtime), { range: FULL_RANGE })
    expect(rows.map(r => r.sessionId)).toEqual(['sess-a', 'sess-b', 'sess-c', 'sess-d'])
    for (const row of rows) expect(row.project).toBe('watchtower')
    expect(rows.reduce((sum, r) => sum + r.cost, 0)).toBeCloseTo(1.0, 9)
  })

  it('buckets directory-less sessions per provider instead of scattering or merging', () => {
    const { runtime } = openLedgerFixture()
    portSession(runtime, {
      provider: 'opencode',
      sessionId: 'sess-uuid-1',
      filePath: '/tmp/tr-ident/legacy/sess-uuid-1.jsonl',
      project: 'sess-uuid-1',
      costUSD: 0.5,
    })
    portSession(runtime, {
      provider: 'cursor',
      sessionId: 'composer-9',
      filePath: '/tmp/tr-ident/legacy/composer-9.jsonl',
      project: 'cursor',
      costUSD: 0.25,
    })

    const summaries = loadSummaries(runtime)
    expect(summaries).toHaveLength(2)
    expect(summaries[0]!.projectKey).toBe('orphan:cursor')
    expect(summaries[1]!.projectKey).toBe('orphan:opencode')

    const shells = groupSummariesIntoProjects(summaries)
    expect(shells).toHaveLength(2)
    expect(shells.map(s => s.project).sort()).toEqual(['orphan:cursor', 'orphan:opencode'])

    // Rows sit in the visible bucket too — no invented path, no scattering.
    const rows = buildSessionRowsFromSnapshot(snapshot(runtime), { range: FULL_RANGE })
    expect(rows.map(r => r.project).sort()).toEqual(['orphan:cursor', 'orphan:opencode'])
  })

  it('keeps nested checkouts as separate projects', () => {
    const { runtime } = openLedgerFixture()
    portCheckout(runtime)
    portSession(runtime, {
      provider: 'codex',
      sessionId: 'sess-nested',
      filePath: '/tmp/tr-ident/codex/sess-nested.jsonl',
      project: 'subrepo',
      costUSD: 0.5,
      workingDirectory: `${NATIVE}/nested-sub`,
    })

    const shells = groupSummariesIntoProjects(loadSummaries(runtime))
    expect(shells).toHaveLength(2)
    // Display derives from the canonical path leaf, not the legacy label.
    expect(shells.map(s => s.project).sort()).toEqual(['nested-sub', 'watchtower'])
  })

  it('keeps same-leaf checkouts as separate Projects/Spend buckets keyed by canonical path', () => {
    const { runtime } = openLedgerFixture()
    portSession(runtime, {
      provider: 'codex',
      sessionId: 'sess-src-a',
      filePath: '/tmp/tr-ident/same/a.jsonl',
      project: 'src',
      costUSD: 1,
      workingDirectory: '/a/src',
    })
    portSession(runtime, {
      provider: 'codex',
      sessionId: 'sess-src-b',
      filePath: '/tmp/tr-ident/same/b.jsonl',
      project: 'src',
      costUSD: 2,
      workingDirectory: '/b/src',
    })

    const summaries = loadSummaries(runtime)
    expect(summaries).toHaveLength(2)
    expect(summaries[0]!.projectKey).not.toBe(summaries[1]!.projectKey)
    // The leaf survives only as the display label.
    expect(summaries.map(s => s.project)).toEqual(['src', 'src'])

    const rows = buildSessionRowsFromSnapshot(snapshot(runtime), { range: FULL_RANGE })
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.project)).toEqual(['src', 'src'])
    expect(rows.map(r => r.cost).sort((a, b) => a - b)).toEqual([1, 2])

    const payload = querySpend(runtime)
    expect(payload.flow.projects).toHaveLength(2)
    expect(payload.flow.projects.map(p => p.label)).toEqual(['src', 'src'])
    expect(payload.flow.projects.map(p => p.id).sort()).toEqual(
      [normalizeProjectPathKey('/a/src'), normalizeProjectPathKey('/b/src')].sort(),
    )
  })

  it('shows one project with the summed cost in the Spend section', () => {
    const { runtime } = openLedgerFixture()
    portCheckout(runtime)

    const payload = querySpend(runtime)
    // Flow node ids are canonical keys (link-stable); labels keep the leaf.
    expect(payload.flow.projects.map(p => p.id)).toEqual([normalizeProjectPathKey(NATIVE)])
    expect(payload.flow.projects.map(p => p.label)).toEqual(['watchtower'])
    expect(payload.flow.projects[0]!.cost).toBeCloseTo(1.0, 9)
  })

  it('exports one canonical project shell for the mixed-provider checkout', () => {
    const { runtime } = openLedgerFixture()
    portCheckout(runtime)

    const projects = groupSummariesIntoProjects(loadSummaries(runtime))
    expect(projects).toHaveLength(1)
    expect(projects[0]!.project).toBe('watchtower')
    expect(projects[0]!.projectPath).toBe(NATIVE)
    expect(projects[0]!.totalCostUSD).toBeCloseTo(1.0, 9)
    expect(projects[0]!.sessions).toHaveLength(4)
  })

  it('keeps provider and period filters composing with canonical grouping', () => {
    const { runtime } = openLedgerFixture()
    portCheckout(runtime)

    const codexOnly = buildSessionSummariesFromSnapshot(snapshot(runtime), { range: FULL_RANGE, provider: 'codex' })
    expect(codexOnly.map(s => s.sessionId)).toEqual(['sess-b'])
    expect(codexOnly[0]!.project).toBe('watchtower')
  })

  it('unifies case variants on one key while display keeps its original case', () => {
    const { runtime } = openLedgerFixture()
    portSession(runtime, {
      provider: 'opencode',
      sessionId: 'sess-lower',
      filePath: '/tmp/tr-ident/case/sess-lower.jsonl',
      project: 'watchtower',
      costUSD: 0.5,
      workingDirectory: NATIVE,
    })
    portSession(runtime, {
      provider: 'codex',
      sessionId: 'sess-upper',
      filePath: '/tmp/tr-ident/case/sess-upper.jsonl',
      project: 'WATCHTOWER',
      costUSD: 0.5,
      workingDirectory: NATIVE.toUpperCase(),
    })

    const summaries = loadSummaries(runtime)
    expect(summaries).toHaveLength(2)
    expect(summaries[0]!.projectKey).toBe(summaries[1]!.projectKey)
    expect(groupSummariesIntoProjects(summaries)).toHaveLength(1)
  })

  it('folds a linked-worktree session into the main checkout shell', () => {
    const { runtime } = openLedgerFixture()
    portCheckout(runtime)
    portSession(runtime, {
      provider: 'claude',
      sessionId: 'sess-wt',
      filePath: '/tmp/tr-ident/claude/sess-wt.jsonl',
      project: 'watchtower-wt1',
      costUSD: 0.5,
      // Parse-time worktree folding already resolved the checkout to MAIN;
      // the exact worktree path rides along as the working directory.
      workingDirectory: `${NATIVE}-wt1`,
      canonicalCwd: NATIVE,
    })

    const summaries = loadSummaries(runtime)
    const wt = summaries.find(s => s.sessionId === 'sess-wt')!
    expect(wt.projectKey).toBe(summaries[0]!.projectKey)
    expect(wt.project).toBe('watchtower')
    // The exact worktree checkout stays visible on the session itself.
    expect(wt.workingDirectory).toBe(`${NATIVE}-wt1`)

    const shells = groupSummariesIntoProjects(summaries)
    expect(shells).toHaveLength(1)
    expect(shells[0]!.totalCostUSD).toBeCloseTo(1.5, 9)
  })
})
