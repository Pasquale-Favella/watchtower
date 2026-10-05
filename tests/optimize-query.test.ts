import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as TestClock from 'effect/testing/TestClock'
import { afterEach, describe, expect, it } from 'vitest'

import { AssistantSetup } from '../src/main/application/assistant-setup.js'
import { queryOptimizeView } from '../src/main/application/optimize-query.js'
import { PricingDiagnostics } from '../src/main/application/pricing-diagnostics.js'
import { capturePricingCatalogue } from '../src/main/pipeline/pricing-calculation.js'
import { LedgerStore } from '../src/main/store/ledger.js'
import { LedgerQueries } from '../src/main/store/ledger-ports.js'
import { buildFixtureCachedCall, buildFixtureCachedFile, buildFixtureCachedTurn } from './fixtures/cached-file.js'

const directories: string[] = []
const stores: LedgerStore[] = []
const catalogue = capturePricingCatalogue({
  prices: new Map(),
  overrides: new Map(),
  builtinAliases: {},
  userAliases: {},
  tiers: [],
  routedSegments: new Set(),
})
const input = { scope: { period: 'lifetime' as const }, catalogue, proxyPaths: { paths: [], caseSensitive: false } }

function makeStore(): LedgerStore {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-optimize-query-'))
  directories.push(directory)
  const store = new LedgerStore(join(directory, 'ledger.db'))
  stores.push(store)
  return store
}

afterEach(() => {
  try {
    let closeFailure: unknown
    for (const store of stores.splice(0)) {
      try {
        store.close()
      } catch (error) {
        closeFailure ??= error
      }
    }
    if (closeFailure !== undefined) throw closeFailure
  } finally {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  }
})

describe('queryOptimizeView', () => {
  it('captures the clock before loading one snapshot and skips filesystem setup for an empty result', async () => {
    const store = makeStore()
    const reports: string[][] = []
    let setupCalls = 0
    let snapshotReads = 0
    const capturedInstant = new Date(2026, 6, 2, 12).getTime()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(capturedInstant)
        const actual = yield* LedgerQueries
        const queries = LedgerQueries.of({
          ...actual,
          getRequestSnapshotData: () =>
            Effect.sync(() => snapshotReads++).pipe(
              Effect.flatMap(() => actual.getRequestSnapshotData()),
              Effect.tap(() => TestClock.adjust('24 hours')),
            ),
        })
        return yield* queryOptimizeView({ ...input, scope: { period: 'today' }, homeDir: 'unused' }).pipe(
          Effect.provideService(LedgerQueries, queries),
          Effect.provideService(
            AssistantSetup,
            AssistantSetup.of({
              getOptimizeSetup: () =>
                Effect.sync(() => {
                  setupCalls++
                  throw new Error('empty query read setup')
                }),
              getSkillInventory: () => Effect.succeed([]),
            }),
          ),
          Effect.provideService(
            PricingDiagnostics,
            PricingDiagnostics.of({
              reportUnpricedModels: models => Effect.sync(() => reports.push([...models])),
            }),
          ),
        )
      }).pipe(Effect.provide(store.portsLayer), Effect.provide(TestClock.layer())),
    )

    expect(result.findings).toEqual([])
    expect(new Date(result.period.start ?? '').getDate()).toBe(2)
    expect(result.period.end).toBe(new Date(capturedInstant).toISOString())
    expect(snapshotReads).toBe(1)
    expect(setupCalls).toBe(0)
    expect(reports).toEqual([[]])
  })

  it('loads Optimize setup once for nonempty project data and validates the result', async () => {
    const store = makeStore()
    for (const index of [0, 1]) {
      store.portIn({
        provider: 'claude',
        envFingerprint: 'optimize-query',
        filePath: `/cache/optimize-query-${index}.jsonl`,
        verdict: 'new',
        cachedFile: buildFixtureCachedFile({
          turns: [
            buildFixtureCachedTurn(index, 'inspect generated files', {
              sessionId: `claude-session-${index}`,
              calls: [
                {
                  ...buildFixtureCachedCall(index),
                  provider: 'claude',
                  tools: ['mcp__filesystem__list'],
                  toolSequence: [
                    [
                      { tool: 'Read', file: 'C:\\workspace\\node_modules\\generated.ts' },
                      { tool: 'Read', file: 'C:\\workspace\\node_modules\\generated.ts' },
                      { tool: 'Read', file: 'C:\\workspace\\node_modules\\generated.ts' },
                      { tool: 'mcp__filesystem__list' },
                    ],
                  ],
                },
              ],
            }),
          ],
        }),
      })
    }
    const setups: Array<{ directories: readonly string[]; home?: string }> = []
    const reports: string[][] = []
    const result = await Effect.runPromise(
      queryOptimizeView({ ...input, homeDir: '/test-home' }).pipe(
        Effect.provide(store.portsLayer),
        Effect.provideService(
          AssistantSetup,
          AssistantSetup.of({
            getOptimizeSetup: (directories, home) =>
              Effect.sync(() => {
                setups.push({ directories, home })
                return {
                  home: home ?? '',
                  mcpConfigs: new Map([
                    ['filesystem', { normalized: 'filesystem', original: 'filesystem', mtime: 1, alwaysLoadPaths: [] }],
                  ]),
                  envSettings: new Map(),
                  agents: ['unused-agent'],
                  skills: [],
                  commands: [],
                }
              }),
            getSkillInventory: () => Effect.succeed([]),
          }),
        ),
        Effect.provideService(
          PricingDiagnostics,
          PricingDiagnostics.of({
            reportUnpricedModels: models => Effect.sync(() => reports.push([...models])),
          }),
        ),
      ),
    )
    expect(setups).toHaveLength(1)
    expect(setups[0]?.home).toBe('/test-home')
    expect(setups[0]?.directories.length).toBeGreaterThan(0)
    expect(result.summary.sessions).toBeGreaterThan(0)
    expect(reports).toHaveLength(1)
    expect(result.summary).toMatchObject({ sessions: 2, calls: 2, costRateUSD: 0.00245 })
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        id: 'mcp-deferral-off',
        title: 'MCP tool deferral appears inactive',
        severity: 'medium',
        trend: null,
        tokensSaved: 4000,
      }),
    )
    expect(result.findings.find(finding => finding.id === 'mcp-deferral-off')?.estimatedSavingsUSD).toBeCloseTo(9.8)
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        id: 'unused-agents',
        title: '1 custom agent you never use',
        severity: 'low',
        trend: null,
        tokensSaved: 80,
        estimatedSavingsUSD: 0.196,
        fix: {
          type: 'command',
          label: 'Archive unused agent:',
          text: 'mv ~/.claude/agents/unused-agent.md ~/.claude/agents/.archived/',
        },
      }),
    )
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        id: 'build-folder-reads',
        severity: 'medium',
        trend: 'active',
        tokensSaved: 3600,
        estimatedSavingsUSD: 8.82,
      }),
    )
  })
})
