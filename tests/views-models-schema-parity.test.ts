import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import { effectSchemaDecoder } from '../src/renderer/src/shared/lib/schema-decoder.js'
import * as models from '../src/shared/schemas/models.js'
import * as views from '../src/shared/schemas/views.js'
import { preEffectModelsContracts, preEffectViewsContracts } from './fixtures/pre-effect-views-models-schemas.js'

type LegacySchema = { safeParse: (input: unknown) => { success: boolean; data?: unknown } }

function assertParity(legacy: LegacySchema, current: Schema.ConstraintDecoder<unknown>, input: unknown): void {
  const before = legacy.safeParse(input)
  const after = effectSchemaDecoder(current)(input)
  expect(after.ok).toBe(before.success)
  if (before.success && after.ok) expect(after.value).toStrictEqual(before.data)
}

const costs = {
  inputCostPerToken: 1,
  outputCostPerToken: 2,
  cacheWriteCostPerToken: 3,
  cacheReadCostPerToken: 4,
  webSearchCostPerRequest: 5,
  fastMultiplier: 6,
}
const override = { inputPricePerMillion: 1, outputPricePerMillion: 2 }
const modelRow = {
  provider: 'provider',
  model: 'model',
  modelDisplayName: 'Model',
  category: null,
  inputTokens: 1,
  outputTokens: 2,
  cacheWriteTokens: 3,
  cacheReadTokens: 4,
  totalTokens: 10,
  costUSD: 5,
  savingsUSD: 6,
  savingsBaselineModel: 'baseline',
  calls: 1,
}
const auditRow = {
  provider: 'provider',
  model: 'model',
  modelDisplayName: 'Model',
  calls: 1,
  raw: {
    inputTokens: 1,
    outputTokens: 2,
    reasoningTokens: 3,
    cacheCreationInputTokens: 4,
    cacheReadInputTokens: 5,
    cachedInputTokens: 6,
    webSearchRequests: 7,
  },
  displayed: { inputTokens: 1, outputTokens: 2, cacheWriteTokens: 3, cacheReadTokens: 4 },
  rates: costs,
  cost: { input: 1, output: 2, cacheWrite: 3, cacheRead: 4, webSearch: 5, recomputedTotalUSD: 15 },
  attributedCostUSD: 15,
}
const providerRow = { name: 'provider', cost: 1, calls: 2, sessions: 3 }
const detailCall = {
  provider: 'provider',
  model: 'model',
  costUSD: 1,
  speed: 'standard',
  hasPlanMode: false,
  tools: [],
  mcpTools: [],
  skills: [],
  subagentTypes: [],
  usage: {
    inputTokens: 1,
    outputTokens: 2,
    reasoningTokens: 3,
    cacheReadInputTokens: 4,
    cacheCreationInputTokens: 5,
  },
}
const detailTurn = {
  timestamp: '2026-01-01T00:00:00.000Z',
  userMessage: 'hello',
  category: 'chat',
  prRefs: [],
  retries: 0,
  hasEdits: false,
  assistantCalls: [detailCall],
}

const contracts = [
  [
    'models.modelCostsSchema',
    preEffectModelsContracts.modelCostsSchema,
    models.modelCostsSchema,
    costs,
    ['inputCostPerToken'],
  ],
  [
    'models.modelAliasSchema',
    preEffectModelsContracts.modelAliasSchema,
    models.modelAliasSchema,
    { model: 'a', aliasOf: 'b' },
    [],
  ],
  [
    'models.priceOverrideSchema',
    preEffectModelsContracts.priceOverrideSchema,
    models.priceOverrideSchema,
    { model: 'a', ...override },
    ['inputPricePerMillion'],
  ],
  [
    'models.modelsConfigSchema',
    preEffectModelsContracts.modelsConfigSchema,
    models.modelsConfigSchema,
    { aliases: [{ model: 'a', aliasOf: 'b' }], overrides: [{ model: 'a', ...override }] },
    ['overrides.0.inputPricePerMillion'],
  ],
  [
    'models.rowOverrideSchema',
    preEffectModelsContracts.rowOverrideSchema,
    models.rowOverrideSchema,
    override,
    ['inputPricePerMillion'],
  ],
  [
    'models.modelReportRowSchema',
    preEffectModelsContracts.modelReportRowSchema,
    models.modelReportRowSchema,
    modelRow,
    ['costUSD'],
  ],
  [
    'models.auditRowSchema',
    preEffectModelsContracts.auditRowSchema,
    models.auditRowSchema,
    auditRow,
    ['raw.inputTokens'],
  ],
  [
    'models.modelsPayloadSchema',
    preEffectModelsContracts.modelsPayloadSchema,
    models.modelsPayloadSchema,
    { byModel: [modelRow], byTask: [], audit: [auditRow] },
    ['byModel.0.costUSD'],
  ],
  [
    'views.providerRowSchema',
    preEffectViewsContracts.providerRowSchema,
    views.providerRowSchema,
    providerRow,
    ['cost'],
  ],
  [
    'views.dashboardViewsSchema',
    preEffectViewsContracts.dashboardViewsSchema,
    views.dashboardViewsSchema,
    {
      kpis: Object.fromEntries(
        [
          'totalCost',
          'totalEstimatedCost',
          'totalSavings',
          'totalProxiedCost',
          'totalCalls',
          'totalSessions',
          'totalProjects',
          'totalInputTokens',
          'totalOutputTokens',
          'totalCacheReadTokens',
          'totalCacheWriteTokens',
          'totalReasoningTokens',
        ].map(key => [key, 1]),
      ),
      costOverTime: [{ date: '2026-01-01', cost: 1 }],
      byProvider: [providerRow],
      byModel: [{ name: 'm', cost: 1, calls: 1 }],
      byProject: [{ name: 'p', cost: 1, calls: 1 }],
      byCategory: [{ name: 'c', cost: 1, turns: 1 }],
    },
    ['kpis.totalCost'],
  ],
  [
    'views.projectRowSchema',
    preEffectViewsContracts.projectRowSchema,
    views.projectRowSchema,
    {
      project: 'p',
      projectPath: '/p',
      cost: 1,
      calls: 2,
      sessions: 3,
      firstTimestamp: 'a',
      lastTimestamp: 'b',
    },
    ['cost'],
  ],
  [
    'views.sessionRowSchema',
    preEffectViewsContracts.sessionRowSchema,
    views.sessionRowSchema,
    {
      sessionId: 's',
      title: 't',
      project: 'p',
      provider: 'provider',
      models: ['m'],
      cost: 1,
      savingsUSD: 2,
      calls: 3,
      turns: 4,
      inputTokens: 5,
      outputTokens: 6,
      startedAt: 'a',
      endedAt: 'b',
    },
    ['cost'],
  ],
  [
    'views.skillRowSchema',
    preEffectViewsContracts.skillRowSchema,
    views.skillRowSchema,
    { name: 'n', turns: 1, cost: 2, savingsUSD: 3 },
    ['cost'],
  ],
  [
    'views.subagentRowSchema',
    preEffectViewsContracts.subagentRowSchema,
    views.subagentRowSchema,
    { name: 'n', calls: 1, cost: 2, savingsUSD: 3 },
    ['cost'],
  ],
  [
    'views.analyticalViewsSchema',
    preEffectViewsContracts.analyticalViewsSchema,
    views.analyticalViewsSchema,
    {
      providers: [providerRow],
      models: [{ name: 'm', cost: 1, calls: 1 }],
      categories: [{ name: 'c', cost: 1, turns: 1 }],
      skills: [{ name: 's', turns: 1, cost: 2, savingsUSD: 3 }],
      subagents: [{ name: 'a', calls: 1, cost: 2, savingsUSD: 3 }],
    },
    ['providers.0.cost'],
  ],
  [
    'views.searchHitSchema',
    preEffectViewsContracts.searchHitSchema,
    views.searchHitSchema,
    {
      sessionId: 's',
      project: 'p',
      provider: 'x',
      timestamp: 't',
      kind: 'message',
      snippet: 'text',
    },
    [],
  ],
  [
    'views.sessionDetailCallSchema',
    preEffectViewsContracts.sessionDetailCallSchema,
    views.sessionDetailCallSchema,
    detailCall,
    ['costUSD'],
  ],
  [
    'views.sessionDetailTurnSchema',
    preEffectViewsContracts.sessionDetailTurnSchema,
    views.sessionDetailTurnSchema,
    detailTurn,
    ['retries'],
  ],
  [
    'views.sessionDetailSchema',
    preEffectViewsContracts.sessionDetailSchema,
    views.sessionDetailSchema,
    {
      sessionId: 's',
      project: 'p',
      provider: 'x',
      title: 't',
      firstTimestamp: 'a',
      lastTimestamp: 'b',
      totalCostUSD: 1,
      totalEstimatedCostUSD: 2,
      totalSavingsUSD: 3,
      totalInputTokens: 4,
      totalOutputTokens: 5,
      totalCacheReadTokens: 6,
      totalCacheWriteTokens: 7,
      totalReasoningTokens: 8,
      apiCalls: 1,
      prLinks: [],
      modelBreakdown: { m: { calls: 1, costUSD: 2 } },
      turns: [detailTurn],
    },
    ['totalCostUSD'],
  ],
] as const

function withUnknownExtension(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  return { ...value, unknownExtension: { keptByInput: true } }
}

function setPath(value: unknown, path: readonly string[], replacement: unknown): unknown {
  const copy = structuredClone(value) as Record<string, unknown>
  let cursor: Record<string, unknown> | unknown[] = copy
  for (const part of path.slice(0, -1)) cursor = (cursor as Record<string, unknown>)[part] as Record<string, unknown>
  const leaf = path.at(-1)
  if (leaf !== undefined) (cursor as Record<string, unknown>)[leaf] = replacement
  return copy
}

describe('models and views Effect Schema parity', () => {
  it.each(contracts)(
    '%s preserves old verdicts, decoded outputs, and unknown-key stripping',
    (_name, oldSchema, newSchema, sample, numericPath) => {
      const extended = withUnknownExtension(sample)
      assertParity(oldSchema, newSchema, extended)
      const invalid = numericPath.length ? setPath(sample, numericPath, Number.NaN) : { invalid: true }
      assertParity(oldSchema, newSchema, invalid)
      if (numericPath.length) {
        assertParity(oldSchema, newSchema, setPath(sample, numericPath, Number.POSITIVE_INFINITY))
        assertParity(oldSchema, newSchema, setPath(sample, numericPath, Number.NEGATIVE_INFINITY))
      }
    },
  )

  it('preserves optional undefined output keys, omitted keys, and rejects null for optional fields', () => {
    const project = {
      project: 'p',
      projectPath: '/p',
      repoUrl: undefined,
      cost: 1,
      calls: 2,
      sessions: 3,
      firstTimestamp: 'a',
      lastTimestamp: 'b',
    }
    const report = { ...modelRow, sourceModels: undefined, override: undefined }
    const cases = [
      [preEffectModelsContracts.modelReportRowSchema, models.modelReportRowSchema, report],
      [
        preEffectModelsContracts.auditRowSchema,
        models.auditRowSchema,
        { ...auditRow, aliasOf: undefined, override: undefined },
      ],
      [preEffectViewsContracts.projectRowSchema, views.projectRowSchema, project],
      [
        preEffectViewsContracts.sessionRowSchema,
        views.sessionRowSchema,
        {
          sessionId: 's',
          title: 't',
          project: 'p',
          provider: 'x',
          models: [],
          modelProvenance: undefined,
          cost: 1,
          savingsUSD: 2,
          calls: 3,
          turns: 4,
          inputTokens: 5,
          outputTokens: 6,
          startedAt: 'a',
          endedAt: 'b',
        },
      ],
      [
        preEffectViewsContracts.sessionDetailCallSchema,
        views.sessionDetailCallSchema,
        {
          ...detailCall,
          isEstimated: undefined,
          savingsUSD: undefined,
        },
      ],
      [
        preEffectViewsContracts.sessionDetailTurnSchema,
        views.sessionDetailTurnSchema,
        { ...detailTurn, gitBranch: undefined },
      ],
      [
        preEffectViewsContracts.sessionDetailSchema,
        views.sessionDetailSchema,
        {
          sessionId: 's',
          project: 'p',
          provider: 'x',
          title: 't',
          workingDirectory: undefined,
          firstTimestamp: 'a',
          lastTimestamp: 'b',
          totalCostUSD: 1,
          totalEstimatedCostUSD: 2,
          totalSavingsUSD: 3,
          totalInputTokens: 4,
          totalOutputTokens: 5,
          totalCacheReadTokens: 6,
          totalCacheWriteTokens: 7,
          totalReasoningTokens: 8,
          apiCalls: 1,
          prLinks: [],
          modelBreakdown: {},
          turns: [],
        },
      ],
    ] as const
    for (const [legacy, current, value] of cases) assertParity(legacy, current, value)

    assertParity(preEffectViewsContracts.projectRowSchema, views.projectRowSchema, { ...project, repoUrl: null })
    assertParity(preEffectModelsContracts.modelReportRowSchema, models.modelReportRowSchema, {
      ...report,
      sourceModels: null,
    })
  })

  it('keeps validated collection outputs mutable for existing consumers', () => {
    const decoded = Schema.decodeUnknownSync(models.modelsPayloadSchema)({
      byModel: [{ ...modelRow, sourceModels: ['source'] }],
      byTask: [],
      audit: [auditRow],
    })
    expect(Array.isArray(decoded.byModel)).toBe(true)
    expect(Array.isArray(decoded.byModel[0]?.sourceModels)).toBe(true)
    const row = decoded.byModel[0]
    if (!row?.sourceModels) throw new Error('fixture must contain model provenance')
    row.model = 'updated-model'
    row.sourceModels.push('another-source')
    expect(decoded.byModel[0]?.model).toBe('updated-model')
    expect(decoded.byModel[0]?.sourceModels).toEqual(['source', 'another-source'])
    const sessions = Schema.decodeUnknownSync(Schema.mutable(Schema.Array(views.sessionRowSchema)))([])
    expect(Array.isArray(sessions)).toBe(true)
  })
})
