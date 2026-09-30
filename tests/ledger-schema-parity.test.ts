/**
 * Differential parity harness for the Wave A Zod → Effect Schema migration of
 * `src/shared/schemas/ledger.ts` and `src/main/store/read-projections.ts`.
 *
 * WHAT THIS IS. The pre-migration Zod definitions are restated verbatim below
 * as the REFERENCE implementation, and every migrated schema is asked the same
 * question with the same input. A verdict is `accept`, `reject` or — the case
 * this whole slice exists for — `threw`: the old
 * `z.string().transform(JSON.parse).pipe(...)` threw straight out of
 * `safeParse`, so a malformed `*_json` cell had no verdict at all and killed
 * the read as a defect in `Cause`.
 *
 * The test asserts the verdict is IDENTICAL for every probe except the ones
 * listed in `INTENTIONALLY_DIFFERENT`, and that on a shared `accept` the two
 * decoded values are deep-equal (so a mapping cannot silently change shape).
 *
 * The Zod reference is a frozen copy on purpose: it is the "before" half of a
 * before/after comparison, not a second source of truth. When every row of the
 * matrix below says `identical`, this file's Zod block can be deleted.
 */
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as SchemaAST from 'effect/SchemaAST'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { ledgerCallFactsRowSchema } from '../src/main/store/read-projections.js'
import {
  currencyRateRowSchema,
  currencyRateSchema,
  ledgerCallRowSchema,
  ledgerSessionRowSchema,
  ledgerSourceRowSchema,
  ledgerTurnRowSchema,
  modelAliasRowSchema,
  modelAliasSchema,
  portResultSchema,
  priceOverrideRowSchema,
  priceOverrideSchema,
} from '../src/shared/schemas/ledger.js'
import { toolCallSchema } from '../src/shared/schemas/pipeline.js'
import { fileVerdictSchema } from '../src/shared/schemas/port.js'

// ══════════════════════════════════════════════════════════════════════════
// THE REFERENCE — pre-migration `src/shared/schemas/ledger.ts`, verbatim.
// ══════════════════════════════════════════════════════════════════════════

const zJsonParse = z.string().transform(s => JSON.parse(s) as unknown)

const zStringArrayJson = zJsonParse.pipe(z.array(z.string()))
const zStringRecordJson = zJsonParse.pipe(z.record(z.string(), z.string()))
const zToolCallMatrixJson = zJsonParse.pipe(z.array(z.array(toolCallSchema)))

const zNum = z.coerce.number()

const zLedgerSourceRowSchema = z
  .object({
    id: zNum,
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
  })
  .transform(r => ({
    id: r.id,
    provider: r.provider,
    envFingerprint: r.env_fingerprint,
    filePath: r.file_path,
    repoUrl: r.repo_url ?? undefined,
    project: r.project ?? undefined,
    fingerprint: {
      dev: r.fingerprint_dev ?? undefined,
      ino: r.fingerprint_ino ?? undefined,
      mtimeMs: r.fingerprint_mtime_ms ?? undefined,
      sizeBytes: r.fingerprint_size_bytes ?? undefined,
    },
    lastPortedAt: r.last_ported_at ?? undefined,
  }))

const zLedgerSessionRowSchema = z
  .object({
    source_id: zNum,
    session_id: z.string(),
    project: z.string().nullable(),
    project_path: z.string().nullable(),
    working_directory: z.string().nullable(),
    canonical_project: z.string().nullable(),
    canonical_cwd: z.string().nullable(),
    agent_type: z.string().nullable(),
    title: z.string().nullable(),
    pr_links_json: zStringArrayJson,
    is_sidechain: zNum,
    parent_session_id: z.string().nullable(),
    agent_spawn_links_json: zStringRecordJson,
    mcp_inventory_json: zStringArrayJson,
    ambiguous_spawn_agent_ids_json: zStringArrayJson,
    ever_had_branch: zNum,
  })
  .transform(r => ({
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

const zLedgerTurnRowSchema = z
  .object({
    source_id: zNum,
    session_id: z.string(),
    turn_index: zNum,
    timestamp: z.string(),
    user_message: z.string().nullable(),
    git_branch: z.string().nullable(),
    pr_refs_json: zStringArrayJson,
    spawn_tool_use_ids_json: zStringArrayJson,
    category: z.string(),
    sub_category: z.string().nullable(),
    retries: zNum,
    has_edits: zNum,
  })
  .transform(r => ({
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

const zLedgerCallRowSchema = z
  .object({
    source_id: zNum,
    session_id: z.string(),
    turn_index: zNum,
    call_index: zNum,
    call_key: z.string(),
    dedup_key: z.string().nullable(),
    provider: z.string(),
    model: z.string(),
    timestamp: z.string(),
    speed: z.enum(['standard', 'fast']),
    project: z.string().nullable(),
    project_path: z.string().nullable(),
    working_directory: z.string().nullable(),
    base_cost_usd: zNum,
    is_estimated: zNum,
    savings_usd: zNum,
    savings_baseline_model: z.string().nullable(),
    input_tokens: zNum,
    output_tokens: zNum,
    cache_creation_input_tokens: zNum,
    cache_read_input_tokens: zNum,
    cached_input_tokens: zNum,
    reasoning_tokens: zNum,
    web_search_requests: zNum,
    cache_creation_one_hour_tokens: zNum,
    agent_type: z.string().nullable(),
    tools_json: zStringArrayJson,
    mcp_tools_json: zStringArrayJson,
    skills_json: zStringArrayJson,
    subagent_types_json: zStringArrayJson,
    bash_commands_json: zStringArrayJson,
    tool_sequence_json: zToolCallMatrixJson,
    loc_added: z.number().nullable(),
    loc_removed: z.number().nullable(),
    interrupted: zNum,
    user_modified: zNum,
    tool_errors: z.number().nullable(),
    edit_failed: z.number().nullable(),
  })
  .transform(r => ({
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

const zPortResultSchema = z.object({
  verdict: fileVerdictSchema,
  sourceId: z.number().nullable(),
  inserted: z.object({
    sessions: z.number(),
    turns: z.number(),
    calls: z.number(),
  }),
})

const zModelAliasSchema = z.object({
  model: z.string(),
  aliasOf: z.string(),
})

const zPriceOverrideSchema = z.object({
  model: z.string(),
  inputPricePerMillion: z.number(),
  outputPricePerMillion: z.number(),
})

const zCurrencyRateSchema = z.object({
  code: z.string(),
  symbol: z.string(),
  rate: z.number(),
  updatedAt: z.string(),
})

const zModelAliasRowSchema = z
  .object({
    model: z.string(),
    alias_of: z.string(),
  })
  .transform(r => ({ model: r.model, aliasOf: r.alias_of }))

const zPriceOverrideRowSchema = z
  .object({
    model: z.string(),
    input_price_per_million: z.number(),
    output_price_per_million: z.number(),
  })
  .transform(r => ({
    model: r.model,
    inputPricePerMillion: r.input_price_per_million,
    outputPricePerMillion: r.output_price_per_million,
  }))

const zCurrencyRateRowSchema = z
  .object({
    code: z.string(),
    symbol: z.string(),
    rate: z.number(),
    updated_at: z.string(),
  })
  .transform(r => ({ code: r.code, symbol: r.symbol, rate: r.rate, updatedAt: r.updated_at }))

// `read-projections.ts`'s pre-migration Zod schema, verbatim.
const zLedgerCallFactsRowSchema = z
  .object({
    source_id: zNum,
    session_id: z.string(),
    turn_index: zNum,
    call_index: zNum,
    dedup_key: z.string().nullable(),
    provider: z.string(),
    model: z.string(),
    timestamp: z.string(),
    speed: z.enum(['standard', 'fast']),
    project: z.string().nullable(),
    working_directory: z.string().nullable(),
    base_cost_usd: zNum,
    is_estimated: zNum,
    savings_usd: zNum,
    savings_baseline_model: z.string().nullable(),
    input_tokens: zNum,
    output_tokens: zNum,
    cache_creation_input_tokens: zNum,
    cache_read_input_tokens: zNum,
    cached_input_tokens: zNum,
    reasoning_tokens: zNum,
    web_search_requests: zNum,
    cache_creation_one_hour_tokens: zNum,
    tools_json: zStringArrayJson,
    mcp_tools_json: zStringArrayJson,
    skills_json: zStringArrayJson,
    subagent_types_json: zStringArrayJson,
    bash_commands_json: zStringArrayJson,
    tool_sequence_json: zToolCallMatrixJson,
  })
  .transform(r => ({
    sourceId: r.source_id,
    sessionId: r.session_id,
    turnIndex: r.turn_index,
    callIndex: r.call_index,
    dedupKey: r.dedup_key,
    provider: r.provider,
    model: r.model,
    timestamp: r.timestamp,
    speed: r.speed,
    project: r.project,
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
    tools: r.tools_json,
    mcpTools: r.mcp_tools_json,
    skills: r.skills_json,
    subagentTypes: r.subagent_types_json,
    bashCommands: r.bash_commands_json,
    toolSequence: r.tool_sequence_json,
  }))

// ══════════════════════════════════════════════════════════════════════════
// The probe matrix
// ══════════════════════════════════════════════════════════════════════════

/** One row's worth of storage-side (snake_case) columns, per schema. */
const validSourceRow = {
  id: 7,
  provider: 'opencode',
  env_fingerprint: 'env-demo',
  file_path: '/w/demo.jsonl',
  repo_url: 'https://github.com/acme/demo',
  project: 'demo',
  fingerprint_dev: '42',
  fingerprint_ino: '4242',
  fingerprint_mtime_ms: 1_751_300_000_000,
  fingerprint_size_bytes: 4096,
  last_ported_at: '2026-07-01T09:00:00.000Z',
}

const validSessionRow = {
  source_id: 1,
  session_id: 'sess-0',
  project: 'demo',
  project_path: '/w/demo',
  working_directory: '/w',
  canonical_project: 'demo',
  canonical_cwd: '/w',
  agent_type: 'build',
  title: 'a title',
  pr_links_json: '["acme/demo#1"]',
  is_sidechain: 0,
  parent_session_id: null,
  agent_spawn_links_json: '{"agent-1":"sess-0"}',
  mcp_inventory_json: '["fs","git"]',
  ambiguous_spawn_agent_ids_json: '["agent-2"]',
  ever_had_branch: 1,
}

const validTurnRow = {
  source_id: 1,
  session_id: 'sess-0',
  turn_index: 0,
  timestamp: '2026-07-01T09:00:00.000Z',
  user_message: 'hello',
  git_branch: 'main',
  pr_refs_json: '["acme/demo#1"]',
  spawn_tool_use_ids_json: '["tool-1"]',
  category: 'build',
  sub_category: null,
  retries: 0,
  has_edits: 1,
}

const validCallRow = {
  source_id: 1,
  session_id: 'sess-0',
  turn_index: 0,
  call_index: 0,
  call_key: 'call-1',
  dedup_key: null,
  provider: 'opencode',
  model: 'demo-model',
  timestamp: '2026-07-01T09:00:00.000Z',
  speed: 'standard',
  project: null,
  project_path: null,
  working_directory: null,
  base_cost_usd: 0.42,
  is_estimated: 0,
  savings_usd: 0,
  savings_baseline_model: null,
  input_tokens: 100,
  output_tokens: 50,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 20,
  cached_input_tokens: 0,
  reasoning_tokens: 5,
  web_search_requests: 0,
  cache_creation_one_hour_tokens: 0,
  agent_type: null,
  tools_json: '["Edit"]',
  mcp_tools_json: '[]',
  skills_json: '[]',
  subagent_types_json: '[]',
  bash_commands_json: '["ls"]',
  tool_sequence_json: '[[{"tool":"Edit","file":"a.ts"}]]',
  loc_added: null,
  loc_removed: null,
  interrupted: 0,
  user_modified: 0,
  tool_errors: 0,
  edit_failed: 0,
}

/** The same call row with `getCallFacts`'s nine dropped columns removed — the
 *  storage-side (snake_case) shape the narrow read selects. */
const validFactsRow = {
  source_id: 1,
  session_id: 'sess-0',
  turn_index: 0,
  call_index: 0,
  dedup_key: null,
  provider: 'opencode',
  model: 'demo-model',
  timestamp: '2026-07-01T09:00:00.000Z',
  speed: 'standard',
  project: null,
  working_directory: null,
  base_cost_usd: 0.42,
  is_estimated: 0,
  savings_usd: 0,
  savings_baseline_model: null,
  input_tokens: 100,
  output_tokens: 50,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 20,
  cached_input_tokens: 0,
  reasoning_tokens: 5,
  web_search_requests: 0,
  cache_creation_one_hour_tokens: 0,
  tools_json: '["Edit"]',
  mcp_tools_json: '[]',
  skills_json: '[]',
  subagent_types_json: '[]',
  bash_commands_json: '["ls"]',
  tool_sequence_json: '[[{"tool":"Edit","file":"a.ts"}]]',
}

/** The nine columns `getCallFacts` drops — see the consumption map on
 *  `ledgerCallFactsRowSchema` in `src/main/store/read-projections.ts`. */
const DROPPED_FACTS_COLUMNS = [
  'call_key',
  'project_path',
  'agent_type',
  'loc_added',
  'loc_removed',
  'interrupted',
  'user_modified',
  'tool_errors',
  'edit_failed',
] as const

type Verdict = 'accept' | 'reject' | 'threw'

interface ZodVerdict {
  verdict: Verdict
  value?: unknown
}

function zodVerdict(schema: z.ZodType, input: unknown): ZodVerdict {
  try {
    const parsed = schema.safeParse(input)
    return parsed.success ? { verdict: 'accept', value: parsed.data } : { verdict: 'reject' }
  } catch (error) {
    // The Zod JSON pipe threw straight out of `safeParse`. Recorded, not hidden.
    return { verdict: 'threw', value: `${(error as Error).constructor.name}: ${(error as Error).message}` }
  }
}

function effectVerdict(schema: Schema.ConstraintDecoder<unknown, never>, input: unknown): ZodVerdict {
  try {
    return { verdict: 'accept', value: Schema.decodeUnknownSync(schema)(input) }
  } catch {
    return { verdict: 'reject' }
  }
}

/** Probes that MUST agree. Anything else belongs in `INTENTIONALLY_DIFFERENT`. */
interface Probe {
  label: string
  input: unknown
}

const NON_FINITE_NUMBERS: ReadonlyArray<readonly [string, number]> = [
  ['NaN', Number.NaN],
  ['+Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
]

/** The R3 corpus: everything `z.coerce.number()` had an opinion about. */
const COERCION_PROBES: ReadonlyArray<readonly [string, unknown]> = [
  ['null', null],
  ['empty string', ''],
  ['true', true],
  ['false', false],
  ['numeric string', '5'],
  ['non-numeric string', 'abc'],
  ['empty array', []],
  ['single-element array', [5]],
  ['empty object', {}],
  ['explicit undefined', undefined],
  ['bigint', 1n],
  // Zod rejects a Symbol cleanly; a bare `Number(sym)` would be a defect, so
  // `num` guards it. This probe is what keeps that guard honest.
  ['symbol', Symbol('probe')],
]

/** The R8 triple, applied to one JSON column. Where this slice's point lives. */
function jsonProbes(column: string, row: Record<string, unknown>, wellFormed: string): Probe[] {
  return [
    { label: `json well-formed (${column})`, input: { ...row, [column]: wellFormed } },
    { label: `json malformed (${column})`, input: { ...row, [column]: '{not-json' } },
    { label: `json null (${column})`, input: { ...row, [column]: null } },
    { label: `json missing (${column})`, input: omit(row, column) },
    { label: `json wrong element type (${column})`, input: { ...row, [column]: '[1,2]' } },
  ]
}

function omit(row: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([name]) => name !== key))
}

interface ParityCase {
  schema: string
  zod: z.ZodType
  effect: Schema.ConstraintDecoder<unknown, never>
  row: Record<string, unknown>
  /** A coerced-number column, for the NaN/±Infinity and coercion probes. */
  numericColumn: string
  /** Columns whose stored value is JSON text, for the R8 triple. */
  jsonColumns: ReadonlyArray<readonly [column: string, wellFormed: string]>
  /** Probes only this schema can answer (a bad enum member, for instance). */
  extraProbes?: ReadonlyArray<Probe>
}

const PARITY_CASES: ReadonlyArray<ParityCase> = [
  {
    schema: 'ledgerSourceRowSchema',
    zod: zLedgerSourceRowSchema,
    effect: ledgerSourceRowSchema,
    row: validSourceRow,
    numericColumn: 'id',
    jsonColumns: [],
    extraProbes: [
      { label: 'missing nullable column', input: omit(validSourceRow, 'repo_url') },
      { label: 'null nullable column', input: { ...validSourceRow, repo_url: null } },
      { label: 'text numeric column', input: { ...validSourceRow, fingerprint_mtime_ms: '1751300000000' } },
      { label: 'string where a number is declared', input: { ...validSourceRow, fingerprint_mtime_ms: 'nope' } },
    ],
  },
  {
    schema: 'ledgerSessionRowSchema',
    zod: zLedgerSessionRowSchema,
    effect: ledgerSessionRowSchema,
    row: validSessionRow,
    numericColumn: 'source_id',
    jsonColumns: [
      ['pr_links_json', '["acme/demo#1"]'],
      ['agent_spawn_links_json', '{"a":"b"}'],
      ['mcp_inventory_json', '["fs"]'],
      ['ambiguous_spawn_agent_ids_json', '[]'],
    ],
    extraProbes: [
      { label: 'record column with array payload', input: { ...validSessionRow, agent_spawn_links_json: '[1,2]' } },
      { label: 'record column with null payload', input: { ...validSessionRow, agent_spawn_links_json: 'null' } },
      { label: 'nullable text column is null', input: { ...validSessionRow, project: null } },
      { label: 'nullable text column is missing', input: omit(validSessionRow, 'project') },
    ],
  },
  {
    schema: 'ledgerTurnRowSchema',
    zod: zLedgerTurnRowSchema,
    effect: ledgerTurnRowSchema,
    row: validTurnRow,
    numericColumn: 'turn_index',
    jsonColumns: [
      ['pr_refs_json', '["acme/demo#1"]'],
      ['spawn_tool_use_ids_json', '["tool-1"]'],
    ],
    extraProbes: [
      // The old transform's `r.user_message ?? ''`: the row shape differs on the
      // decoded side (null becomes ''), so only the verdict is compared.
      { label: 'null user_message (decoded to "")', input: { ...validTurnRow, user_message: null } },
    ],
  },
  {
    schema: 'ledgerCallRowSchema',
    zod: zLedgerCallRowSchema,
    effect: ledgerCallRowSchema,
    row: validCallRow,
    numericColumn: 'base_cost_usd',
    jsonColumns: [
      ['tools_json', '["Edit"]'],
      ['mcp_tools_json', '[]'],
      ['skills_json', '[]'],
      ['subagent_types_json', '[]'],
      ['bash_commands_json', '["ls"]'],
      ['tool_sequence_json', '[[{"tool":"Edit"}]]'],
    ],
    extraProbes: [
      { label: 'bad speed enum member', input: { ...validCallRow, speed: 'turbo' } },
      { label: 'empty speed', input: { ...validCallRow, speed: '' } },
      { label: 'nullable number column is null', input: { ...validCallRow, loc_added: null } },
      { label: 'nullable number column is NaN', input: { ...validCallRow, tool_errors: Number.NaN } },
      {
        label: 'tool_sequence payload with an unknown tool key',
        input: { ...validCallRow, tool_sequence_json: '[[{"tool":"Edit","nope":1}]]' },
      },
      {
        label: 'tool_sequence payload missing `tool`',
        input: { ...validCallRow, tool_sequence_json: '[[{"file":"a.ts"}]]' },
      },
    ],
  },
  {
    schema: 'ledgerCallFactsRowSchema',
    zod: zLedgerCallFactsRowSchema,
    effect: ledgerCallFactsRowSchema,
    row: validFactsRow,
    numericColumn: 'base_cost_usd',
    jsonColumns: [
      ['tools_json', '["Edit"]'],
      ['mcp_tools_json', '[]'],
      ['skills_json', '[]'],
      ['subagent_types_json', '[]'],
      ['bash_commands_json', '["ls"]'],
      ['tool_sequence_json', '[[{"tool":"Edit"}]]'],
    ],
    extraProbes: [
      { label: 'bad speed enum member', input: { ...validFactsRow, speed: 'turbo' } },
      // The nine dropped columns must still be stripped, not rejected (R9).
      { label: 'a dropped column reappears', input: { ...validFactsRow, call_key: 'call-1' } },
    ],
  },
  {
    schema: 'modelAliasRowSchema',
    zod: zModelAliasRowSchema,
    effect: modelAliasRowSchema,
    row: { model: 'demo', alias_of: 'other' },
    numericColumn: '__none__',
    jsonColumns: [],
  },
  {
    schema: 'priceOverrideRowSchema',
    zod: zPriceOverrideRowSchema,
    effect: priceOverrideRowSchema,
    row: { model: 'demo', input_price_per_million: 1.5, output_price_per_million: 7.5 },
    numericColumn: 'input_price_per_million',
    jsonColumns: [],
    extraProbes: [
      {
        label: 'rate is NaN',
        input: { model: 'demo', input_price_per_million: Number.NaN, output_price_per_million: 1 },
      },
    ],
  },
  {
    schema: 'currencyRateRowSchema',
    zod: zCurrencyRateRowSchema,
    effect: currencyRateRowSchema,
    row: { code: 'EUR', symbol: '€', rate: 0.92, updated_at: '2026-07-01T09:00:00.000Z' },
    numericColumn: 'rate',
    jsonColumns: [],
  },
  {
    schema: 'portResultSchema',
    zod: zPortResultSchema,
    effect: portResultSchema,
    row: { verdict: 'modified', sourceId: 7, inserted: { sessions: 1, turns: 2, calls: 3 } },
    numericColumn: 'sourceId',
    jsonColumns: [],
    extraProbes: [
      {
        label: 'bad verdict member',
        input: { verdict: 'reverted', sourceId: null, inserted: { sessions: 0, turns: 0, calls: 0 } },
      },
      {
        label: 'inserted count is NaN',
        input: { verdict: 'new', sourceId: null, inserted: { sessions: Number.NaN, turns: 0, calls: 0 } },
      },
    ],
  },
  {
    schema: 'modelAliasSchema',
    zod: zModelAliasSchema,
    effect: modelAliasSchema,
    row: { model: 'demo', aliasOf: 'other' },
    numericColumn: '__none__',
    jsonColumns: [],
  },
  {
    schema: 'priceOverrideSchema',
    zod: zPriceOverrideSchema,
    effect: priceOverrideSchema,
    row: { model: 'demo', inputPricePerMillion: 1.5, outputPricePerMillion: 7.5 },
    numericColumn: 'inputPricePerMillion',
    jsonColumns: [],
  },
  {
    schema: 'currencyRateSchema',
    zod: zCurrencyRateSchema,
    effect: currencyRateSchema,
    row: { code: 'EUR', symbol: '€', rate: 0.92, updatedAt: '2026-07-01T09:00:00.000Z' },
    numericColumn: 'rate',
    jsonColumns: [],
  },
]

/** Verdict pairs the migration is allowed to change, with the reason.
 *  Derived from the matrix so the count cannot drift: every `*_json` column in
 *  the slice is one of these, and nothing else is. */
const R8_REASON = 'R8 — the Zod reference THREW a SyntaxError out of safeParse; Effect rejects cleanly'
const INTENTIONALLY_DIFFERENT: Readonly<Record<string, string>> = Object.fromEntries(
  PARITY_CASES.flatMap(c => c.jsonColumns.map(([column]) => [`${c.schema} json malformed (${column})`, R8_REASON])),
)

/** Probes where the decoded VALUES legitimately differ while the verdict matches. */
const VALUE_SHAPING_DIFFERENCES: ReadonlySet<string> = new Set([
  // `null → undefined` used to leave the key present-with-undefined under Zod
  // (`{ repoUrl: undefined }`); Effect omits the key. `toEqual` treats the two
  // identically, and the key is not on any wire payload.
  'ledgerSourceRowSchema null nullable column',
  'ledgerSourceRowSchema missing nullable column',
  // `r.user_message ?? ''` — same decoded value, but the schemas' own types
  // differ on the encoded side (`string | null` vs `string`), so only the
  // verdict is comparable.
  'ledgerTurnRowSchema null user_message (decoded to "")',
])

// ══════════════════════════════════════════════════════════════════════════
// The comparison
// ══════════════════════════════════════════════════════════════════════════

describe('Zod → Effect Schema parity: verdict-for-verdict', () => {
  for (const parityCase of PARITY_CASES) {
    const probes: Probe[] = [
      { label: 'valid row', input: parityCase.row },
      { label: 'unknown extra column', input: { ...parityCase.row, a_column_that_does_not_exist: 'stripped' } },
      ...NON_FINITE_NUMBERS.map(([label, value]): Probe => ({
        label: `${label} in ${parityCase.numericColumn}`,
        input: { ...parityCase.row, [parityCase.numericColumn]: value },
      })),
      ...COERCION_PROBES.map(([label, value]): Probe => ({
        label: `coercion: ${label} in ${parityCase.numericColumn}`,
        input: { ...parityCase.row, [parityCase.numericColumn]: value },
      })),
      ...parityCase.jsonColumns.flatMap(([column, wellFormed]) => jsonProbes(column, parityCase.row, wellFormed)),
      ...(parityCase.extraProbes ?? []),
    ]

    describe(parityCase.schema, () => {
      for (const probe of probes) {
        const key = `${parityCase.schema} ${probe.label}`
        it(probe.label, () => {
          const zod = zodVerdict(parityCase.zod, probe.input)
          const effect = effectVerdict(parityCase.effect, probe.input)
          const allowed = INTENTIONALLY_DIFFERENT[key]

          if (allowed !== undefined) {
            // The one approved change: Zod had no verdict at all, Effect has one.
            expect(zod.verdict, `${key}: the Zod reference must still throw here`).toBe('threw')
            expect(effect.verdict, `${key}: ${allowed}`).toBe('reject')
            return
          }

          expect(effect.verdict, `${key}: zod=${zod.verdict} effect=${effect.verdict}`).toBe(zod.verdict)

          if (zod.verdict === 'accept' && effect.verdict === 'accept' && !VALUE_SHAPING_DIFFERENCES.has(key)) {
            expect(effect.value, `${key}: decoded value drift`).toEqual(zod.value)
          }
        })
      }
    })
  }
})

describe('Zod → Effect Schema parity: the approved changes, counted', () => {
  it('the ONLY verdict differences are the 18 R8 JSON cells, one per *_json column', () => {
    const jsonColumns = PARITY_CASES.flatMap(c => c.jsonColumns.map(([column]) => [c.schema, column] as const))
    expect(jsonColumns).toHaveLength(18)
    expect(Object.keys(INTENTIONALLY_DIFFERENT)).toHaveLength(18)
  })

  it('a malformed JSON cell is a typed SchemaError on the error channel, not a defect', () => {
    // The mechanism behind every row above: `Schema.fromJsonString` catches the
    // `SyntaxError` and raises `SchemaIssue.InvalidValue`, so the failure is a
    // value on the error channel rather than an exception.
    const result = Schema.decodeUnknownResult(ledgerCallRowSchema)({ ...validCallRow, tools_json: '{not-json' })
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') expect(Schema.isSchemaError(result.failure)).toBe(true)

    const effect = Schema.decodeUnknownEffect(ledgerCallRowSchema)({ ...validCallRow, tools_json: '{not-json' })
    const resultFromEffect = Effect.runSync(Effect.result(effect))
    expect(resultFromEffect._tag).toBe('Failure')
    if (resultFromEffect._tag === 'Failure') expect(Schema.isSchemaError(resultFromEffect.failure)).toBe(true)
  })

  it('R1: the speed enum is closed over BOTH members (Schema.Literal would drop one)', () => {
    const speed = Schema.Literals(['standard', 'fast'])
    expect(Schema.Literal.length).toBe(1)
    expect(speed.ast._tag === 'Union' ? speed.ast.types : []).toHaveLength(2)
    expect(() => Schema.decodeUnknownSync(ledgerCallRowSchema)({ ...validCallRow, speed: 'turbo' })).toThrow()
    expect(Schema.decodeUnknownSync(ledgerCallRowSchema)({ ...validCallRow, speed: 'fast' }).speed).toBe('fast')
  })

  it('R2: a NaN cost is rejected by the migrated schemas (bare Schema.Number would accept it)', () => {
    expect(Schema.decodeUnknownSync(Schema.Number)(Number.NaN)).toBeNaN()
    expect(() =>
      Schema.decodeUnknownSync(ledgerCallRowSchema)({ ...validCallRow, base_cost_usd: Number.NaN }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(currencyRateSchema)({ code: 'E', symbol: '€', rate: Number.NaN, updatedAt: '' }),
    ).toThrow()
  })

  it('R9: unknown columns still strip, they do not fail', () => {
    const decoded = Schema.decodeUnknownSync(ledgerCallFactsRowSchema)({
      ...validFactsRow,
      call_key: 'call-1',
      an_entirely_new_column: 42,
    })
    expect(Object.keys(decoded)).not.toContain('call_key')
    expect(Object.keys(decoded)).not.toContain('an_entirely_new_column')
    expect(Object.keys(decoded).sort()).toEqual(
      // The 29 kept columns, from the Omit<LedgerCallRow, …> derivation.
      [
        'baseCostUSD',
        'bashCommands',
        'cacheCreationInputTokens',
        'cacheCreationOneHourTokens',
        'cacheReadInputTokens',
        'cachedInputTokens',
        'callIndex',
        'dedupKey',
        'inputTokens',
        'isEstimated',
        'mcpTools',
        'model',
        'outputTokens',
        'project',
        'provider',
        'reasoningTokens',
        'savingsBaselineModel',
        'savingsUSD',
        'sessionId',
        'skills',
        'sourceId',
        'speed',
        'subagentTypes',
        'timestamp',
        'toolSequence',
        'tools',
        'turnIndex',
        'webSearchRequests',
        'workingDirectory',
      ].sort(),
    )
  })
})

/**
 * The storage-side (snake_case) column of a migrated row schema, paired with the
 * decoded field it comes from (`decodedType: null` when there is nothing to pair
 * with — see below).
 *
 * `Schema.encodeKeys` builds the encoded struct by iterating the DECODED fields
 * in declaration order, so for the six rename-only rows the two property
 * signature lists pair by POSITION. `ledgerSourceRowSchema` is the exception: it
 * is a `Schema.decodeTo` that also GROUPS four flat `fingerprint_*` columns into
 * one nested `fingerprint`, so it has 11 encoded columns and 8 decoded fields
 * and nothing pairs. Its JSON-column set is therefore decided by the DDL gate
 * in `tests/ledger.test.ts` (`ledger_source` has no `*_json` column, and that
 * gate compares this list against the live column names) rather than here.
 */
function rowColumns(schema: { readonly ast: SchemaAST.AST }): ReadonlyArray<{
  column: string
  encodedType: SchemaAST.AST
  decodedType: SchemaAST.AST | null
}> {
  if (!SchemaAST.isObjects(schema.ast)) throw new Error('row schema AST is not a struct')
  const encoded = SchemaAST.toEncoded(schema.ast)
  if (!SchemaAST.isObjects(encoded)) throw new Error('encoded row schema AST is not a struct')
  const decoded = schema.ast.propertySignatures
  const pairs = encoded.propertySignatures.length === decoded.length
  return encoded.propertySignatures.map((property, index) => {
    const decodedField = pairs ? decoded[index] : undefined
    return { column: String(property.name), encodedType: property.type, decodedType: decodedField?.type ?? null }
  })
}

/** A `*_json` column: stored as TEXT, decodes to something that is not text. */
function isJsonColumn(field: {
  column: string
  encodedType: SchemaAST.AST
  decodedType: SchemaAST.AST | null
}): boolean {
  if (field.decodedType === null) return field.column.endsWith('_json')
  return SchemaAST.isString(field.encodedType) && !SchemaAST.isString(field.decodedType)
}

describe('row schema introspection: the encoded key set is the DDL column set', () => {
  // `tests/ledger.test.ts` needs the storage-side (snake_case) column names and
  // which of them are JSON columns, to hold the schemas against the live DDL.
  // These are the helpers it uses, proved here on the widest row.

  it('encoded keys come from SchemaAST.toEncoded and pair with the decoded fields by position', () => {
    const columns = rowColumns(ledgerCallRowSchema)
      .map(f => f.column)
      .sort()
    expect(columns).toEqual([
      'agent_type',
      'base_cost_usd',
      'bash_commands_json',
      'cache_creation_input_tokens',
      'cache_creation_one_hour_tokens',
      'cache_read_input_tokens',
      'cached_input_tokens',
      'call_index',
      'call_key',
      'dedup_key',
      'edit_failed',
      'input_tokens',
      'interrupted',
      'is_estimated',
      'loc_added',
      'loc_removed',
      'mcp_tools_json',
      'model',
      'output_tokens',
      'project',
      'project_path',
      'provider',
      'reasoning_tokens',
      'savings_baseline_model',
      'savings_usd',
      'session_id',
      'skills_json',
      'source_id',
      'speed',
      'subagent_types_json',
      'timestamp',
      'tool_errors',
      'tool_sequence_json',
      'tools_json',
      'turn_index',
      'user_modified',
      'web_search_requests',
      'working_directory',
    ])
  })

  it('a JSON column is TEXT on the wire and something structured on the decoded side', () => {
    expect(
      rowColumns(ledgerCallRowSchema)
        .filter(isJsonColumn)
        .map(f => f.column)
        .sort(),
    ).toEqual([
      'bash_commands_json',
      'mcp_tools_json',
      'skills_json',
      'subagent_types_json',
      'tool_sequence_json',
      'tools_json',
    ])
  })

  it('the narrow facts row is exactly the 29 kept columns, with its six JSON columns', () => {
    const columns = rowColumns(ledgerCallFactsRowSchema)
    expect(columns).toHaveLength(29)
    expect(
      columns
        .filter(isJsonColumn)
        .map(f => f.column)
        .sort(),
    ).toEqual([
      'bash_commands_json',
      'mcp_tools_json',
      'skills_json',
      'subagent_types_json',
      'tool_sequence_json',
      'tools_json',
    ])
    // The nine dropped columns really are absent from the encoded struct.
    const names = columns.map(f => f.column)
    for (const dropped of DROPPED_FACTS_COLUMNS) {
      expect(names, `dropped column ${dropped} is still in the schema`).not.toContain(dropped)
    }
    // And the schema's encoded columns ARE exactly `getCalls`'s minus the nine,
    // so the fixture the probes above use cannot drift from the schema.
    expect(names.sort()).toEqual(
      Object.keys(validCallRow)
        .filter(name => !(DROPPED_FACTS_COLUMNS as ReadonlyArray<string>).includes(name))
        .sort(),
    )
  })

  it('the source row introspects through its decodeTo pair too (11 columns, no JSON)', () => {
    const columns = rowColumns(ledgerSourceRowSchema)
      .map(f => f.column)
      .sort()
    expect(columns).toEqual([
      'env_fingerprint',
      'file_path',
      'fingerprint_dev',
      'fingerprint_ino',
      'fingerprint_mtime_ms',
      'fingerprint_size_bytes',
      'id',
      'last_ported_at',
      'project',
      'provider',
      'repo_url',
    ])
    expect(rowColumns(ledgerSourceRowSchema).filter(isJsonColumn)).toEqual([])
  })

  it('every row schema introspects: encoded keys and JSON columns are derivable', () => {
    for (const parityCase of PARITY_CASES) {
      const columns = rowColumns(parityCase.effect as { readonly ast: SchemaAST.AST })
      expect(columns.length, parityCase.schema).toBeGreaterThan(0)
      expect(
        columns
          .filter(isJsonColumn)
          .map(f => f.column)
          .sort(),
        `${parityCase.schema} JSON columns`,
      ).toEqual(parityCase.jsonColumns.map(([column]) => column).sort())
    }
  })
})
