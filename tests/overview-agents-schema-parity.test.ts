import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import * as agents from '../src/shared/schemas/agents.js'
import * as overview from '../src/shared/schemas/overview.js'

function expectDecoded(schema: Schema.ConstraintDecoder<unknown>, input: unknown, expected: unknown): void {
  const result = Schema.decodeUnknownResult(schema)(input)
  expect(result._tag).toBe('Success')
  if (result._tag === 'Success') expect(result.success).toStrictEqual(expected)
}

function expectRejected(schema: Schema.ConstraintDecoder<unknown>, input: unknown): void {
  expect(Schema.decodeUnknownResult(schema)(input)._tag).toBe('Failure')
}

const kpis = {
  cost: 1,
  calls: 2,
  sessions: 3,
  inputTokens: 4,
  outputTokens: 5,
  cacheReadTokens: 6,
  cacheWriteTokens: 7,
  savingsUSD: 8,
  estimatedCostUSD: 9,
  oneShotRate: null,
  cacheHitPercent: 10,
}
const overviewPayload = {
  kpis,
  daily: [{ date: '2026-01-01', costUSD: 1, calls: 2, sessions: 3 }],
  dataStart: null,
  models: [{ name: 'm', cost: 1, calls: 2, inputTokens: 3, outputTokens: 4, savingsUSD: 5, sourceModels: ['raw'] }],
  activities: [{ name: 'a', cost: 1, turns: 2, oneShotRate: null }],
  tools: [{ name: 't', calls: 1 }],
  mcpServers: [{ name: 's', calls: 2 }],
  skills: [{ name: 'sk', turns: 1, cost: 2 }],
  subagents: [{ name: 'sa', calls: 1, cost: 2 }],
  efficiency: {
    score: 90,
    grade: 'A',
    oneShotRate: null,
    retryTax: {
      totalUSD: 1,
      retries: 2,
      editTurns: 3,
      byModel: [{ name: 'm', taxUSD: 1, retries: 2, retriesPerEdit: null }],
    },
    routingWaste: {
      baselineModel: 'b',
      baselineCostPerEdit: 1,
      totalSavingsUSD: 2,
      byModel: [{ name: 'm', actualUSD: 1, counterfactualUSD: 2, savingsUSD: 1 }],
    },
    pricingCoverage: 1,
  },
  workflow: {
    corrections: 1,
    userTurns: 2,
    correctionRate: null,
    medianTimeToFirstEditMs: null,
    topReworkedFiles: [{ path: 'f', sessions: 1, edits: 2 }],
  },
  unpricedModels: [{ model: 'u', calls: 1, tokens: 2 }],
  localModelSavings: {
    totalUSD: 1,
    calls: 2,
    byModel: [
      { name: 'm', calls: 1, actualUSD: 2, savingsUSD: 3, baselineModel: 'b', inputTokens: 4, outputTokens: 5 },
    ],
    byProvider: [{ name: 'p', calls: 1, savingsUSD: 2 }],
  },
}
const harnessRow = {
  instanceId: 'i',
  kind: 'claude',
  displayName: 'Claude',
  status: 'ready',
  auth: { status: 'configured' },
}
const modelInfo = { modelId: 'opus', name: 'Opus' }
const runRequest = {
  harnessKind: 'claude',
  scope: { period: 'all', range: { since: 'a', until: 'b' } },
  prompt: 'hello',
}
const inspectRequest = { kind: 'claude', allowApiKeyEnv: false }
const sessionEvent = {
  kind: 'session',
  resumeCursor: 'c',
  models: { availableModels: [modelInfo], currentModelId: 'opus' },
}

describe('overview and agents Effect Schema contracts', () => {
  it('strips unknown keys at the root and nested object levels', () => {
    expectDecoded(overview.overviewPayloadSchema, overviewPayload, overviewPayload)
    expectDecoded(
      overview.overviewPayloadSchema,
      {
        ...overviewPayload,
        extension: true,
        kpis: { ...overviewPayload.kpis, extension: true },
        models: [{ ...overviewPayload.models[0], extension: true }],
      },
      overviewPayload,
    )
    expectDecoded(
      overview.overviewScopeSchema,
      {
        period: 'week',
        provider: 'claude',
        extension: true,
        range: { since: 'a', until: 'b', extra: true },
      },
      { period: 'week', provider: 'claude', range: { since: 'a', until: 'b' } },
    )
    expectDecoded(agents.coachRunRequestSchema, runRequest, runRequest)
    expectDecoded(agents.coachRunRequestSchema, { ...runRequest, extension: true }, runRequest)
    expectDecoded(agents.coachInspectRequestSchema, inspectRequest, inspectRequest)
    expectDecoded(agents.coachInspectRequestSchema, { ...inspectRequest, extension: true }, inspectRequest)
    expectDecoded(agents.coachHarnessRowSchema, harnessRow, harnessRow)
    expectDecoded(agents.coachHarnessRowSchema, { ...harnessRow, extension: true }, harnessRow)
    expectDecoded(agents.coachEventSchema, sessionEvent, sessionEvent)
    expectDecoded(agents.coachEventSchema, { ...sessionEvent, extension: true }, sessionEvent)
  })

  it('preserves optional undefined, omitted, and nullable distinctions', () => {
    expectRejected(overview.overviewPayloadSchema, {
      ...overviewPayload,
      dataStart: undefined,
      models: [{ ...overviewPayload.models[0], sourceModels: undefined }],
    })
    expectDecoded(
      overview.overviewModelRowSchema,
      { ...overviewPayload.models[0], sourceModels: undefined },
      { ...overviewPayload.models[0], sourceModels: undefined },
    )
    expectDecoded(
      overview.overviewModelRowSchema,
      { name: 'm', cost: 1, calls: 2, inputTokens: 3, outputTokens: 4, savingsUSD: 5 },
      { name: 'm', cost: 1, calls: 2, inputTokens: 3, outputTokens: 4, savingsUSD: 5 },
    )
    expectRejected(overview.overviewModelRowSchema, {
      name: 'm',
      cost: 1,
      calls: 2,
      inputTokens: 3,
      outputTokens: 4,
      savingsUSD: 5,
      sourceModels: null,
    })
    expectDecoded(agents.coachModelInfoSchema, modelInfo, modelInfo)
    expectDecoded(
      agents.coachModelInfoSchema,
      { ...modelInfo, description: undefined },
      { ...modelInfo, description: undefined },
    )
    expectDecoded(agents.coachModelInfoSchema, { ...modelInfo, description: null }, { ...modelInfo, description: null })
    expectRejected(agents.coachRunRequestSchema, { harnessKind: 'claude', prompt: null })
  })

  it('rejects non-finite numbers and keeps decoded collections and rows mutable', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expectRejected(overview.overviewPayloadSchema, {
        ...overviewPayload,
        kpis: { ...kpis, cost: value },
      })
    }
    const decoded = Schema.decodeUnknownSync(overview.overviewPayloadSchema)(overviewPayload)
    decoded.daily.push({ date: 'later', costUSD: 0, calls: 0, sessions: 0 })
    decoded.kpis.cost = 2
    decoded.models[0]?.sourceModels?.push('another')
    expect(decoded.daily.at(-1)?.date).toBe('later')
    expect(decoded.kpis.cost).toBe(2)
    expect(decoded.models[0]?.sourceModels).toEqual(['raw', 'another'])
    const event = Schema.decodeUnknownSync(agents.coachEventSchema)(sessionEvent)
    if (event.kind !== 'session') throw new Error('fixture must decode as session')
    event.models?.availableModels.push({ modelId: 'sonnet', name: 'Sonnet' })
    expect(event.models?.availableModels).toHaveLength(2)
  })
})
