import * as Schema from 'effect/Schema'

import { toolCallSchema } from './pipeline.js'
import { cachedFileSchema, type FileFingerprint, fileFingerprintSchema } from './session-cache.js'

const finiteNumber = Schema.Number.pipe(Schema.check(Schema.isFinite()))
const writable = Schema.mutableKey
const stringArray = Schema.mutable(Schema.Array(Schema.String))
const toolSequence = Schema.mutable(Schema.Array(Schema.mutable(Schema.Array(toolCallSchema))))
const stringRecord = Schema.Record(Schema.String, writable(Schema.String))

/** The verdict a scan delta assigns a session-cache file. */
export const fileVerdictSchema = Schema.Literals(['new', 'appended', 'modified', 'unchanged'])
export type FileVerdict = Schema.Schema.Type<typeof fileVerdictSchema>

/** The port-in request: one session-cache file's delta plus the discovery-time
 * metadata that the cached file itself cannot carry. `cachedFile` is the
 * cache's own validated blob. */
export const portInputSchema = Schema.Struct({
  provider: writable(Schema.String),
  envFingerprint: writable(Schema.String),
  filePath: writable(Schema.String),
  verdict: writable(fileVerdictSchema),
  cachedFile: writable(cachedFileSchema),
  repoUrl: writable(Schema.optional(Schema.String)),
  durable: writable(Schema.optional(Schema.Boolean)),
  project: writable(Schema.optional(Schema.String)),
  workingDirectory: writable(Schema.optional(Schema.String)),
})
export type PortInput = Schema.Schema.Type<typeof portInputSchema>

export const mappedSourceSchema = Schema.Struct({
  provider: writable(Schema.String),
  envFingerprint: writable(Schema.String),
  filePath: writable(Schema.String),
  repoUrl: writable(Schema.optional(Schema.String)),
  fingerprint: writable(fileFingerprintSchema),
})
export type MappedSource = Schema.Schema.Type<typeof mappedSourceSchema>

/** The port-in source fingerprint is the cache's numeric `FileFingerprint`.
 * (The ledger read-back fingerprint is a distinct string-flavoured shape.) */
export type MappedFingerprint = FileFingerprint

export const mappedSessionSchema = Schema.Struct({
  sessionId: writable(Schema.String),
  project: writable(Schema.NullOr(Schema.String)),
  projectPath: writable(Schema.NullOr(Schema.String)),
  workingDirectory: writable(Schema.NullOr(Schema.String)),
  canonicalProject: writable(Schema.NullOr(Schema.String)),
  canonicalCwd: writable(Schema.NullOr(Schema.String)),
  agentType: writable(Schema.NullOr(Schema.String)),
  title: writable(Schema.NullOr(Schema.String)),
  prLinks: writable(stringArray),
  isSidechain: writable(Schema.Boolean),
  parentSessionId: writable(Schema.NullOr(Schema.String)),
  agentSpawnLinks: writable(stringRecord),
  mcpInventory: writable(stringArray),
  everHadBranch: writable(Schema.Boolean),
  ambiguousSpawnAgentIds: writable(stringArray),
})
export type MappedSession = Schema.Schema.Type<typeof mappedSessionSchema>

export const mappedTurnSchema = Schema.Struct({
  sessionId: writable(Schema.String),
  turnIndex: writable(finiteNumber),
  timestamp: writable(Schema.String),
  userMessage: writable(Schema.String),
  gitBranch: writable(Schema.NullOr(Schema.String)),
  prRefs: writable(stringArray),
  spawnToolUseIds: writable(stringArray),
  category: writable(Schema.String),
  subCategory: writable(Schema.NullOr(Schema.String)),
  retries: writable(finiteNumber),
  hasEdits: writable(Schema.Boolean),
})
export type MappedTurn = Schema.Schema.Type<typeof mappedTurnSchema>

export const mappedCallSchema = Schema.Struct({
  sessionId: writable(Schema.String),
  turnIndex: writable(finiteNumber),
  callIndex: writable(finiteNumber),
  dedupKey: writable(Schema.NullOr(Schema.String)),
  provider: writable(Schema.String),
  model: writable(Schema.String),
  timestamp: writable(Schema.String),
  speed: writable(Schema.Literals(['standard', 'fast'])),
  project: writable(Schema.NullOr(Schema.String)),
  projectPath: writable(Schema.NullOr(Schema.String)),
  workingDirectory: writable(Schema.NullOr(Schema.String)),
  baseCostUSD: writable(finiteNumber),
  isEstimated: writable(Schema.Boolean),
  savingsUSD: writable(finiteNumber),
  savingsBaselineModel: writable(Schema.NullOr(Schema.String)),
  inputTokens: writable(finiteNumber),
  outputTokens: writable(finiteNumber),
  cacheCreationInputTokens: writable(finiteNumber),
  cacheReadInputTokens: writable(finiteNumber),
  cachedInputTokens: writable(finiteNumber),
  reasoningTokens: writable(finiteNumber),
  webSearchRequests: writable(finiteNumber),
  cacheCreationOneHourTokens: writable(finiteNumber),
  agentType: writable(Schema.NullOr(Schema.String)),
  tools: writable(stringArray),
  mcpTools: writable(stringArray),
  skills: writable(stringArray),
  subagentTypes: writable(stringArray),
  bashCommands: writable(stringArray),
  toolSequence: writable(toolSequence),
  locAdded: writable(Schema.NullOr(finiteNumber)),
  locRemoved: writable(Schema.NullOr(finiteNumber)),
  interrupted: writable(Schema.Boolean),
  userModified: writable(Schema.Boolean),
  toolErrors: writable(finiteNumber),
  editFailed: writable(finiteNumber),
})
export type MappedCall = Schema.Schema.Type<typeof mappedCallSchema>

export const mappedFileSchema = Schema.Struct({
  source: writable(mappedSourceSchema),
  session: writable(mappedSessionSchema),
  turns: writable(Schema.mutable(Schema.Array(mappedTurnSchema))),
  calls: writable(Schema.mutable(Schema.Array(mappedCallSchema))),
})
export type MappedFile = Schema.Schema.Type<typeof mappedFileSchema>
