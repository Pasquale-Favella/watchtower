import * as Effect from 'effect/Effect'
import * as TestClock from 'effect/testing/TestClock'
import { describe, expect, it } from 'vitest'

import { AssistantSetup } from '../src/main/application/assistant-setup.js'
import { queryOptimizeView } from '../src/main/application/optimize-query.js'
import { PricingDiagnostics } from '../src/main/application/pricing-diagnostics.js'
import { capturePricingCatalogue } from '../src/main/pipeline/pricing-calculation.js'
import { LedgerIngest, LedgerQueries } from '../src/main/store/ledger-ports.js'
import { buildFixtureCachedCall, buildFixtureCachedFile, buildFixtureCachedTurn } from './fixtures/cached-file.js'
import { openLedgerFixture } from './fixtures/ledger-runtime.js'

const catalogue = capturePricingCatalogue({
  prices: new Map(),
  overrides: new Map(),
  builtinAliases: {},
  userAliases: {},
  tiers: [],
  routedSegments: new Set(),
})
const input = { scope: { period: 'lifetime' as const }, catalogue, proxyPaths: { paths: [], caseSensitive: false } }

describe('queryOptimizeView', () => {
  it('captures the clock before loading one snapshot and skips filesystem setup for an empty result', async () => {
    const { runtime } = openLedgerFixture()
    const reports: string[][] = []
    let setupCalls = 0
    let snapshotReads = 0
    const capturedInstant = new Date(2026, 6, 2, 12).getTime()
    const result = await runtime.runPromise(
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
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(result.findings).toEqual([])
    expect(new Date(result.period.start ?? '').getDate()).toBe(2)
    expect(result.period.end).toBe(new Date(capturedInstant).toISOString())
    expect(snapshotReads).toBe(1)
    expect(setupCalls).toBe(0)
    expect(reports).toEqual([[]])
  })

  it('loads Optimize setup once for nonempty project data and validates the result', async () => {
    const { runtime } = openLedgerFixture()
    for (const index of [0, 1]) {
      runtime.runSync(
        Effect.flatMap(LedgerIngest, ingest =>
          ingest.portIn({
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
                      toolErrors: 2,
                      editFailed: 1,
                      interrupted: true,
                      tools: ['mcp__filesystem__list'],
                      toolSequence: [
                        [
                          { tool: 'Read', file: 'C:\\workspace\\dist\\generated.ts' },
                          { tool: 'Read', file: 'C:\\workspace\\dist\\generated.ts' },
                          { tool: 'Read', file: 'C:\\workspace\\dist\\generated.ts' },
                          { tool: 'mcp__filesystem__list' },
                        ],
                      ],
                    },
                  ],
                }),
              ],
            }),
          }),
        ),
      )
    }
    const setups: Array<{ directories: readonly string[]; home?: string }> = []
    const reports: string[][] = []
    const result = await runtime.runPromise(
      queryOptimizeView({ ...input, homeDir: '/test-home' }).pipe(
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
    for (const id of ['tool-failures', 'interrupted-calls']) {
      expect(result.findings.find(f => f.id === id)).toMatchObject({
        basis: 'observed',
        quantity: { value: 2, unit: 'calls' },
        estimatedSavingsUSD: null,
      })
    }
    expect(result.summary).toMatchObject({ sessions: 2, calls: 2, potentialSavingsCostUSD: null, healthGrade: null })
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        id: 'mcp-deferral-off',
        severity: 'medium',
        estimatedSavingsUSD: null,
        tokensSaved: null,
        findingClass: 'setup',
        basis: 'modeled',
        associatedSpendUSD: null,
      }),
    )
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        id: 'unused-agents',
        severity: 'low',
        estimatedSavingsUSD: null,
        title: '1 current custom agent without observed use',
        quantity: { value: 1, unit: 'definitions' },
        affectedSessions: [],
        associatedSpendUSD: null,
      }),
    )
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        id: 'build-folder-reads',
        severity: 'medium',
        trend: null,
        tokensSaved: null,
        quantity: { value: 6, unit: 'reads' },
        basis: 'observed',
        estimatedSavingsUSD: null,
      }),
    )
  })

  it('skips Claude setup inspection for a Codex-only Scope', async () => {
    const { runtime } = openLedgerFixture()
    runtime.runSync(
      Effect.flatMap(LedgerIngest, ingest =>
        ingest.portIn({
          provider: 'codex',
          envFingerprint: 'codex-only',
          filePath: '/codex/session.jsonl',
          verdict: 'new',
          cachedFile: buildFixtureCachedFile({
            turns: [
              buildFixtureCachedTurn(0, 'inspect', {
                calls: [{ ...buildFixtureCachedCall(0), provider: 'codex' }],
              }),
            ],
          }),
        }),
      ),
    )
    const result = await runtime.runPromise(
      queryOptimizeView({ ...input, scope: { period: 'lifetime', provider: 'codex' } }).pipe(
        Effect.provideService(
          AssistantSetup,
          AssistantSetup.of({
            getOptimizeSetup: () => Effect.die('Codex Scope must not inspect Claude configuration'),
            getSkillInventory: () => Effect.succeed([]),
          }),
        ),
        Effect.provideService(PricingDiagnostics, PricingDiagnostics.of({ reportUnpricedModels: () => Effect.void })),
      ),
    )
    expect(result.summary).toMatchObject({
      sessions: 1,
      healthGrade: null,
      setupCoverage: { eligibleSessions: 0, observedSessions: 0 },
    })
    expect(result.findings.some(f => f.id.startsWith('unused-'))).toBe(false)
  })
})
