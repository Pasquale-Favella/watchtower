import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

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

function assertDecoded(schema: Schema.ConstraintDecoder<unknown>, input: unknown, expected: unknown): void {
  const result = Schema.decodeUnknownResult(schema)(input)
  expect(result._tag).toBe('Success')
  if (result._tag === 'Success') expect(result.success).toStrictEqual(expected)
}

function assertRejected(schema: Schema.ConstraintDecoder<unknown>, input: unknown): void {
  expect(Schema.decodeUnknownResult(schema)(input)._tag).toBe('Failure')
}

describe('internal contracts retain recorded acceptance and decoded values', () => {
  it('matches tool call and finite token usage acceptance and decoded values', () => {
    assertDecoded(toolCallSchema, { tool: 'Edit', file: 'src/a.ts', future: true }, { tool: 'Edit', file: 'src/a.ts' })
    assertRejected(toolCallSchema, { tool: 'Edit', file: 42 })
    const usage = {
      inputTokens: 1,
      outputTokens: 2,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
    }
    assertDecoded(tokenUsageSchema, { ...usage, future: 'stripped' }, usage)
    assertRejected(tokenUsageSchema, { ...usage, inputTokens: Number.POSITIVE_INFINITY })
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
    }
    assertDecoded(parsedProviderCallSchema, { ...call, futureProviderField: true }, call)
    assertRejected(parsedProviderCallSchema, { ...call, costUSD: Number.NaN })
    assertRejected(parsedProviderCallSchema, { ...call, speed: 'turbo' })

    const source = {
      path: '/demo.jsonl',
      project: 'demo',
      provider: 'demo',
      sourceKind: 'claude-config',
      future: true,
    }
    assertDecoded(sessionSourceSchema, source, {
      path: '/demo.jsonl',
      project: 'demo',
      provider: 'demo',
      sourceKind: 'claude-config',
    })
    assertRejected(sessionSourceSchema, { ...source, sourceKind: 'desktop' })
    assertDecoded(probeRootSchema, { path: '/demo', label: 'demo', future: true }, { path: '/demo', label: 'demo' })
    assertRejected(probeRootSchema, { path: 4, label: 'demo' })
  })

  it('matches every cache schema, including finite numbers, optional values and nested stripping', () => {
    const expectedFile = buildFixtureCachedFile()
    const expectedTurn = expectedFile.turns[0]
    const expectedCall = expectedTurn?.calls[0]
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

    assertDecoded(cachedUsageSchema, usage, expectedCall?.usage)
    assertRejected(cachedUsageSchema, { ...usage, inputTokens: Number.NaN })
    assertDecoded(cachedCallSchema, call, expectedCall)
    assertRejected(cachedCallSchema, { ...call, costUSD: null })
    assertDecoded(cachedTurnSchema, turn, expectedTurn)
    assertDecoded(fileFingerprintSchema, file['fingerprint'], expectedFile.fingerprint)
    assertRejected(fileFingerprintSchema, {
      ...(file['fingerprint'] as object),
      ino: Number.NEGATIVE_INFINITY,
    })
    assertDecoded(cachedFileSchema, file, expectedFile)
    assertDecoded(providerSectionSchema, cache.providers.demo, {
      envFingerprint: 'x',
      files: { '/demo': expectedFile },
      durable: false,
      prEvidenceV1: true,
    })
    assertDecoded(sessionCacheSchema, cache, {
      version: 7,
      providers: {
        demo: { envFingerprint: 'x', files: { '/demo': expectedFile }, durable: false, prEvidenceV1: true },
      },
    })
    assertRejected(cachedFileSchema, {
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
    for (const verdict of ['new', 'appended', 'modified', 'unchanged']) {
      assertDecoded(fileVerdictSchema, verdict, verdict)
    }
    assertRejected(fileVerdictSchema, 'other')

    const cachedFile = buildFixtureCachedFile()
    const input = {
      provider: 'demo',
      envFingerprint: 'env-1',
      filePath: '/demo.jsonl',
      verdict: 'new',
      cachedFile,
      future: true,
    }
    assertDecoded(portInputSchema, input, {
      provider: 'demo',
      envFingerprint: 'env-1',
      filePath: '/demo.jsonl',
      verdict: 'new',
      cachedFile,
    })
    assertRejected(portInputSchema, { ...input, verdict: 'bad' })
    assertRejected(portInputSchema, { ...input, repoUrl: null })

    assertDecoded(mappedSourceSchema, { ...validSource, future: true }, validSource)
    assertRejected(mappedSourceSchema, {
      ...validSource,
      fingerprint: { ...validSource.fingerprint, ino: Number.NaN },
    })
    assertDecoded(mappedSessionSchema, { ...validMappedSession, future: true }, validMappedSession)
    assertRejected(mappedSessionSchema, { ...validMappedSession, project: undefined })
    assertDecoded(mappedTurnSchema, { ...validMappedTurn, future: true }, validMappedTurn)
    assertRejected(mappedTurnSchema, { ...validMappedTurn, turnIndex: Number.POSITIVE_INFINITY })
    assertDecoded(mappedCallSchema, { ...validMappedCall, future: true }, validMappedCall)
    assertRejected(mappedCallSchema, { ...validMappedCall, baseCostUSD: Number.POSITIVE_INFINITY })
    assertDecoded(mappedFileSchema, { ...validMappedFile, future: true }, validMappedFile)

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
    assertDecoded(scanDeltaSchema, scanDelta, {
      provider: 'demo',
      envFingerprint: 'env-1',
      filePath: '/demo.jsonl',
      verdict: 'modified',
      cachedFile: scanDelta.cachedFile,
      project: 'demo',
    })
    assertRejected(scanDeltaSchema, { ...scanDelta, verdict: 'unchanged-ish' })
    assertRejected(scanDeltaSchema, { ...scanDelta, durable: null })
  })
})
