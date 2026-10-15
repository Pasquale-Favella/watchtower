import * as Schema from 'effect/Schema'

import { toolCallSchema } from './pipeline.js'

const finiteNumber = Schema.Number.pipe(Schema.check(Schema.isFinite()))
const writable = Schema.mutableKey
const stringArray = Schema.mutable(Schema.Array(Schema.String))
const toolSequence = Schema.mutable(Schema.Array(Schema.mutable(Schema.Array(toolCallSchema))))

/**
 * The shared extraction seam: every provider's parsed call record flows through
 * this schema before it can become a cached call or a ledger row. Loose by
 * design — unknown keys from a newer provider shape are stripped, never fatal;
 * only a declared field failing its type triggers the skip-and-report path.
 */
export const parsedProviderCallSchema = Schema.Struct({
  provider: writable(Schema.String),
  model: writable(Schema.String),
  inputTokens: writable(finiteNumber),
  outputTokens: writable(finiteNumber),
  cacheCreationInputTokens: writable(finiteNumber),
  cacheReadInputTokens: writable(finiteNumber),
  cachedInputTokens: writable(finiteNumber),
  reasoningTokens: writable(finiteNumber),
  webSearchRequests: writable(finiteNumber),
  costUSD: writable(finiteNumber),
  costIsEstimated: writable(Schema.optional(Schema.Boolean)),
  tools: writable(stringArray),
  bashCommands: writable(stringArray),
  subagentTypes: writable(Schema.optional(stringArray)),
  skills: writable(Schema.optional(stringArray)),
  timestamp: writable(Schema.String),
  speed: writable(Schema.Literals(['standard', 'fast'])),
  deduplicationKey: writable(Schema.String),
  locAdded: writable(Schema.optional(finiteNumber)),
  locRemoved: writable(Schema.optional(finiteNumber)),
  editFailed: writable(Schema.optional(finiteNumber)),
  turnId: writable(Schema.optional(Schema.String)),
  toolSequence: writable(Schema.optional(toolSequence)),
  userMessage: writable(Schema.String),
  // Bounded assistant/tool-output text for this call (providers that persist
  // it: Claude path via the journal, OpenCode/Kilo via message parts, Codex
  // via response messages). Transient PR-evidence surface only: the central
  // PR scan reads it at parse time into per-turn `prRefs` (which ARE
  // persisted); the text itself is never cached per-call or ported to the
  // ledger. Optional since most providers don't expose it.
  assistantText: writable(Schema.optional(Schema.String)),
  sessionId: writable(Schema.String),
  project: writable(Schema.optional(Schema.String)),
  projectPath: writable(Schema.optional(Schema.String)),
  workingDirectory: writable(Schema.optional(Schema.String)),
})
export type ParsedProviderCall = Schema.Schema.Type<typeof parsedProviderCallSchema>

export const sessionSourceSchema = Schema.Struct({
  path: writable(Schema.String),
  project: writable(Schema.String),
  provider: writable(Schema.String),
  sourceId: writable(Schema.optional(Schema.String)),
  sourceLabel: writable(Schema.optional(Schema.String)),
  sourcePath: writable(Schema.optional(Schema.String)),
  sourceKind: writable(Schema.optional(Schema.Literals(['claude-config', 'claude-desktop']))),
  workingDirectory: writable(Schema.optional(Schema.String)),
})
export type SessionSource = Schema.Schema.Type<typeof sessionSourceSchema>

export const probeRootSchema = Schema.Struct({
  path: writable(Schema.String),
  label: writable(Schema.String),
})
export type ProbeRoot = Schema.Schema.Type<typeof probeRootSchema>
