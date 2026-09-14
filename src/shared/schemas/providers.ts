import { z } from 'zod'
import { toolCallSchema } from './pipeline.js'

/**
 * The shared extraction seam: every provider's parsed call record flows through
 * this schema before it can become a cached call or a ledger row. Loose by
 * design — unknown keys from a newer provider shape are stripped, never fatal;
 * only a declared field failing its type triggers the skip-and-report path.
 */
export const parsedProviderCallSchema = z.object({
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
  toolSequence: z.array(z.array(toolCallSchema)).optional(),
  userMessage: z.string(),
  // Bounded assistant/tool-output text for this call (providers that persist
  // it: Claude path via the journal, OpenCode/Kilo via message parts, Codex
  // via response messages). Transient PR-evidence surface only: the central
  // PR scan reads it at parse time into per-turn `prRefs` (which ARE
  // persisted); the text itself is never cached per-call or ported to the
  // ledger. Optional since most providers don't expose it.
  assistantText: z.string().optional(),
  sessionId: z.string(),
  project: z.string().optional(),
  projectPath: z.string().optional(),
  workingDirectory: z.string().optional(),
})
export type ParsedProviderCall = z.infer<typeof parsedProviderCallSchema>

export const sessionSourceSchema = z.object({
  path: z.string(),
  project: z.string(),
  provider: z.string(),
  sourceId: z.string().optional(),
  sourceLabel: z.string().optional(),
  sourcePath: z.string().optional(),
  sourceKind: z.enum(['claude-config', 'claude-desktop']).optional(),
  workingDirectory: z.string().optional(),
})
export type SessionSource = z.infer<typeof sessionSourceSchema>

export const probeRootSchema = z.object({
  path: z.string(),
  label: z.string(),
})
export type ProbeRoot = z.infer<typeof probeRootSchema>
