import { z } from 'zod'
import { toolCallSchema } from './pipeline.js'

/** Per-call token usage as persisted in the session cache. All eight counts are
 * present (cache writes default missing counts to 0). */
export const cachedUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  cachedInputTokens: z.number(),
  reasoningTokens: z.number(),
  webSearchRequests: z.number(),
  cacheCreationOneHourTokens: z.number(),
})
export type CachedUsage = z.infer<typeof cachedUsageSchema>

const optionalNumber = z.number().optional()
const optionalString = z.string().optional()
const optionalBoolean = z.boolean().optional()

export const cachedCallSchema = z.object({
  provider: z.string(),
  model: z.string(),
  usage: cachedUsageSchema,
  costUSD: optionalNumber,
  isEstimated: optionalBoolean,
  speed: z.enum(['standard', 'fast']),
  timestamp: z.string(),
  tools: z.array(z.string()),
  bashCommands: z.array(z.string()),
  skills: z.array(z.string()),
  subagentTypes: z.array(z.string()).optional(),
  deduplicationKey: z.string(),
  project: optionalString,
  projectPath: optionalString,
  workingDirectory: optionalString,
  toolSequence: z.array(z.array(toolCallSchema)).optional(),
  locAdded: optionalNumber,
  locRemoved: optionalNumber,
  interrupted: optionalBoolean,
  userModified: optionalBoolean,
  toolErrors: optionalNumber,
  editFailed: optionalNumber,
})
export type CachedCall = z.infer<typeof cachedCallSchema>

export const cachedTurnSchema = z.object({
  timestamp: z.string(),
  sessionId: z.string(),
  userMessage: z.string(),
  calls: z.array(cachedCallSchema),
  gitBranch: optionalString,
  prRefs: z.array(z.string()).optional(),
  spawnToolUseIds: z.array(z.string()).optional(),
})
export type CachedTurn = z.infer<typeof cachedTurnSchema>

/** The cache's on-disk provenance fingerprint — numeric (stat() output). The
 * ledger's read-back fingerprint is a distinct string-flavoured shape (NTFS
 * inodes exceed 2^53, so dev/ino are cast to TEXT at read-back). */
export const fileFingerprintSchema = z.object({
  dev: z.number(),
  ino: z.number(),
  mtimeMs: z.number(),
  sizeBytes: z.number(),
})
export type FileFingerprint = z.infer<typeof fileFingerprintSchema>

export const cachedFileSchema = z.object({
  fingerprint: fileFingerprintSchema,
  lastCompleteLineOffset: optionalNumber,
  canonicalCwd: optionalString,
  workingDirectory: optionalString,
  canonicalProjectName: optionalString,
  mcpInventory: z.array(z.string()),
  turns: z.array(cachedTurnSchema),
  agentType: optionalString,
  failed: optionalBoolean,
  title: optionalString,
  prLinks: z.array(z.string()).optional(),
  isSidechain: optionalBoolean,
  parentSessionId: optionalString,
  agentSpawnLinks: z.record(z.string(), z.string()).optional(),
  ambiguousSpawnAgentIds: z.array(z.string()).optional(),
})
export type CachedFile = z.infer<typeof cachedFileSchema>

export const providerSectionSchema = z.object({
  envFingerprint: z.string(),
  files: z.record(z.string(), cachedFileSchema),
  durable: z.boolean().optional(),
  // One-shot PR-evidence re-parse marker: absent on caches written before the
  // provider-neutral PR detection (broad URL shapes + assistant/tool text).
  // While absent, the next write-mode scan fully re-parses every present
  // source once (verdict `modified`, so the ledger clean-replaces instead of
  // duplicating) and then stamps the marker. Optional so old caches validate.
  prEvidenceV1: z.boolean().optional(),
})
export type ProviderSection = z.infer<typeof providerSectionSchema>

export const sessionCacheSchema = z.object({
  version: z.number(),
  providers: z.record(z.string(), providerSectionSchema),
  complete: z.boolean().optional(),
})
export type SessionCache = z.infer<typeof sessionCacheSchema>
