import type { CachedCall, CachedFile, CachedTurn } from '../../src/main/pipeline/session-cache.js'

export const FIXTURE_SOURCE_PATH = '/Users/demo/.local/share/opencode/demo-project/sess-0.jsonl'

export function buildFixtureCachedFile(overrides: Partial<CachedFile> = {}): CachedFile {
  return {
    fingerprint: { dev: 42, ino: 4242, mtimeMs: 1_751_300_000_000, sizeBytes: 4096 },
    canonicalCwd: '/workspace/demo-project',
    canonicalProjectName: 'demo-project',
    mcpInventory: [],
    title: 'Refactor the auth module',
    turns: [buildFixtureCachedTurn(0, 'Refactor the auth module')],
    ...overrides,
  }
}

export function buildFixtureCachedTurn(index: number, userMessage: string, overrides: Partial<CachedTurn> = {}): CachedTurn {
  return {
    timestamp: turnTimestamp(index),
    sessionId: 'sess-0',
    userMessage,
    calls: [buildFixtureCachedCall(index)],
    ...overrides,
  }
}

export function buildFixtureCachedCall(index: number): CachedCall {
  return {
    provider: 'opencode',
    model: 'demo-model',
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 20,
      cachedInputTokens: 0,
      reasoningTokens: 5,
      webSearchRequests: 0,
      cacheCreationOneHourTokens: 0,
    },
    costUSD: 0.42,
    speed: 'standard',
    timestamp: turnTimestamp(index),
    tools: ['Edit'],
    bashCommands: [],
    skills: [],
    subagentTypes: [],
    deduplicationKey: `call-${index + 1}`,
  }
}

function turnTimestamp(index: number): string {
  return index === 0 ? '2026-07-01T09:00:00.000Z' : `2026-07-01T09:${10 + index}:00.000Z`
}
