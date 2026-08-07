import { z } from 'zod'
import { toolCallSchema } from './pipeline.js'
import { fileVerdictSchema } from './port.js'

// ── JSON column helpers ────────────────────────────────────────────────
// The ledger's `*_json` columns are TEXT holding JSON.stringify output. Each
// helper parses the string AND validates the parsed value in one pipe.

const jsonParse = z.string().transform((s) => JSON.parse(s) as unknown)

const stringArrayJson = jsonParse.pipe(z.array(z.string()))
const stringRecordJson = jsonParse.pipe(z.record(z.string(), z.string()))
const toolCallMatrixJson = jsonParse.pipe(z.array(z.array(toolCallSchema)))

/** Coerce an INTEGER/REAL column to a JS number. `node:sqlite` may surface
 * stored integers as numbers already; coercion keeps the old `Number(...)`
 * behaviour without the hand-rolled casts. */
const num = z.coerce.number()

// ── LedgerSourceRow ────────────────────────────────────────────────────

export const ledgerSourceRowSchema = z.object({
  id: num,
  provider: z.string(),
  env_fingerprint: z.string(),
  file_path: z.string(),
  repo_url: z.string().nullable().optional(),
  project: z.string().nullable().optional(),
  fingerprint_dev: z.string().nullable().optional(),
  fingerprint_ino: z.string().nullable().optional(),
  fingerprint_mtime_ms: z.number().nullable().optional(),
  fingerprint_size_bytes: z.number().nullable().optional(),
  last_ported_at: z.string().nullable().optional(),
}).transform(r => ({
  id: r.id,
  provider: r.provider,
  envFingerprint: r.env_fingerprint,
  filePath: r.file_path,
  repoUrl: r.repo_url ?? undefined,
  project: r.project ?? undefined,
  // dev/ino are read back as TEXT (NTFS inodes exceed 2^53); mtimeMs/sizeBytes
  // stay numeric. Digit-exact string round-trip, never arithmetized.
  fingerprint: {
    dev: r.fingerprint_dev ?? undefined,
    ino: r.fingerprint_ino ?? undefined,
    mtimeMs: r.fingerprint_mtime_ms ?? undefined,
    sizeBytes: r.fingerprint_size_bytes ?? undefined,
  },
  lastPortedAt: r.last_ported_at ?? undefined,
}))
export type LedgerSourceRow = z.infer<typeof ledgerSourceRowSchema>

// ── LedgerSessionRow ───────────────────────────────────────────────────

export const ledgerSessionRowSchema = z.object({
  source_id: num,
  session_id: z.string(),
  project: z.string().nullable(),
  project_path: z.string().nullable(),
  working_directory: z.string().nullable(),
  canonical_project: z.string().nullable(),
  canonical_cwd: z.string().nullable(),
  agent_type: z.string().nullable(),
  title: z.string().nullable(),
  pr_links_json: stringArrayJson,
  is_sidechain: num,
  parent_session_id: z.string().nullable(),
  agent_spawn_links_json: stringRecordJson,
  mcp_inventory_json: stringArrayJson,
  ambiguous_spawn_agent_ids_json: stringArrayJson,
  ever_had_branch: num,
}).transform(r => ({
  sourceId: r.source_id,
  sessionId: r.session_id,
  project: r.project,
  projectPath: r.project_path,
  workingDirectory: r.working_directory,
  canonicalProject: r.canonical_project,
  canonicalCwd: r.canonical_cwd,
  agentType: r.agent_type,
  title: r.title,
  prLinks: r.pr_links_json,
  isSidechain: r.is_sidechain,
  parentSessionId: r.parent_session_id,
  agentSpawnLinks: r.agent_spawn_links_json,
  mcpInventory: r.mcp_inventory_json,
  ambiguousSpawnAgentIds: r.ambiguous_spawn_agent_ids_json,
  everHadBranch: r.ever_had_branch,
}))
export type LedgerSessionRow = z.infer<typeof ledgerSessionRowSchema>

// ── LedgerTurnRow ──────────────────────────────────────────────────────

export const ledgerTurnRowSchema = z.object({
  source_id: num,
  session_id: z.string(),
  turn_index: num,
  timestamp: z.string(),
  user_message: z.string().nullable(),
  git_branch: z.string().nullable(),
  pr_refs_json: stringArrayJson,
  spawn_tool_use_ids_json: stringArrayJson,
  category: z.string(),
  sub_category: z.string().nullable(),
  retries: num,
  has_edits: num,
}).transform(r => ({
  sourceId: r.source_id,
  sessionId: r.session_id,
  turnIndex: r.turn_index,
  timestamp: r.timestamp,
  userMessage: r.user_message ?? '',
  gitBranch: r.git_branch,
  prRefs: r.pr_refs_json,
  spawnToolUseIds: r.spawn_tool_use_ids_json,
  category: r.category,
  subCategory: r.sub_category,
  retries: r.retries,
  hasEdits: r.has_edits,
}))
export type LedgerTurnRow = z.infer<typeof ledgerTurnRowSchema>

// ── LedgerCallRow ──────────────────────────────────────────────────────

export const ledgerCallRowSchema = z.object({
  source_id: num,
  session_id: z.string(),
  turn_index: num,
  call_index: num,
  call_key: z.string(),
  dedup_key: z.string().nullable(),
  provider: z.string(),
  model: z.string(),
  timestamp: z.string(),
  speed: z.enum(['standard', 'fast']),
  project: z.string().nullable(),
  project_path: z.string().nullable(),
  working_directory: z.string().nullable(),
  base_cost_usd: num,
  is_estimated: num,
  savings_usd: num,
  savings_baseline_model: z.string().nullable(),
  input_tokens: num,
  output_tokens: num,
  cache_creation_input_tokens: num,
  cache_read_input_tokens: num,
  cached_input_tokens: num,
  reasoning_tokens: num,
  web_search_requests: num,
  cache_creation_one_hour_tokens: num,
  agent_type: z.string().nullable(),
  tools_json: stringArrayJson,
  mcp_tools_json: stringArrayJson,
  skills_json: stringArrayJson,
  subagent_types_json: stringArrayJson,
  bash_commands_json: stringArrayJson,
  tool_sequence_json: toolCallMatrixJson,
  loc_added: z.number().nullable(),
  loc_removed: z.number().nullable(),
  interrupted: num,
  user_modified: num,
  tool_errors: z.number().nullable(),
  edit_failed: z.number().nullable(),
}).transform(r => ({
  sourceId: r.source_id,
  sessionId: r.session_id,
  turnIndex: r.turn_index,
  callIndex: r.call_index,
  callKey: r.call_key,
  dedupKey: r.dedup_key,
  provider: r.provider,
  model: r.model,
  timestamp: r.timestamp,
  speed: r.speed,
  project: r.project,
  projectPath: r.project_path,
  workingDirectory: r.working_directory,
  baseCostUSD: r.base_cost_usd,
  isEstimated: r.is_estimated,
  savingsUSD: r.savings_usd,
  savingsBaselineModel: r.savings_baseline_model,
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  cacheCreationInputTokens: r.cache_creation_input_tokens,
  cacheReadInputTokens: r.cache_read_input_tokens,
  cachedInputTokens: r.cached_input_tokens,
  reasoningTokens: r.reasoning_tokens,
  webSearchRequests: r.web_search_requests,
  cacheCreationOneHourTokens: r.cache_creation_one_hour_tokens,
  agentType: r.agent_type,
  tools: r.tools_json,
  mcpTools: r.mcp_tools_json,
  skills: r.skills_json,
  subagentTypes: r.subagent_types_json,
  bashCommands: r.bash_commands_json,
  toolSequence: r.tool_sequence_json,
  locAdded: r.loc_added,
  locRemoved: r.loc_removed,
  interrupted: r.interrupted,
  userModified: r.user_modified,
  toolErrors: r.tool_errors,
  editFailed: r.edit_failed,
}))
export type LedgerCallRow = z.infer<typeof ledgerCallRowSchema>

// ── PortResult / config rows ───────────────────────────────────────────

export const portResultSchema = z.object({
  verdict: fileVerdictSchema,
  sourceId: z.number().nullable(),
  inserted: z.object({
    sessions: z.number(),
    turns: z.number(),
    calls: z.number(),
  }),
})
export type PortResult = z.infer<typeof portResultSchema>

export const modelAliasSchema = z.object({
  model: z.string(),
  aliasOf: z.string(),
})
export type ModelAlias = z.infer<typeof modelAliasSchema>

export const priceOverrideSchema = z.object({
  model: z.string(),
  inputPricePerMillion: z.number(),
  outputPricePerMillion: z.number(),
})
export type PriceOverride = z.infer<typeof priceOverrideSchema>

export const currencyRateSchema = z.object({
  code: z.string(),
  symbol: z.string(),
  rate: z.number(),
  updatedAt: z.string(),
})
export type CurrencyRate = z.infer<typeof currencyRateSchema>

// ── Config row read-back (DB shape → config shape) ─────────────────────
// The store's config getters read snake_case columns and map them to the
// camelCase config shapes the IPC layer serves (the schemas above). Modeling
// the row shapes here — instead of inline z.object()s in the store — keeps
// the DB→API mapping in the single source of truth (ADR 0003).

export const modelAliasRowSchema = z.object({
  model: z.string(),
  alias_of: z.string(),
}).transform(r => ({ model: r.model, aliasOf: r.alias_of }))
export type ModelAliasRow = z.infer<typeof modelAliasRowSchema>

export const priceOverrideRowSchema = z.object({
  model: z.string(),
  input_price_per_million: z.number(),
  output_price_per_million: z.number(),
}).transform(r => ({
  model: r.model,
  inputPricePerMillion: r.input_price_per_million,
  outputPricePerMillion: r.output_price_per_million,
}))
export type PriceOverrideRow = z.infer<typeof priceOverrideRowSchema>

export const currencyRateRowSchema = z.object({
  code: z.string(),
  symbol: z.string(),
  rate: z.number(),
  updated_at: z.string(),
}).transform(r => ({ code: r.code, symbol: r.symbol, rate: r.rate, updatedAt: r.updated_at }))
export type CurrencyRateRow = z.infer<typeof currencyRateRowSchema>
