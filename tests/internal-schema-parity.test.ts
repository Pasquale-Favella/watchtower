import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { tokenUsageSchema, toolCallSchema } from '../src/shared/schemas/pipeline.js'
import {
  fileVerdictSchema,
  mappedCallSchema,
  mappedFileSchema,
  mappedSessionSchema,
  mappedSourceSchema,
  mappedTurnSchema,
  portInputSchema,
} from '../src/shared/schemas/port.js'
import { parsedProviderCallSchema, probeRootSchema, sessionSourceSchema } from '../src/shared/schemas/providers.js'
import { scanDeltaSchema } from '../src/shared/schemas/scan.js'
import {
  cachedCallSchema,
  cachedFileSchema,
  cachedTurnSchema,
  cachedUsageSchema,
  fileFingerprintSchema,
  providerSectionSchema,
  sessionCacheSchema,
} from '../src/shared/schemas/session-cache.js'
import { buildFixtureCachedFile } from './fixtures/cached-file.js'

// Frozen pre-migration schemas: this corpus records the old verdict and decoded
// output while each internal contract moves to Effect Schema.
const zToolCallSchema = z.object({
  tool: z.string(),
  file: z.string().optional(),
  command: z.string().optional(),
})
const zTokenUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  cachedInputTokens: z.number(),
  reasoningTokens: z.number(),
  webSearchRequests: z.number(),
})
const zParsedProviderCallSchema = z.object({
  provider: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  cachedInputTokens: z.number(),
  reasoningTokens: z.number(),
  webSearchRequests: z.number(),
  costUSD: z.number(),
  costIsEstimated: z.boolean().optional(),
  tools: z.array(z.string()),
  bashCommands: z.array(z.string()),
  subagentTypes: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  timestamp: z.string(),
  speed: z.enum(['standard', 'fast']),
  deduplicationKey: z.string(),
  locAdded: z.number().optional(),
  locRemoved: z.number().optional(),
  editFailed: z.number().optional(),
  turnId: z.string().optional(),
  toolSequence: z.array(z.array(zToolCallSchema)).optional(),
  userMessage: z.string(),
  assistantText: z.string().optional(),
  sessionId: z.string(),
  project: z.string().optional(),
  projectPath: z.string().optional(),
  workingDirectory: z.string().optional(),
})
const zSessionSourceSchema = z.object({
  path: z.string(),
  project: z.string(),
  provider: z.string(),
  sourceId: z.string().optional(),
  sourceLabel: z.string().optional(),
  sourcePath: z.string().optional(),
  sourceKind: z.enum(['claude-config', 'claude-desktop']).optional(),
  workingDirectory: z.string().optional(),
})
const zProbeRootSchema = z.object({ path: z.string(), label: z.string() })
const zFileFingerprintSchema = z.object({
  dev: z.number(),
  ino: z.number(),
  mtimeMs: z.number(),
  sizeBytes: z.number(),
})
const zCachedUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  cachedInputTokens: z.number(),
  reasoningTokens: z.number(),
  webSearchRequests: z.number(),
  cacheCreationOneHourTokens: z.number(),
})
const zCachedCallSchema = z.object({
  provider: z.string(),
  model: z.string(),
  usage: zCachedUsageSchema,
  costUSD: z.number().optional(),
  isEstimated: z.boolean().optional(),
  speed: z.enum(['standard', 'fast']),
  timestamp: z.string(),
  tools: z.array(z.string()),
  bashCommands: z.array(z.string()),
  skills: z.array(z.string()),
  subagentTypes: z.array(z.string()).optional(),
  deduplicationKey: z.string(),
  project: z.string().optional(),
  projectPath: z.string().optional(),
  workingDirectory: z.string().optional(),
  toolSequence: z.array(z.array(zToolCallSchema)).optional(),
  locAdded: z.number().optional(),
  locRemoved: z.number().optional(),
  interrupted: z.boolean().optional(),
  userModified: z.boolean().optional(),
  toolErrors: z.number().optional(),
  editFailed: z.number().optional(),
})
const zCachedTurnSchema = z.object({
  timestamp: z.string(),
  sessionId: z.string(),
  userMessage: z.string(),
  calls: z.array(zCachedCallSchema),
  gitBranch: z.string().optional(),
  prRefs: z.array(z.string()).optional(),
  spawnToolUseIds: z.array(z.string()).optional(),
})
const zCachedFileSchema = z.object({
  fingerprint: zFileFingerprintSchema,
  lastCompleteLineOffset: z.number().optional(),
  canonicalCwd: z.string().optional(),
  workingDirectory: z.string().optional(),
  canonicalProjectName: z.string().optional(),
  mcpInventory: z.array(z.string()),
  turns: z.array(zCachedTurnSchema),
  agentType: z.string().optional(),
  failed: z.boolean().optional(),
  title: z.string().optional(),
  prLinks: z.array(z.string()).optional(),
  isSidechain: z.boolean().optional(),
  parentSessionId: z.string().optional(),
  agentSpawnLinks: z.record(z.string(), z.string()).optional(),
  ambiguousSpawnAgentIds: z.array(z.string()).optional(),
})
const zProviderSectionSchema = z.object({
  envFingerprint: z.string(),
  files: z.record(z.string(), zCachedFileSchema),
  durable: z.boolean().optional(),
  prEvidenceV1: z.boolean().optional(),
})
const zSessionCacheSchema = z.object({
  version: z.number(),
  providers: z.record(z.string(), zProviderSectionSchema),
  complete: z.boolean().optional(),
})
const zFileVerdictSchema = z.enum(['new', 'appended', 'modified', 'unchanged'])
const zPortInputSchema = z.object({
  provider: z.string(),
  envFingerprint: z.string(),
  filePath: z.string(),
  verdict: zFileVerdictSchema,
  cachedFile: zCachedFileSchema,
  repoUrl: z.string().optional(),
  durable: z.boolean().optional(),
  project: z.string().optional(),
  workingDirectory: z.string().optional(),
})
const zMappedSourceSchema = z.object({
  provider: z.string(),
  envFingerprint: z.string(),
  filePath: z.string(),
  repoUrl: z.string().optional(),
  fingerprint: zFileFingerprintSchema,
})
const zMappedSessionSchema = z.object({
  sessionId: z.string(),
  project: z.string().nullable(),
  projectPath: z.string().nullable(),
  workingDirectory: z.string().nullable(),
  canonicalProject: z.string().nullable(),
  canonicalCwd: z.string().nullable(),
  agentType: z.string().nullable(),
  title: z.string().nullable(),
  prLinks: z.array(z.string()),
  isSidechain: z.boolean(),
  parentSessionId: z.string().nullable(),
  agentSpawnLinks: z.record(z.string(), z.string()),
  mcpInventory: z.array(z.string()),
  everHadBranch: z.boolean(),
  ambiguousSpawnAgentIds: z.array(z.string()),
})
const zMappedTurnSchema = z.object({
  sessionId: z.string(),
  turnIndex: z.number(),
  timestamp: z.string(),
  userMessage: z.string(),
  gitBranch: z.string().nullable(),
  prRefs: z.array(z.string()),
  spawnToolUseIds: z.array(z.string()),
  category: z.string(),
  subCategory: z.string().nullable(),
  retries: z.number(),
  hasEdits: z.boolean(),
})
const zMappedCallSchema = z.object({
  sessionId: z.string(),
  turnIndex: z.number(),
  callIndex: z.number(),
  dedupKey: z.string().nullable(),
  provider: z.string(),
  model: z.string(),
  timestamp: z.string(),
  speed: z.enum(['standard', 'fast']),
  project: z.string().nullable(),
  projectPath: z.string().nullable(),
  workingDirectory: z.string().nullable(),
  baseCostUSD: z.number(),
  isEstimated: z.boolean(),
  savingsUSD: z.number(),
  savingsBaselineModel: z.string().nullable(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  cachedInputTokens: z.number(),
  reasoningTokens: z.number(),
  webSearchRequests: z.number(),
  cacheCreationOneHourTokens: z.number(),
  agentType: z.string().nullable(),
  tools: z.array(z.string()),
  mcpTools: z.array(z.string()),
  skills: z.array(z.string()),
  subagentTypes: z.array(z.string()),
  bashCommands: z.array(z.string()),
  toolSequence: z.array(z.array(zToolCallSchema)),
  locAdded: z.number().nullable(),
  locRemoved: z.number().nullable(),
  interrupted: z.boolean(),
  userModified: z.boolean(),
  toolErrors: z.number(),
  editFailed: z.number(),
})
const zMappedFileSchema = z.object({
  source: zMappedSourceSchema,
  session: zMappedSessionSchema,
  turns: z.array(zMappedTurnSchema),
  calls: z.array(zMappedCallSchema),
})
const zScanDeltaSchema = z.object({
  provider: z.string(),
  envFingerprint: z.string(),
  filePath: z.string(),
  verdict: zFileVerdictSchema,
  cachedFile: zCachedFileSchema,
  durable: z.boolean().optional(),
  project: z.string().optional(),
  workingDirectory: z.string().optional(),
})

const validSource = {
  provider: 'demo',
  envFingerprint: 'env-1',
  filePath: '/demo.jsonl',
  fingerprint: { dev: 1, ino: 2, mtimeMs: 3, sizeBytes: 4 },
}
const validMappedSession = {
  sessionId: 'session-1',
  project: null,
  projectPath: null,
  workingDirectory: null,
  canonicalProject: null,
  canonicalCwd: null,
  agentType: null,
  title: null,
  prLinks: [],
  isSidechain: false,
  parentSessionId: null,
  agentSpawnLinks: {},
  mcpInventory: [],
  everHadBranch: false,
  ambiguousSpawnAgentIds: [],
}
const validMappedTurn = {
  sessionId: 'session-1',
  turnIndex: 0,
  timestamp: '2026-07-01T09:00:00.000Z',
  userMessage: 'work',
  gitBranch: null,
  prRefs: [],
  spawnToolUseIds: [],
  category: 'implementation',
  subCategory: null,
  retries: 0,
  hasEdits: false,
}
const validMappedCall = {
  sessionId: 'session-1',
  turnIndex: 0,
  callIndex: 0,
  dedupKey: null,
  provider: 'demo',
  model: 'demo-model',
  timestamp: '2026-07-01T09:00:00.000Z',
  speed: 'standard' as const,
  project: null,
  projectPath: null,
  workingDirectory: null,
  baseCostUSD: 1,
  isEstimated: false,
  savingsUSD: 0,
  savingsBaselineModel: null,
  inputTokens: 1,
  outputTokens: 2,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
  webSearchRequests: 0,
  cacheCreationOneHourTokens: 0,
  agentType: null,
  tools: [],
  mcpTools: [],
  skills: [],
  subagentTypes: [],
  bashCommands: [],
  toolSequence: [[{ tool: 'Edit' }]],
  locAdded: null,
  locRemoved: null,
  interrupted: false,
  userModified: false,
  toolErrors: 0,
  editFailed: 0,
}
const validMappedFile = {
  source: validSource,
  session: validMappedSession,
  turns: [validMappedTurn],
  calls: [validMappedCall],
}

function compare(schema: z.ZodType, effectSchema: Schema.ConstraintDecoder<unknown>, input: unknown) {
  const before = schema.safeParse(input)
  const after = Schema.decodeUnknownResult(effectSchema)(input)
  expect(after._tag === 'Success').toBe(before.success)
  if (before.success && after._tag === 'Success') expect(after.success).toEqual(before.data)
}

describe('internal contract parity: frozen Zod to Effect Schema', () => {
  it('matches tool call and finite token usage acceptance and decoded values', () => {
    compare(zToolCallSchema, toolCallSchema, { tool: 'Edit', file: 'src/a.ts', future: true })
    compare(zToolCallSchema, toolCallSchema, { tool: 'Edit', file: 42 })
    compare(zTokenUsageSchema, tokenUsageSchema, {
      inputTokens: 1,
      outputTokens: 2,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      future: 'stripped',
    })
    compare(zTokenUsageSchema, tokenUsageSchema, {
      inputTokens: Number.POSITIVE_INFINITY,
      outputTokens: 2,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
    })
  })

  it('matches provider extraction behavior for unknown keys, optional fields and invalid declared values', () => {
    const call = {
      provider: 'demo',
      model: 'demo-model',
      inputTokens: 1,
      outputTokens: 2,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costUSD: 0,
      tools: [],
      bashCommands: [],
      timestamp: '2026-07-01T09:00:00.000Z',
      speed: 'standard',
      deduplicationKey: 'call-1',
      userMessage: 'work',
      sessionId: 'sess-1',
      futureProviderField: true,
    }
    compare(zParsedProviderCallSchema, parsedProviderCallSchema, call)
    compare(zParsedProviderCallSchema, parsedProviderCallSchema, { ...call, costUSD: Number.NaN })
    compare(zParsedProviderCallSchema, parsedProviderCallSchema, { ...call, speed: 'turbo' })

    const source = {
      path: '/demo.jsonl',
      project: 'demo',
      provider: 'demo',
      sourceKind: 'claude-config',
      future: true,
    }
    compare(zSessionSourceSchema, sessionSourceSchema, source)
    compare(zSessionSourceSchema, sessionSourceSchema, { ...source, sourceKind: 'desktop' })
    compare(zProbeRootSchema, probeRootSchema, { path: '/demo', label: 'demo', future: true })
    compare(zProbeRootSchema, probeRootSchema, { path: 4, label: 'demo' })
  })

  it('matches every cache schema, including finite numbers, optional values and nested stripping', () => {
    const file = buildFixtureCachedFile() as unknown as Record<string, unknown>
    file['futureFileField'] = true
    const turn = (file['turns'] as Array<Record<string, unknown>>)[0]
    if (!turn) throw new Error('fixture has no turn')
    turn['futureTurnField'] = true
    const call = (turn['calls'] as Array<Record<string, unknown>>)[0]
    if (!call) throw new Error('fixture turn has no call')
    call['futureCallField'] = true
    const usage = { ...(call['usage'] as Record<string, unknown>), futureUsageField: true }
    call['usage'] = usage
    const cache = {
      version: 7,
      providers: { demo: { envFingerprint: 'x', files: { '/demo': file }, durable: false, prEvidenceV1: true } },
      future: true,
    }

    compare(zCachedUsageSchema, cachedUsageSchema, usage)
    compare(zCachedUsageSchema, cachedUsageSchema, { ...usage, inputTokens: Number.NaN })
    compare(zCachedCallSchema, cachedCallSchema, call)
    compare(zCachedCallSchema, cachedCallSchema, { ...call, costUSD: null })
    compare(zCachedTurnSchema, cachedTurnSchema, turn)
    compare(zFileFingerprintSchema, fileFingerprintSchema, file['fingerprint'])
    compare(zFileFingerprintSchema, fileFingerprintSchema, {
      ...(file['fingerprint'] as object),
      ino: Number.NEGATIVE_INFINITY,
    })
    compare(zCachedFileSchema, cachedFileSchema, file)
    compare(zProviderSectionSchema, providerSectionSchema, cache.providers.demo)
    compare(zSessionCacheSchema, sessionCacheSchema, cache)
    compare(zCachedFileSchema, cachedFileSchema, {
      ...file,
      fingerprint: { ...(file['fingerprint'] as object), dev: Number.NEGATIVE_INFINITY },
    })

    const mutableCache = Schema.decodeUnknownSync(sessionCacheSchema)(cache)
    const mutableProvider = mutableCache.providers['demo']
    const mutableFile = mutableProvider?.files['/demo']
    const extraFile = buildFixtureCachedFile()
    const extraTurn = extraFile.turns[0]
    if (!mutableProvider || !mutableFile || !extraTurn) throw new Error('cache fixture failed to decode')
    mutableCache.complete = true
    mutableProvider.files['/another'] = extraFile
    mutableFile.turns.push(extraTurn)
    expect(mutableProvider.files['/another']?.turns).toHaveLength(1)
    expect(mutableFile.turns).toHaveLength(2)
  })

  it('matches all port schemas for decoded output, nullable fields, finite numbers and invalid values', () => {
    for (const verdict of ['new', 'appended', 'modified', 'unchanged', 'other']) {
      compare(zFileVerdictSchema, fileVerdictSchema, verdict)
    }

    const cachedFile = buildFixtureCachedFile()
    const input = {
      provider: 'demo',
      envFingerprint: 'env-1',
      filePath: '/demo.jsonl',
      verdict: 'new',
      cachedFile,
      future: true,
    }
    compare(zPortInputSchema, portInputSchema, input)
    compare(zPortInputSchema, portInputSchema, { ...input, verdict: 'bad' })
    compare(zPortInputSchema, portInputSchema, { ...input, repoUrl: null })

    compare(zMappedSourceSchema, mappedSourceSchema, { ...validSource, future: true })
    compare(zMappedSourceSchema, mappedSourceSchema, {
      ...validSource,
      fingerprint: { ...validSource.fingerprint, ino: Number.NaN },
    })
    compare(zMappedSessionSchema, mappedSessionSchema, { ...validMappedSession, future: true })
    compare(zMappedSessionSchema, mappedSessionSchema, { ...validMappedSession, project: undefined })
    compare(zMappedTurnSchema, mappedTurnSchema, { ...validMappedTurn, future: true })
    compare(zMappedTurnSchema, mappedTurnSchema, { ...validMappedTurn, turnIndex: Number.POSITIVE_INFINITY })
    compare(zMappedCallSchema, mappedCallSchema, { ...validMappedCall, future: true })
    compare(zMappedCallSchema, mappedCallSchema, { ...validMappedCall, baseCostUSD: Number.POSITIVE_INFINITY })
    compare(zMappedFileSchema, mappedFileSchema, { ...validMappedFile, future: true })

    const mutableMapping = Schema.decodeUnknownSync(mappedFileSchema)(validMappedFile)
    mutableMapping.turns.push(validMappedTurn)
    mutableMapping.calls.push(validMappedCall)
    mutableMapping.calls[0]?.toolSequence[0]?.push({ tool: 'Read' })
    expect(mutableMapping.turns).toHaveLength(2)
    expect(mutableMapping.calls[0]?.toolSequence[0]).toHaveLength(2)
  })

  it('matches the full scan delta contract and strips keys in both embedded and envelope objects', () => {
    const scanDelta = {
      provider: 'demo',
      envFingerprint: 'env-1',
      filePath: '/demo.jsonl',
      verdict: 'modified',
      cachedFile: buildFixtureCachedFile(),
      project: 'demo',
      future: true,
    }
    compare(zScanDeltaSchema, scanDeltaSchema, scanDelta)
    compare(zScanDeltaSchema, scanDeltaSchema, { ...scanDelta, verdict: 'unchanged-ish' })
    compare(zScanDeltaSchema, scanDeltaSchema, { ...scanDelta, durable: null })
  })
})
