import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import * as compare from '../src/shared/schemas/compare.js'
import * as optimize from '../src/shared/schemas/optimize.js'
import * as spend from '../src/shared/schemas/spend.js'
import * as yieldView from '../src/shared/schemas/yield.js'
import { preEffectLeafViewContracts } from './fixtures/pre-effect-leaf-view-schemas.js'

type LegacySchema = { safeParse: (input: unknown) => { success: boolean; data?: unknown } }

function assertParity(legacy: LegacySchema, current: Schema.ConstraintDecoder<unknown>, input: unknown): void {
  const before = legacy.safeParse(input)
  const after = Schema.decodeUnknownResult(current)(input)
  expect(after._tag === 'Success').toBe(before.success)
  if (before.success && after._tag === 'Success') expect(after.success).toStrictEqual(before.data)
}

const modelStat = {
  model: 'model',
  displayName: 'Model',
  calls: 1,
  costUSD: 2,
  outputTokens: 3,
  inputTokens: 4,
  cacheReadTokens: 5,
  totalTurns: 6,
  editTurns: 1,
  oneShotTurns: 2,
  retries: 0,
}
const bucket = { costUSD: 1, sessions: 2, costPercent: 50, sessionPercent: 25 }
const optimizePayload = {
  period: { start: null, end: '2026-01-01' },
  summary: {
    healthScore: 90,
    healthGrade: 'A',
    findingCount: 1,
    periodCostUSD: 4,
    sessions: 2,
    calls: 3,
    potentialSavingsTokens: 5,
    potentialSavingsCostUSD: 6,
    potentialSavingsPercent: null,
    costRateUSD: 0.1,
  },
  findings: [
    {
      id: 'read-edit-ratio',
      title: 'title',
      explanation: 'explanation',
      severity: 'medium',
      trend: null,
      tokensSaved: 1,
      estimatedSavingsUSD: 0.1,
      fix: { type: 'paste', label: 'Paste', text: 'text', destination: 'prompt' },
    },
  ],
}
const yieldPayload = {
  period: { start: null, end: null },
  summary: {
    productive: bucket,
    reverted: bucket,
    abandoned: bucket,
    ambiguous: bucket,
    total: { costUSD: 4, sessions: 2 },
    productiveToRevertedCostRatio: null,
  },
  methodology: 'timestamp-window',
  details: [{ sessionId: 's', project: 'p', costUSD: 2, category: 'productive', commitCount: 1 }],
}
const spendPayload = {
  byModel: [{ date: '2026-01-01', cost: 2, segments: [{ name: 'm', cost: 2, sourceModels: ['raw'] }] }],
  byProject: [{ date: '2026-01-01', cost: 2, segments: [{ name: 'p', cost: 2 }] }],
  flow: {
    models: [{ id: 'm', label: 'Model', cost: 2, sourceModels: ['raw'] }],
    projects: [{ id: 'p', label: 'Project', cost: 2 }],
    links: [{ model: 'm', project: 'p', cost: 2 }],
  },
  dataStart: null,
}
const comparePayload = {
  models: [modelStat],
  report: {
    modelA: modelStat,
    modelB: modelStat,
    metrics: [{ label: 'Cost', valueA: 1, valueB: null, formatFn: 'cost', winner: 'a' }],
    categories: [
      {
        category: 'chat',
        turnsA: 1,
        editTurnsA: 1,
        oneShotRateA: null,
        turnsB: 2,
        editTurnsB: 1,
        oneShotRateB: 0.5,
        winner: 'b',
      },
    ],
    workingStyle: [{ label: 'Edits', valueA: 1, valueB: 2, formatFn: 'number' }],
  },
}

const cases = [
  ['spend', preEffectLeafViewContracts.spendPayloadSchema, spend.spendPayloadSchema, spendPayload],
  ['compare', preEffectLeafViewContracts.comparePayloadSchema, compare.comparePayloadSchema, comparePayload],
  ['optimize', preEffectLeafViewContracts.optimizePayloadSchema, optimize.optimizePayloadSchema, optimizePayload],
  ['yield', preEffectLeafViewContracts.yieldPayloadSchema, yieldView.yieldPayloadSchema, yieldPayload],
] as const

describe('leaf view Effect Schema parity', () => {
  it.each(cases)('%s preserves old decoded values and unknown-key stripping', (_name, legacy, current, sample) => {
    const extended = structuredClone(sample) as Record<string, unknown>
    extended.extension = { retained: true }
    assertParity(legacy, current, extended)
    assertParity(legacy, current, sample)
  })

  it('preserves nested unknown-key stripping, enum rejection, and required fields', () => {
    assertParity(preEffectLeafViewContracts.spendPayloadSchema, spend.spendPayloadSchema, {
      ...spendPayload,
      byModel: [{ ...spendPayload.byModel[0], extension: true }],
    })
    assertParity(preEffectLeafViewContracts.comparePayloadSchema, compare.comparePayloadSchema, {
      ...comparePayload,
      models: [{ ...modelStat, extension: true }],
    })
    assertParity(preEffectLeafViewContracts.optimizePayloadSchema, optimize.optimizePayloadSchema, {
      ...optimizePayload,
      findings: [{ ...optimizePayload.findings[0], extension: true }],
    })
    assertParity(preEffectLeafViewContracts.yieldPayloadSchema, yieldView.yieldPayloadSchema, {
      ...yieldPayload,
      summary: { ...yieldPayload.summary, productive: { ...bucket, extension: true } },
    })

    assertParity(preEffectLeafViewContracts.comparePayloadSchema, compare.comparePayloadSchema, {
      ...comparePayload,
      report: { ...comparePayload.report, metrics: [{ ...comparePayload.report.metrics[0], formatFn: 'invalid' }] },
    })
    assertParity(preEffectLeafViewContracts.optimizePayloadSchema, optimize.optimizePayloadSchema, {
      ...optimizePayload,
      findings: [{ ...optimizePayload.findings[0], fix: { ...optimizePayload.findings[0].fix, type: 'invalid' } }],
    })
    assertParity(preEffectLeafViewContracts.yieldPayloadSchema, yieldView.yieldPayloadSchema, {
      ...yieldPayload,
      details: [{ ...yieldPayload.details[0], category: 'invalid' }],
    })
    assertParity(preEffectLeafViewContracts.spendPayloadSchema, spend.spendPayloadSchema, {
      ...spendPayload,
      byModel: null,
    })
  })

  it('preserves nullable, optional, and undefined distinctions', () => {
    assertParity(preEffectLeafViewContracts.spendSegmentSchema, spend.spendSegmentSchema, {
      name: 'm',
      cost: 1,
      sourceModels: undefined,
    })
    assertParity(preEffectLeafViewContracts.spendSegmentSchema, spend.spendSegmentSchema, { name: 'm', cost: 1 })
    assertParity(preEffectLeafViewContracts.spendSegmentSchema, spend.spendSegmentSchema, {
      name: 'm',
      cost: 1,
      sourceModels: null,
    })
    assertParity(preEffectLeafViewContracts.spendPayloadSchema, spend.spendPayloadSchema, {
      ...spendPayload,
      dataStart: null,
    })
    assertParity(preEffectLeafViewContracts.spendPayloadSchema, spend.spendPayloadSchema, {
      ...spendPayload,
      dataStart: undefined,
    })
    assertParity(preEffectLeafViewContracts.comparePairSchema, compare.comparePairSchema, { modelA: 'a', modelB: 'b' })
    assertParity(preEffectLeafViewContracts.lowWorthCandidateSchema, optimize.lowWorthCandidateSchema, {
      project: 'p',
      sessionId: 's',
      date: '2026-01-01',
      cost: 1,
      tokens: 2,
      reasons: ['short'],
    })
    assertParity(preEffectLeafViewContracts.contextBloatCandidateSchema, optimize.contextBloatCandidateSchema, {
      project: 'p',
      sessionId: 's',
      date: '2026-01-01',
      effectiveInputTokens: 3,
      outputTokens: 2,
      ratio: 1.5,
      excessInputTokens: 1,
      growthRatio: null,
    })
    assertParity(preEffectLeafViewContracts.wasteActionSchema, optimize.wasteActionSchema, {
      type: 'command',
      label: 'Run',
      text: 'command',
    })
    assertParity(preEffectLeafViewContracts.wasteActionSchema, optimize.wasteActionSchema, {
      type: 'file-content',
      label: 'Edit',
      path: 'file',
      content: 'text',
    })
  })

  it('rejects non-finite numeric values and keeps decoded arrays mutable', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() =>
        Schema.decodeUnknownSync(spend.spendPayloadSchema)({
          ...spendPayload,
          byModel: [{ date: '2026-01-01', cost: value, segments: [] }],
        }),
      ).toThrow()
    }

    const decoded = Schema.decodeUnknownSync(spend.spendPayloadSchema)(spendPayload)
    decoded.byModel.push({ date: 'later', cost: 0, segments: [] })
    const firstEntry = decoded.byModel[0]
    expect(firstEntry).toBeDefined()
    if (!firstEntry) throw new Error('the decoded sample has a model entry')
    firstEntry.segments.push({ name: 'later', cost: 0 })
    const firstSegment = firstEntry.segments[0]
    expect(firstSegment).toBeDefined()
    if (!firstSegment) throw new Error('the decoded sample has a segment')
    firstSegment.name = 'updated'
    expect(firstSegment.name).toBe('updated')
  })
})
