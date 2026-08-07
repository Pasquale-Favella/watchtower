import { z } from 'zod'
import { toolCallSchema } from './pipeline.js'
import { cachedFileSchema, fileFingerprintSchema, type FileFingerprint } from './session-cache.js'

/** The verdict a scan delta assigns a session-cache file. */
export const fileVerdictSchema = z.enum(['new', 'appended', 'modified', 'unchanged'])
export type FileVerdict = z.infer<typeof fileVerdictSchema>

/** The port-in request: one session-cache file's delta plus the discovery-time
 * metadata that the cached file itself cannot carry. `cachedFile` is the
 * cache's own validated blob. */
export const portInputSchema = z.object({
  provider: z.string(),
  envFingerprint: z.string(),
  filePath: z.string(),
  verdict: fileVerdictSchema,
  cachedFile: cachedFileSchema,
  repoUrl: z.string().optional(),
  durable: z.boolean().optional(),
  project: z.string().optional(),
  workingDirectory: z.string().optional(),
})
export type PortInput = z.infer<typeof portInputSchema>

export const mappedSourceSchema = z.object({
  provider: z.string(),
  envFingerprint: z.string(),
  filePath: z.string(),
  repoUrl: z.string().optional(),
  fingerprint: fileFingerprintSchema,
})
export type MappedSource = z.infer<typeof mappedSourceSchema>

/** The port-in source fingerprint is the cache's numeric `FileFingerprint`.
 * (The ledger read-back fingerprint is a distinct string-flavoured shape.) */
export type MappedFingerprint = FileFingerprint

export const mappedSessionSchema = z.object({
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
export type MappedSession = z.infer<typeof mappedSessionSchema>

export const mappedTurnSchema = z.object({
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
export type MappedTurn = z.infer<typeof mappedTurnSchema>

export const mappedCallSchema = z.object({
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
  toolSequence: z.array(z.array(toolCallSchema)),
  locAdded: z.number().nullable(),
  locRemoved: z.number().nullable(),
  interrupted: z.boolean(),
  userModified: z.boolean(),
  toolErrors: z.number(),
  editFailed: z.number(),
})
export type MappedCall = z.infer<typeof mappedCallSchema>

export const mappedFileSchema = z.object({
  source: mappedSourceSchema,
  session: mappedSessionSchema,
  turns: z.array(mappedTurnSchema),
  calls: z.array(mappedCallSchema),
})
export type MappedFile = z.infer<typeof mappedFileSchema>
