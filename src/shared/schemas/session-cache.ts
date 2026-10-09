import * as Schema from 'effect/Schema'

import { toolCallSchema } from './pipeline.js'

const finiteNumber = Schema.Number.pipe(Schema.check(Schema.isFinite()))
const writable = Schema.mutableKey
const stringArray = Schema.mutable(Schema.Array(Schema.String))
const toolSequence = Schema.mutable(Schema.Array(Schema.mutable(Schema.Array(toolCallSchema))))
const stringRecord = Schema.Record(Schema.String, Schema.mutableKey(Schema.String))

/** Per-call token usage as persisted in the session cache. All eight counts are
 * present (cache writes default missing counts to 0). */
export const cachedUsageSchema = Schema.Struct({
  inputTokens: writable(finiteNumber),
  outputTokens: writable(finiteNumber),
  cacheCreationInputTokens: writable(finiteNumber),
  cacheReadInputTokens: writable(finiteNumber),
  cachedInputTokens: writable(finiteNumber),
  reasoningTokens: writable(finiteNumber),
  webSearchRequests: writable(finiteNumber),
  cacheCreationOneHourTokens: writable(finiteNumber),
})
export type CachedUsage = Schema.Schema.Type<typeof cachedUsageSchema>

const optionalNumber = Schema.optional(finiteNumber)
const optionalString = Schema.optional(Schema.String)
const optionalBoolean = Schema.optional(Schema.Boolean)

export const cachedCallSchema = Schema.Struct({
  provider: writable(Schema.String),
  model: writable(Schema.String),
  usage: writable(cachedUsageSchema),
  costUSD: writable(optionalNumber),
  isEstimated: writable(optionalBoolean),
  speed: writable(Schema.Literals(['standard', 'fast'])),
  timestamp: writable(Schema.String),
  tools: writable(stringArray),
  bashCommands: writable(stringArray),
  skills: writable(stringArray),
  subagentTypes: writable(Schema.optional(stringArray)),
  deduplicationKey: writable(Schema.String),
  project: writable(optionalString),
  projectPath: writable(optionalString),
  workingDirectory: writable(optionalString),
  toolSequence: writable(Schema.optional(toolSequence)),
  locAdded: writable(optionalNumber),
  locRemoved: writable(optionalNumber),
  interrupted: writable(optionalBoolean),
  userModified: writable(optionalBoolean),
  toolErrors: writable(optionalNumber),
  editFailed: writable(optionalNumber),
})
export type CachedCall = Schema.Schema.Type<typeof cachedCallSchema>

export const cachedTurnSchema = Schema.Struct({
  timestamp: writable(Schema.String),
  sessionId: writable(Schema.String),
  userMessage: writable(Schema.String),
  calls: writable(Schema.mutable(Schema.Array(cachedCallSchema))),
  gitBranch: writable(optionalString),
  prRefs: writable(Schema.optional(stringArray)),
  spawnToolUseIds: writable(Schema.optional(stringArray)),
})
export type CachedTurn = Schema.Schema.Type<typeof cachedTurnSchema>

/** The cache's on-disk provenance fingerprint — numeric (stat() output). The
 * ledger's read-back fingerprint is a distinct string-flavoured shape (NTFS
 * inodes exceed 2^53, so dev/ino are cast to TEXT at read-back). */
export const fileFingerprintSchema = Schema.Struct({
  dev: writable(finiteNumber),
  ino: writable(finiteNumber),
  mtimeMs: writable(finiteNumber),
  sizeBytes: writable(finiteNumber),
})
export type FileFingerprint = Schema.Schema.Type<typeof fileFingerprintSchema>

export const cachedFileSchema = Schema.Struct({
  fingerprint: writable(fileFingerprintSchema),
  lastCompleteLineOffset: writable(optionalNumber),
  canonicalCwd: writable(optionalString),
  workingDirectory: writable(optionalString),
  canonicalProjectName: writable(optionalString),
  mcpInventory: writable(stringArray),
  turns: writable(Schema.mutable(Schema.Array(cachedTurnSchema))),
  agentType: writable(optionalString),
  failed: writable(optionalBoolean),
  title: writable(optionalString),
  prLinks: writable(Schema.optional(stringArray)),
  isSidechain: writable(optionalBoolean),
  parentSessionId: writable(optionalString),
  agentSpawnLinks: writable(Schema.optional(stringRecord)),
  ambiguousSpawnAgentIds: writable(Schema.optional(stringArray)),
})
export type CachedFile = Schema.Schema.Type<typeof cachedFileSchema>

export const providerSectionSchema = Schema.Struct({
  envFingerprint: writable(Schema.String),
  files: writable(Schema.Record(Schema.String, writable(cachedFileSchema))),
  durable: writable(Schema.optional(Schema.Boolean)),
  // One-shot PR-evidence re-parse marker: absent on caches written before the
  // provider-neutral PR detection (broad URL shapes + assistant/tool text).
  // While absent, the next write-mode scan fully re-parses every present
  // source once (verdict `modified`, so the ledger clean-replaces instead of
  // duplicating) and then stamps the marker. Optional so old caches validate.
  prEvidenceV1: writable(Schema.optional(Schema.Boolean)),
})
export type ProviderSection = Schema.Schema.Type<typeof providerSectionSchema>

export const sessionCacheSchema = Schema.Struct({
  version: writable(finiteNumber),
  providers: writable(Schema.Record(Schema.String, writable(providerSectionSchema))),
  complete: writable(Schema.optional(Schema.Boolean)),
})
export type SessionCache = Schema.Schema.Type<typeof sessionCacheSchema>
