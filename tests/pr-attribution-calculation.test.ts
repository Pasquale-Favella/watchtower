import { describe, expect, it } from 'vitest'

import { allocateEven, buildPrAttribution } from '../src/main/pipeline/pr-attribution.js'
import { capturePricingCatalogue } from '../src/main/pipeline/pricing-calculation.js'
import type { ClassifiedTurn, ParsedApiCall, SessionSummary, TaskCategory } from '../src/main/pipeline/types.js'

const PR_A = 'https://github.com/acme/repo/pull/12'
const PR_B = 'https://github.com/acme/repo/pull/34'
const PR_C = 'https://github.com/acme/repo/pull/56'
function emptyCategoryBreakdown(): SessionSummary['categoryBreakdown'] {
  const zero = () => ({ turns: 0, costUSD: 0, savingsUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 })
  return {
    coding: zero(),
    debugging: zero(),
    feature: zero(),
    refactoring: zero(),
    testing: zero(),
    exploration: zero(),
    planning: zero(),
    delegation: zero(),
    git: zero(),
    'build/deploy': zero(),
    conversation: zero(),
    brainstorming: zero(),
    general: zero(),
  }
}

function call(costUSD: number, timestamp: string, model = 'demo-model'): ParsedApiCall {
  return {
    provider: 'claude',
    model,
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
    },
    costUSD,
    tools: [],
    mcpTools: [],
    skills: [],
    subagentTypes: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard',
    timestamp,
    bashCommands: [],
    deduplicationKey: `${timestamp}:${model}`,
  }
}

function turn(
  timestamp: string,
  calls: ParsedApiCall[],
  input: { prRefs?: string[]; category?: TaskCategory; spawnToolUseIds?: string[] } = {},
): ClassifiedTurn {
  return {
    userMessage: 'work',
    assistantCalls: calls,
    timestamp,
    sessionId: 'session',
    category: input.category ?? 'coding',
    retries: 0,
    hasEdits: true,
    ...(input.prRefs ? { prRefs: input.prRefs } : {}),
    ...(input.spawnToolUseIds ? { spawnToolUseIds: input.spawnToolUseIds } : {}),
  }
}

function session(input: {
  id: string
  turns: ClassifiedTurn[]
  prLinks?: string[]
  agentId?: string
  parentSessionId?: string
  agentSpawnLinks?: Record<string, string>
  spawnPrSets?: Record<string, string[]>
}): SessionSummary {
  const calls = input.turns.flatMap(item => item.assistantCalls)
  const totalCostUSD = calls.reduce((total, item) => total + item.costUSD, 0)
  const firstTimestamp = input.turns[0]?.assistantCalls[0]?.timestamp ?? ''
  const lastTimestamp = input.turns.at(-1)?.assistantCalls.at(-1)?.timestamp ?? firstTimestamp
  return {
    sessionId: input.id,
    project: 'demo-project',
    firstTimestamp,
    lastTimestamp,
    totalCostUSD,
    totalSavingsUSD: 0,
    totalInputTokens: calls.reduce((total, item) => total + item.usage.inputTokens, 0),
    totalOutputTokens: calls.reduce((total, item) => total + item.usage.outputTokens, 0),
    totalReasoningTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: calls.length,
    turns: input.turns,
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: emptyCategoryBreakdown(),
    skillBreakdown: {},
    subagentBreakdown: {},
    ...(input.prLinks ? { prLinks: input.prLinks } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
    ...(input.agentSpawnLinks ? { agentSpawnLinks: input.agentSpawnLinks } : {}),
    ...(input.spawnPrSets ? { spawnPrSets: input.spawnPrSets } : {}),
  }
}

const catalogue = capturePricingCatalogue({
  prices: new Map(),
  overrides: new Map(),
  builtinAliases: {},
  userAliases: {},
  tiers: [],
  routedSegments: new Set(),
})

describe('Pull Requests attribution calculation', () => {
  it('allocates multi-PR integer calls without overcounting and keeps legacy estimates category-free', () => {
    expect(allocateEven(1, 2)).toEqual([1, 0])
    expect(allocateEven(5, 2)).toEqual([3, 2])

    const timestamp = '2026-07-01T12:00:00.000Z'
    const multiPr = session({
      id: 'multi-pr',
      prLinks: [PR_A, PR_B],
      turns: [turn(timestamp, [call(3, timestamp)], { prRefs: [PR_A, PR_B], category: 'feature' })],
    })
    const legacy = session({
      id: 'legacy',
      prLinks: [PR_C],
      turns: [turn(timestamp, [call(4, timestamp)])],
    })

    const result = buildPrAttribution([multiPr, legacy], [], catalogue)
    const rows = new Map(result.rows.map(row => [row.url, row]))

    expect(rows.get(PR_A)).toMatchObject({ cost: 1.5, calls: 1, approx: false })
    expect(rows.get(PR_A)?.categories).toMatchObject([{ name: 'Feature Dev', cost: 1.5 }])
    expect(rows.get(PR_B)).toMatchObject({ cost: 1.5, calls: 0, approx: false })
    expect(rows.get(PR_C)).toMatchObject({ cost: 4, calls: 1, approx: true })
    expect(rows.get(PR_C)?.categories).toBeUndefined()
    expect(result.totals).toEqual({
      cost: 7,
      sessions: 2,
      subagentSessions: 0,
      attributedCost: 7,
      unattributedCost: 0,
    })
  })

  it('folds a linked sidechain into the PR of its parent spawn turn', () => {
    const parentTime = '2026-07-01T12:00:00.000Z'
    const childTime = '2026-07-01T12:01:00.000Z'
    const parent = session({
      id: 'parent',
      prLinks: [PR_A],
      turns: [turn(parentTime, [call(1, parentTime)], { prRefs: [PR_A], spawnToolUseIds: ['tool-use-1'] })],
      agentSpawnLinks: { 'agent-1': 'tool-use-1' },
      spawnPrSets: { 'tool-use-1': [PR_A] },
    })
    const child = session({
      id: 'child-session',
      agentId: 'agent-1',
      parentSessionId: 'parent',
      turns: [turn(childTime, [call(2, childTime)])],
    })

    const result = buildPrAttribution([parent, child], [], catalogue)

    expect(result.rows).toMatchObject([{ url: PR_A, cost: 3, calls: 2, sessions: 1 }])
    expect(result.totals).toEqual({
      cost: 3,
      sessions: 1,
      subagentSessions: 1,
      attributedCost: 3,
      unattributedCost: 0,
    })
  })
})
