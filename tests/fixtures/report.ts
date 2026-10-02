import type { ProjectSummary, SessionSummary, TaskCategory, TokenUsage } from '../../src/main/pipeline/types.js'

const usage: TokenUsage = {
  inputTokens: 100,
  outputTokens: 50,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 20,
  cachedInputTokens: 0,
  reasoningTokens: 5,
  webSearchRequests: 0,
}

const CATEGORIES: TaskCategory[] = [
  'coding',
  'debugging',
  'feature',
  'refactoring',
  'testing',
  'exploration',
  'planning',
  'delegation',
  'git',
  'build/deploy',
  'conversation',
  'brainstorming',
  'general',
]

function zeroedCategoryBreakdown(): SessionSummary['categoryBreakdown'] {
  const empty = { turns: 0, costUSD: 0, savingsUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 }
  return Object.fromEntries(CATEGORIES.map(category => [category, { ...empty }])) as SessionSummary['categoryBreakdown']
}

function buildSession(index: number): SessionSummary {
  return {
    sessionId: `sess-${index}`,
    project: 'demo-project',
    firstTimestamp: '2026-07-01T09:00:00.000Z',
    lastTimestamp: '2026-07-01T10:00:00.000Z',
    totalCostUSD: 0.42,
    totalSavingsUSD: 0,
    totalEstimatedCostUSD: 0,
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalReasoningTokens: 5,
    totalCacheReadTokens: 20,
    totalCacheWriteTokens: 0,
    subagentBreakdown: {},
    apiCalls: 1,
    turns: [
      {
        userMessage: `prompt for ${index}`,
        assistantCalls: [
          {
            provider: 'opencode',
            model: 'demo-model',
            usage,
            costUSD: 0.42,
            tools: ['edit'],
            mcpTools: [],
            skills: [],
            subagentTypes: [],
            hasAgentSpawn: false,
            hasPlanMode: false,
            speed: 'standard',
            timestamp: '2026-07-01T10:00:00.000Z',
            bashCommands: ['ls'],
            deduplicationKey: `dedup-${index}`,
          },
        ],
        timestamp: '2026-07-01T10:00:00.000Z',
        sessionId: `sess-${index}`,
        category: 'coding',
        retries: 0,
        hasEdits: true,
      },
    ],
    modelBreakdown: {
      'demo-model': { calls: 1, costUSD: 0.42, tokens: usage, savingsUSD: 0 },
    },
    toolBreakdown: { bash: { calls: 1 } },
    mcpBreakdown: {},
    bashBreakdown: { ls: { calls: 1 } },
    categoryBreakdown: {
      ...zeroedCategoryBreakdown(),
      coding: { turns: 1, costUSD: 0.42, savingsUSD: 0, retries: 0, editTurns: 1, oneShotTurns: 0 },
    },
    skillBreakdown: {},
  }
}

export function buildFixtureReport(): ProjectSummary[] {
  const session = buildSession(0)
  return [
    {
      project: 'demo',
      projectPath: '/tmp/demo',
      sessions: [session],
      totalCostUSD: session.totalCostUSD,
      totalSavingsUSD: 0,
      totalEstimatedCostUSD: 0,
      totalApiCalls: 1,
      totalProxiedCostUSD: 0,
    },
  ]
}
