import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import * as compare from '../src/shared/schemas/compare.js'
import * as optimize from '../src/shared/schemas/optimize.js'
import * as spend from '../src/shared/schemas/spend.js'
import * as yieldView from '../src/shared/schemas/yield.js'

function expectDecoded(schema: Schema.ConstraintDecoder<unknown>, input: unknown, expected: unknown): void {
  const result = Schema.decodeUnknownResult(schema)(input)
  expect(result._tag).toBe('Success')
  if (result._tag === 'Success') expect(result.success).toStrictEqual(expected)
}

function expectRejected(schema: Schema.ConstraintDecoder<unknown>, input: unknown): void {
  expect(Schema.decodeUnknownResult(schema)(input)._tag).toBe('Failure')
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

describe('leaf view Effect Schema contracts', () => {
  it('strips unknown keys at the root and nested object levels', () => {
    expectDecoded(spend.spendPayloadSchema, spendPayload, spendPayload)
    expectDecoded(spend.spendPayloadSchema, { ...spendPayload, extension: { retained: true } }, spendPayload)
    expectDecoded(compare.comparePayloadSchema, comparePayload, comparePayload)
    expectDecoded(compare.comparePayloadSchema, { ...comparePayload, extension: { retained: true } }, comparePayload)
    expectDecoded(optimize.optimizePayloadSchema, optimizePayload, optimizePayload)
    expectDecoded(
      optimize.optimizePayloadSchema,
      { ...optimizePayload, extension: { retained: true } },
      optimizePayload,
    )
    expectDecoded(yieldView.yieldPayloadSchema, yieldPayload, yieldPayload)
    expectDecoded(yieldView.yieldPayloadSchema, { ...yieldPayload, extension: { retained: true } }, yieldPayload)
    expectDecoded(
      spend.spendPayloadSchema,
      { ...spendPayload, byModel: [{ ...spendPayload.byModel[0], extension: true }] },
      spendPayload,
    )
    expectDecoded(
      compare.comparePayloadSchema,
      { ...comparePayload, models: [{ ...modelStat, extension: true }] },
      comparePayload,
    )
    expectDecoded(
      optimize.optimizePayloadSchema,
      { ...optimizePayload, findings: [{ ...optimizePayload.findings[0], extension: true }] },
      optimizePayload,
    )
    expectDecoded(
      yieldView.yieldPayloadSchema,
      { ...yieldPayload, summary: { ...yieldPayload.summary, productive: { ...bucket, extension: true } } },
      yieldPayload,
    )
  })

  it('rejects invalid enum members and invalid collection values', () => {
    expectRejected(compare.comparePayloadSchema, {
      ...comparePayload,
      report: { ...comparePayload.report, metrics: [{ ...comparePayload.report.metrics[0], formatFn: 'invalid' }] },
    })
    expectRejected(optimize.optimizePayloadSchema, {
      ...optimizePayload,
      findings: [{ ...optimizePayload.findings[0], fix: { ...optimizePayload.findings[0].fix, type: 'invalid' } }],
    })
    expectRejected(yieldView.yieldPayloadSchema, {
      ...yieldPayload,
      details: [{ ...yieldPayload.details[0], category: 'invalid' }],
    })
    expectRejected(spend.spendPayloadSchema, { ...spendPayload, byModel: null })
  })

  it('preserves nullable, optional, and undefined distinctions', () => {
    expectDecoded(
      spend.spendSegmentSchema,
      { name: 'm', cost: 1, sourceModels: undefined },
      { name: 'm', cost: 1, sourceModels: undefined },
    )
    expectDecoded(spend.spendSegmentSchema, { name: 'm', cost: 1 }, { name: 'm', cost: 1 })
    expectRejected(spend.spendSegmentSchema, { name: 'm', cost: 1, sourceModels: null })
    expectDecoded(spend.spendPayloadSchema, { ...spendPayload, dataStart: null }, spendPayload)
    expectRejected(spend.spendPayloadSchema, { ...spendPayload, dataStart: undefined })
    expectDecoded(compare.comparePairSchema, { modelA: 'a', modelB: 'b' }, { modelA: 'a', modelB: 'b' })
    expectDecoded(
      optimize.lowWorthCandidateSchema,
      { project: 'p', sessionId: 's', date: '2026-01-01', cost: 1, tokens: 2, reasons: ['short'] },
      { project: 'p', sessionId: 's', date: '2026-01-01', cost: 1, tokens: 2, reasons: ['short'] },
    )
    expectDecoded(
      optimize.contextBloatCandidateSchema,
      {
        project: 'p',
        sessionId: 's',
        date: '2026-01-01',
        effectiveInputTokens: 3,
        outputTokens: 2,
        ratio: 1.5,
        excessInputTokens: 1,
        growthRatio: null,
      },
      {
        project: 'p',
        sessionId: 's',
        date: '2026-01-01',
        effectiveInputTokens: 3,
        outputTokens: 2,
        ratio: 1.5,
        excessInputTokens: 1,
        growthRatio: null,
      },
    )
    expectDecoded(
      optimize.wasteActionSchema,
      { type: 'command', label: 'Run', text: 'command' },
      { type: 'command', label: 'Run', text: 'command' },
    )
    expectDecoded(
      optimize.wasteActionSchema,
      { type: 'file-content', label: 'Edit', path: 'file', content: 'text' },
      { type: 'file-content', label: 'Edit', path: 'file', content: 'text' },
    )
  })

  it('rejects non-finite numbers and keeps decoded arrays and rows mutable', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expectRejected(spend.spendPayloadSchema, {
        ...spendPayload,
        byModel: [{ date: '2026-01-01', cost: value, segments: [] }],
      })
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
