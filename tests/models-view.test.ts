import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'

import { queryModelsView } from '../src/main/application/models-query.js'
import type { CachedFile } from '../src/main/pipeline/session-cache.js'
import type { TokenUsage } from '../src/main/pipeline/types.js'
import { LedgerConfig, LedgerIngest } from '../src/main/store/ledger-ports.js'
import {
  categoryLabel,
  formatCompact,
  formatUsd,
  groupTaskRows,
  isAuditEstimated,
  isUnpriced,
  providerTitle,
  sumGroup,
} from '../src/renderer/src/shared/lib/models.js'
import type { ModelsConfig, ModelsPayload } from '../src/shared/schemas/models.js'
import type { OverviewScope } from '../src/shared/schemas/overview.js'
import { buildFixtureCachedCall, buildFixtureCachedFile, buildFixtureCachedTurn } from './fixtures/cached-file.js'
import { atTime, openLedgerFixture, viewInputs } from './fixtures/ledger-runtime.js'

const NOW = new Date(2026, 6, 15)
// ── Ledger-backed Models view (map 04) ─────────────────────────────────────

type ModelsSessionSpec = {
  sessionId: string
  project: string
  provider: string
  model: string
  cost: number
  usage?: Partial<TokenUsage>
  date: string
  speed?: 'standard' | 'fast'
}

function modelsView(
  runtime: ReturnType<typeof openLedgerFixture>['runtime'],
  scope: OverviewScope = { period: 'lifetime' },
): ModelsPayload {
  return runtime.runSync(atTime(queryModelsView(viewInputs(scope)), NOW))
}

function modelsCachedFile(index: number, spec: ModelsSessionSpec): CachedFile {
  const baseCall = buildFixtureCachedCall(index)
  const iso = new Date(`${spec.date}T12:00:00`).toISOString()
  const call = {
    ...baseCall,
    provider: spec.provider,
    model: spec.model,
    usage: { ...baseCall.usage, ...spec.usage },
    costUSD: spec.cost,
    speed: spec.speed ?? 'standard',
    timestamp: iso,
  }
  const turn = buildFixtureCachedTurn(index, `task ${spec.sessionId}`, {
    sessionId: spec.sessionId,
    timestamp: iso,
    calls: [call],
  })
  return buildFixtureCachedFile({ canonicalProjectName: spec.project, title: '', turns: [turn] })
}

function modelsPort(runtime: ReturnType<typeof openLedgerFixture>['runtime'], specs: ModelsSessionSpec[]): void {
  runtime.runSync(
    Effect.flatMap(LedgerIngest, ingest =>
      Effect.forEach(specs, (spec, i) =>
        ingest.portIn({
          provider: spec.provider,
          envFingerprint: 'env-demo',
          filePath: `/cache/${spec.provider}/${spec.sessionId}.jsonl`,
          verdict: 'new',
          cachedFile: modelsCachedFile(i, spec),
        }),
      ),
    ),
  )
}

function setModelsConfig(runtime: ReturnType<typeof openLedgerFixture>['runtime'], config: ModelsConfig): void {
  runtime.runSync(
    Effect.flatMap(LedgerConfig, ledgerConfig =>
      Effect.gen(function* () {
        for (const alias of config.aliases) yield* ledgerConfig.setModelAlias(alias.model, alias.aliasOf)
        for (const override of config.overrides) {
          yield* ledgerConfig.setPriceOverride(override.model, {
            inputPricePerMillion: override.inputPricePerMillion,
            outputPricePerMillion: override.outputPricePerMillion,
          })
        }
      }),
    ),
  )
}

const MODELS_SPECS: ModelsSessionSpec[] = [
  {
    sessionId: 'sess-m0',
    project: 'demo-project',
    provider: 'claude',
    model: 'claude-opus-4',
    cost: 10,
    date: '2026-07-10',
  },
  {
    sessionId: 'sess-m1',
    project: 'demo-project',
    provider: 'claude',
    model: 'claude-sonnet-4',
    cost: 4,
    date: '2026-07-11',
  },
  {
    sessionId: 'sess-m2',
    project: 'demo-project',
    provider: 'claude',
    model: 'claude-opus-4',
    cost: 6,
    date: '2026-07-12',
  },
  {
    sessionId: 'sess-m3',
    project: 'demo-project',
    provider: 'opencode',
    model: 'claude-haiku-4',
    cost: 7,
    date: '2026-07-10',
  },
]

describe('queryModelsView (aggregation seam scope)', () => {
  it('buckets by model, sorts by cost, across the full range', () => {
    const { runtime } = openLedgerFixture()
    modelsPort(runtime, MODELS_SPECS)
    const payload = modelsView(runtime)

    expect(payload.byModel.map(row => row.model)).toEqual(['claude-opus-4', 'claude-haiku-4', 'claude-sonnet-4'])
    const opus = payload.byModel[0]!
    expect(opus.costUSD).toBe(16)
    expect(opus.calls).toBe(2)
    expect(opus.totalTokens).toBe(opus.inputTokens + opus.outputTokens + opus.cacheWriteTokens + opus.cacheReadTokens)
  })

  it('filters to a single provider at query time', () => {
    const { runtime } = openLedgerFixture()
    modelsPort(runtime, MODELS_SPECS)
    const payload = modelsView(runtime, {
      period: 'lifetime',
      provider: 'claude',
      range: { since: '2026-07-10', until: '2026-07-10' },
    })

    expect(payload.byModel.map(row => row.model)).toEqual(['claude-opus-4'])
    expect(payload.audit.map(row => row.provider)).toEqual(['claude'])
  })

  it('respects the custom range window', () => {
    const { runtime } = openLedgerFixture()
    modelsPort(runtime, [
      {
        sessionId: 'sess-r0',
        project: 'demo-project',
        provider: 'claude',
        model: 'claude-opus-4',
        cost: 10,
        date: '2026-07-10',
      },
      {
        sessionId: 'sess-r1',
        project: 'demo-project',
        provider: 'claude',
        model: 'claude-sonnet-4',
        cost: 4,
        date: '2026-07-12',
      },
    ])
    const payload = modelsView(runtime, {
      period: 'lifetime',
      range: { since: '2026-07-11', until: '2026-07-13' },
    })

    expect(payload.byModel.map(row => row.model)).toEqual(['claude-sonnet-4'])
  })

  it('an alias rewrites the model and reprices the row from token usage', () => {
    const { runtime } = openLedgerFixture()
    modelsPort(runtime, [
      {
        sessionId: 'sess-mx',
        project: 'demo-project',
        provider: 'claude',
        model: 'weird-model',
        cost: 0,
        date: '2026-07-10',
        usage: {
          inputTokens: 1000,
          outputTokens: 500,
          reasoningTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          cachedInputTokens: 0,
          webSearchRequests: 0,
        },
      },
    ])
    setModelsConfig(runtime, { aliases: [{ model: 'weird-model', aliasOf: 'claude-sonnet-4-6' }], overrides: [] })
    const payload = modelsView(runtime, { period: 'lifetime' })

    const row = payload.byModel[0]!
    expect(row.model).toBe('claude-sonnet-4-6')
    expect(row.modelDisplayName).toBe('Sonnet 4.6')
    expect(row.costUSD).toBeCloseTo(0.0105)
    const auditRow = payload.audit[0]!
    expect(auditRow.model).toBe('weird-model')
    expect(auditRow.attributedCostUSD).toBeCloseTo(0.0105)
  })

  it('returns an empty payload for an empty ledger', () => {
    const { runtime } = openLedgerFixture()
    const payload = modelsView(runtime)
    expect(payload).toEqual({ byModel: [], byTask: [], audit: [] })
  })
})

describe('models rows expose their pricing state (alias/override management)', () => {
  const PRICED_USAGE = {
    inputTokens: 1000,
    outputTokens: 500,
    reasoningTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    webSearchRequests: 0,
  }

  it('an aliased by-model row names its raw feeders; the audit row keeps the raw name with its alias target', () => {
    const { runtime } = openLedgerFixture()
    modelsPort(runtime, [
      {
        sessionId: 'sess-mx',
        project: 'demo-project',
        provider: 'claude',
        model: 'weird-model',
        cost: 0,
        date: '2026-07-10',
        usage: PRICED_USAGE,
      },
    ])
    setModelsConfig(runtime, { aliases: [{ model: 'weird-model', aliasOf: 'claude-sonnet-4-6' }], overrides: [] })
    const payload = modelsView(runtime)

    const row = payload.byModel[0]!
    expect(row.model).toBe('claude-sonnet-4-6')
    expect(row.sourceModels).toEqual(['weird-model'])
    expect(row.override).toBeUndefined()
    const taskRow = payload.byTask.find(r => r.model === 'claude-sonnet-4-6')!
    expect(taskRow.sourceModels).toEqual(['weird-model'])
    const auditRow = payload.audit[0]!
    expect(auditRow.model).toBe('weird-model')
    expect(auditRow.aliasOf).toBe('claude-sonnet-4-6')
  })

  it('an alias on the bare name merges variant-spelled usage into the target row', () => {
    const { runtime } = openLedgerFixture()
    modelsPort(runtime, [
      {
        sessionId: 'sess-mx',
        project: 'demo-project',
        provider: 'opencode',
        model: 'Opencode/Weird-Model@20250929',
        cost: 0,
        date: '2026-07-10',
        usage: PRICED_USAGE,
      },
    ])
    setModelsConfig(runtime, { aliases: [{ model: 'weird-model', aliasOf: 'claude-sonnet-4-6' }], overrides: [] })
    const payload = modelsView(runtime)

    const row = payload.byModel[0]!
    expect(row.model).toBe('claude-sonnet-4-6')
    expect(row.costUSD).toBeCloseTo(0.0105, 9)
    expect(row.sourceModels).toEqual(['Opencode/Weird-Model@20250929'])
    const auditRow = payload.audit[0]!
    expect(auditRow.model).toBe('Opencode/Weird-Model@20250929')
    expect(auditRow.aliasOf).toBe('claude-sonnet-4-6')
    expect(auditRow.attributedCostUSD).toBeCloseTo(0.0105, 9)
  })

  it('a Price override on the effective model is exposed on by-model and audit rows', () => {
    const { runtime } = openLedgerFixture()
    modelsPort(runtime, [
      {
        sessionId: 'sess-mx',
        project: 'demo-project',
        provider: 'claude',
        model: 'weird-model',
        cost: 0,
        date: '2026-07-10',
        usage: PRICED_USAGE,
      },
    ])
    setModelsConfig(runtime, {
      aliases: [{ model: 'weird-model', aliasOf: 'claude-sonnet-4-6' }],
      overrides: [{ model: 'claude-sonnet-4-6', inputPricePerMillion: 6, outputPricePerMillion: 30 }],
    })
    const payload = modelsView(runtime)

    // 1000 in @ $6/M + 500 out @ $30/M.
    const row = payload.byModel[0]!
    expect(row.costUSD).toBeCloseTo(0.021, 9)
    expect(row.sourceModels).toEqual(['weird-model'])
    expect(row.override).toEqual({ inputPricePerMillion: 6, outputPricePerMillion: 30 })
    const auditRow = payload.audit[0]!
    expect(auditRow.aliasOf).toBe('claude-sonnet-4-6')
    expect(auditRow.override).toEqual({ inputPricePerMillion: 6, outputPricePerMillion: 30 })
  })

  it('removing the alias and override reverts rows to plain unpriced identity', () => {
    const { runtime } = openLedgerFixture()
    modelsPort(runtime, [
      {
        sessionId: 'sess-mx',
        project: 'demo-project',
        provider: 'claude',
        model: 'weird-model',
        cost: 0,
        date: '2026-07-10',
        usage: PRICED_USAGE,
      },
    ])
    const config: ModelsConfig = {
      aliases: [{ model: 'weird-model', aliasOf: 'claude-sonnet-4-6' }],
      overrides: [{ model: 'claude-sonnet-4-6', inputPricePerMillion: 6, outputPricePerMillion: 30 }],
    }
    setModelsConfig(runtime, config)
    expect(modelsView(runtime).byModel[0]!.model).toBe('claude-sonnet-4-6')

    runtime.runSync(
      Effect.flatMap(LedgerConfig, ledgerConfig =>
        Effect.gen(function* () {
          yield* ledgerConfig.removeModelAlias('weird-model')
          yield* ledgerConfig.removePriceOverride('claude-sonnet-4-6')
        }),
      ),
    )
    const reverted = modelsView(runtime)
    const row = reverted.byModel[0]!
    expect(row.model).toBe('weird-model')
    expect(row.sourceModels).toBeUndefined()
    expect(row.override).toBeUndefined()
    expect(reverted.audit[0]!.aliasOf).toBeUndefined()
    expect(reverted.audit[0]!.override).toBeUndefined()
  })
})

describe('models lib helpers', () => {
  it('formats compact token counts', () => {
    expect(formatCompact(0)).toBe('0')
    expect(formatCompact(1842)).toBe('1.8K')
    expect(formatCompact(184000)).toBe('184K')
    expect(formatCompact(1200000)).toBe('1.2M')
    expect(formatCompact(2.5e9)).toBe('2.5B')
    expect(formatCompact(Number.NaN)).toBe('—')
  })

  it('formats USD with two decimals', () => {
    expect(formatUsd(0.42)).toBe('$0.42')
    expect(formatUsd(1234.5)).toBe('$1,234.50')
  })

  it('maps task categories to labels', () => {
    expect(categoryLabel('coding')).toBe('Coding')
    expect(categoryLabel(null)).toBe('General')
    expect(categoryLabel('build/deploy')).toBe('Build/Deploy')
    expect(categoryLabel('bogus')).toBe('bogus')
  })

  it('flags rows unpriced only when both cost and savings are zero', () => {
    expect(isUnpriced({ costUSD: 0, savingsUSD: 0 })).toBe(true)
    expect(isUnpriced({ costUSD: 0.01, savingsUSD: 0 })).toBe(false)
    expect(isUnpriced({ costUSD: 0, savingsUSD: 0.5 })).toBe(false)
  })

  it('title-cases provider names', () => {
    expect(providerTitle('opencode')).toBe('Opencode')
    expect(providerTitle('claude-code')).toBe('Claude-code')
    expect(providerTitle('')).toBe('')
  })

  it('estimates audit cost when there is no rate or the recompute diverges', () => {
    const base = {
      provider: 'claude',
      model: 'mystery-model',
      modelDisplayName: 'mystery-model',
      calls: 1,
      raw: {
        inputTokens: 1000,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        webSearchRequests: 0,
      },
      displayed: { inputTokens: 1000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
      rates: {
        inputCostPerToken: 0.000003,
        outputCostPerToken: 0.000015,
        cacheWriteCostPerToken: 0,
        cacheReadCostPerToken: 0,
        webSearchCostPerRequest: 0,
        fastMultiplier: 1,
      },
      cost: {
        input: 0.003,
        output: 0,
        cacheWrite: 0,
        cacheRead: 0,
        webSearch: 0,
        recomputedTotalUSD: 0.003,
      },
    }
    expect(isAuditEstimated({ ...base, attributedCostUSD: 0.003 })).toBe(false)
    expect(isAuditEstimated({ ...base, attributedCostUSD: 0.01 })).toBe(true)
    expect(isAuditEstimated({ ...base, rates: null, attributedCostUSD: 0 })).toBe(true)
  })

  it('groups by-task rows under their model and sums the group', () => {
    const rows = [
      {
        provider: 'claude',
        model: 'claude-opus-4',
        modelDisplayName: 'Opus 4',
        category: 'coding',
        calls: 2,
        costUSD: 10,
        savingsUSD: 1,
      },
      {
        provider: 'claude',
        model: 'claude-opus-4',
        modelDisplayName: 'Opus 4',
        category: 'debugging',
        calls: 1,
        costUSD: 6,
        savingsUSD: 0,
      },
      {
        provider: 'claude',
        model: 'claude-sonnet-4',
        modelDisplayName: 'Sonnet 4',
        category: 'coding',
        calls: 1,
        costUSD: 4,
        savingsUSD: 0,
      },
    ] as unknown as ModelsPayload['byTask']

    const groups = groupTaskRows(rows)
    expect(groups).toHaveLength(2)
    expect(groups[0]!.model).toBe('claude-opus-4')
    expect(groups[0]!.rows).toHaveLength(2)
    expect(sumGroup(groups[0]!)).toEqual({ calls: 3, costUSD: 16, savingsUSD: 1 })
    expect(groups[1]!.modelDisplayName).toBe('Sonnet 4')
  })
})
