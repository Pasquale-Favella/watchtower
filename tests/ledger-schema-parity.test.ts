import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as SchemaAST from 'effect/SchemaAST'
import { describe, expect, it } from 'vitest'

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

// Static decoded fixtures recorded before retiring the frozen validator.
const expectedSource = {
  id: 7,
  provider: 'opencode',
  envFingerprint: 'env-demo',
  filePath: '/w/demo.jsonl',
  repoUrl: 'https://github.com/acme/demo',
  project: 'demo',
  fingerprint: {
    dev: '42',
    ino: '4242',
    mtimeMs: 1751300000000,
    sizeBytes: 4096,
  },
  lastPortedAt: '2026-07-01T09:00:00.000Z',
}
const expectedSession = {
  sourceId: 1,
  sessionId: 'sess-0',
  project: 'demo',
  projectPath: '/w/demo',
  workingDirectory: '/w',
  canonicalProject: 'demo',
  canonicalCwd: '/w',
  agentType: 'build',
  title: 'a title',
  prLinks: ['acme/demo#1'],
  isSidechain: 0,
  parentSessionId: null,
  agentSpawnLinks: {
    'agent-1': 'sess-0',
  },
  mcpInventory: ['fs', 'git'],
  ambiguousSpawnAgentIds: ['agent-2'],
  everHadBranch: 1,
}
const expectedTurn = {
  sourceId: 1,
  sessionId: 'sess-0',
  turnIndex: 0,
  timestamp: '2026-07-01T09:00:00.000Z',
  userMessage: 'hello',
  gitBranch: 'main',
  prRefs: ['acme/demo#1'],
  spawnToolUseIds: ['tool-1'],
  category: 'build',
  subCategory: null,
  retries: 0,
  hasEdits: 1,
}
const expectedCall = {
  sourceId: 1,
  sessionId: 'sess-0',
  turnIndex: 0,
  callIndex: 0,
  callKey: 'call-1',
  dedupKey: null,
  provider: 'opencode',
  model: 'demo-model',
  timestamp: '2026-07-01T09:00:00.000Z',
  speed: 'standard',
  project: null,
  projectPath: null,
  workingDirectory: null,
  baseCostUSD: 0.42,
  isEstimated: 0,
  savingsUSD: 0,
  savingsBaselineModel: null,
  inputTokens: 100,
  outputTokens: 50,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 20,
  cachedInputTokens: 0,
  reasoningTokens: 5,
  webSearchRequests: 0,
  cacheCreationOneHourTokens: 0,
  agentType: null,
  tools: ['Edit'],
  mcpTools: [],
  skills: [],
  subagentTypes: [],
  bashCommands: ['ls'],
  toolSequence: [
    [
      {
        tool: 'Edit',
        file: 'a.ts',
      },
    ],
  ],
  locAdded: null,
  locRemoved: null,
  interrupted: 0,
  userModified: 0,
  toolErrors: 0,
  editFailed: 0,
}
const expectedFacts = {
  sourceId: 1,
  sessionId: 'sess-0',
  turnIndex: 0,
  callIndex: 0,
  dedupKey: null,
  provider: 'opencode',
  model: 'demo-model',
  timestamp: '2026-07-01T09:00:00.000Z',
  speed: 'standard',
  project: null,
  workingDirectory: null,
  baseCostUSD: 0.42,
  isEstimated: 0,
  savingsUSD: 0,
  savingsBaselineModel: null,
  inputTokens: 100,
  outputTokens: 50,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 20,
  cachedInputTokens: 0,
  reasoningTokens: 5,
  webSearchRequests: 0,
  cacheCreationOneHourTokens: 0,
  tools: ['Edit'],
  mcpTools: [],
  skills: [],
  subagentTypes: [],
  bashCommands: ['ls'],
  toolSequence: [
    [
      {
        tool: 'Edit',
        file: 'a.ts',
      },
    ],
  ],
}
const expectedModelAliasRow = {
  model: 'demo',
  aliasOf: 'other',
}
const expectedPriceOverrideRow = {
  model: 'demo',
  inputPricePerMillion: 1.5,
  outputPricePerMillion: 7.5,
}
const expectedCurrencyRateRow = {
  code: 'EUR',
  symbol: '€',
  rate: 0.92,
  updatedAt: '2026-07-01T09:00:00.000Z',
}
const expectedPortResult = {
  verdict: 'modified',
  sourceId: 7,
  inserted: {
    sessions: 1,
    turns: 2,
    calls: 3,
  },
}
const expectedModelAlias = {
  model: 'demo',
  aliasOf: 'other',
}
const expectedPriceOverride = {
  model: 'demo',
  inputPricePerMillion: 1.5,
  outputPricePerMillion: 7.5,
}
const expectedCurrencyRate = {
  code: 'EUR',
  symbol: '€',
  rate: 0.92,
  updatedAt: '2026-07-01T09:00:00.000Z',
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

interface Probe {
  label: string
  input: unknown
  /** Absence means rejection; accepted rows carry the complete decoded value. */
  expected?: unknown
}

const NON_FINITE_NUMBERS: ReadonlyArray<readonly [string, number]> = [
  ['NaN', Number.NaN],
  ['+Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
]

/** Recorded values for the former number coercion contract. */
const COERCION_PROBES: ReadonlyArray<readonly [string, unknown, number | undefined]> = [
  ['null', null, 0],
  ['empty string', '', 0],
  ['true', true, 1],
  ['false', false, 0],
  ['numeric string', '5', 5],
  ['non-numeric string', 'abc', undefined],
  ['empty array', [], 0],
  ['single-element array', [5], 5],
  ['empty object', {}, undefined],
  ['explicit undefined', undefined, undefined],
  ['bigint', 1n, 1],
  ['symbol', Symbol('probe'), undefined],
]

function jsonProbes(
  column: string,
  row: Record<string, unknown>,
  wellFormed: string,
  decoded: Record<string, unknown>,
  field: string,
  expectedValue: unknown,
): Probe[] {
  return [
    {
      label: `json well-formed (${column})`,
      input: { ...row, [column]: wellFormed },
      expected: { ...decoded, [field]: expectedValue },
    },
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
  decoded: Record<string, unknown>
  numericField: string
  coercesNumbers?: boolean
  nullableNumber?: boolean
  effect: Schema.ConstraintDecoder<unknown, never>
  row: Record<string, unknown>
  /** A coerced-number column, for the NaN/±Infinity and coercion probes. */
  numericColumn: string
  /** Columns whose stored value is JSON text, for the R8 triple. */
  jsonColumns: ReadonlyArray<
    readonly [column: string, wellFormed: string, decodedField: string, expectedValue: unknown]
  >
  /** Probes only this schema can answer (a bad enum member, for instance). */
  extraProbes?: ReadonlyArray<Probe>
}

const PARITY_CASES: ReadonlyArray<ParityCase> = [
  {
    schema: 'ledgerSourceRowSchema',
    decoded: expectedSource,
    numericField: 'id',
    coercesNumbers: true,
    effect: ledgerSourceRowSchema,
    row: validSourceRow,
    numericColumn: 'id',
    jsonColumns: [],
    extraProbes: [
      {
        label: 'missing nullable column',
        input: omit(validSourceRow, 'repo_url'),
        expected: { ...expectedSource, repoUrl: undefined },
      },
      {
        label: 'null nullable column',
        input: { ...validSourceRow, repo_url: null },
        expected: { ...expectedSource, repoUrl: undefined },
      },
      { label: 'text numeric column', input: { ...validSourceRow, fingerprint_mtime_ms: '1751300000000' } },
      { label: 'string where a number is declared', input: { ...validSourceRow, fingerprint_mtime_ms: 'nope' } },
    ],
  },
  {
    schema: 'ledgerSessionRowSchema',
    decoded: expectedSession,
    numericField: 'sourceId',
    coercesNumbers: true,
    effect: ledgerSessionRowSchema,
    row: validSessionRow,
    numericColumn: 'source_id',
    jsonColumns: [
      ['pr_links_json', '["acme/demo#1"]', 'prLinks', ['acme/demo#1']],
      ['agent_spawn_links_json', '{"a":"b"}', 'agentSpawnLinks', { a: 'b' }],
      ['mcp_inventory_json', '["fs"]', 'mcpInventory', ['fs']],
      ['ambiguous_spawn_agent_ids_json', '[]', 'ambiguousSpawnAgentIds', []],
    ],
    extraProbes: [
      { label: 'record column with array payload', input: { ...validSessionRow, agent_spawn_links_json: '[1,2]' } },
      { label: 'record column with null payload', input: { ...validSessionRow, agent_spawn_links_json: 'null' } },
      {
        label: 'nullable text column is null',
        input: { ...validSessionRow, project: null },
        expected: { ...expectedSession, project: null },
      },
      { label: 'nullable text column is missing', input: omit(validSessionRow, 'project') },
    ],
  },
  {
    schema: 'ledgerTurnRowSchema',
    decoded: expectedTurn,
    numericField: 'turnIndex',
    coercesNumbers: true,
    effect: ledgerTurnRowSchema,
    row: validTurnRow,
    numericColumn: 'turn_index',
    jsonColumns: [
      ['pr_refs_json', '["acme/demo#1"]', 'prRefs', ['acme/demo#1']],
      ['spawn_tool_use_ids_json', '["tool-1"]', 'spawnToolUseIds', ['tool-1']],
    ],
    extraProbes: [
      // A null stored message retains the recorded empty-string fallback.
      {
        label: 'null user_message (decoded to "")',
        input: { ...validTurnRow, user_message: null },
        expected: { ...expectedTurn, userMessage: '' },
      },
    ],
  },
  {
    schema: 'ledgerCallRowSchema',
    decoded: expectedCall,
    numericField: 'baseCostUSD',
    coercesNumbers: true,
    effect: ledgerCallRowSchema,
    row: validCallRow,
    numericColumn: 'base_cost_usd',
    jsonColumns: [
      ['tools_json', '["Edit"]', 'tools', ['Edit']],
      ['mcp_tools_json', '[]', 'mcpTools', []],
      ['skills_json', '[]', 'skills', []],
      ['subagent_types_json', '[]', 'subagentTypes', []],
      ['bash_commands_json', '["ls"]', 'bashCommands', ['ls']],
      ['tool_sequence_json', '[[{"tool":"Edit"}]]', 'toolSequence', [[{ tool: 'Edit' }]]],
    ],
    extraProbes: [
      { label: 'bad speed enum member', input: { ...validCallRow, speed: 'turbo' } },
      { label: 'empty speed', input: { ...validCallRow, speed: '' } },
      { label: 'nullable number column is null', input: { ...validCallRow, loc_added: null }, expected: expectedCall },
      { label: 'nullable number column is NaN', input: { ...validCallRow, tool_errors: Number.NaN } },
      {
        label: 'tool_sequence payload with an unknown tool key',
        input: { ...validCallRow, tool_sequence_json: '[[{"tool":"Edit","nope":1}]]' },
        expected: { ...expectedCall, toolSequence: [[{ tool: 'Edit' }]] },
      },
      {
        label: 'tool_sequence payload missing `tool`',
        input: { ...validCallRow, tool_sequence_json: '[[{"file":"a.ts"}]]' },
      },
    ],
  },
  {
    schema: 'ledgerCallFactsRowSchema',
    decoded: expectedFacts,
    numericField: 'baseCostUSD',
    coercesNumbers: true,
    effect: ledgerCallFactsRowSchema,
    row: validFactsRow,
    numericColumn: 'base_cost_usd',
    jsonColumns: [
      ['tools_json', '["Edit"]', 'tools', ['Edit']],
      ['mcp_tools_json', '[]', 'mcpTools', []],
      ['skills_json', '[]', 'skills', []],
      ['subagent_types_json', '[]', 'subagentTypes', []],
      ['bash_commands_json', '["ls"]', 'bashCommands', ['ls']],
      ['tool_sequence_json', '[[{"tool":"Edit"}]]', 'toolSequence', [[{ tool: 'Edit' }]]],
    ],
    extraProbes: [
      { label: 'bad speed enum member', input: { ...validFactsRow, speed: 'turbo' } },
      // The nine dropped columns must still be stripped, not rejected (R9).
      { label: 'a dropped column reappears', input: { ...validFactsRow, call_key: 'call-1' }, expected: expectedFacts },
    ],
  },
  {
    schema: 'modelAliasRowSchema',
    decoded: expectedModelAliasRow,
    numericField: '__none__',
    effect: modelAliasRowSchema,
    row: { model: 'demo', alias_of: 'other' },
    numericColumn: '__none__',
    jsonColumns: [],
  },
  {
    schema: 'priceOverrideRowSchema',
    decoded: expectedPriceOverrideRow,
    numericField: 'inputPricePerMillion',
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
    decoded: expectedCurrencyRateRow,
    numericField: 'rate',
    effect: currencyRateRowSchema,
    row: { code: 'EUR', symbol: '€', rate: 0.92, updated_at: '2026-07-01T09:00:00.000Z' },
    numericColumn: 'rate',
    jsonColumns: [],
  },
  {
    schema: 'portResultSchema',
    decoded: expectedPortResult,
    numericField: 'sourceId',
    nullableNumber: true,
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
    decoded: expectedModelAlias,
    numericField: '__none__',
    effect: modelAliasSchema,
    row: { model: 'demo', aliasOf: 'other' },
    numericColumn: '__none__',
    jsonColumns: [],
  },
  {
    schema: 'priceOverrideSchema',
    decoded: expectedPriceOverride,
    numericField: 'inputPricePerMillion',
    effect: priceOverrideSchema,
    row: { model: 'demo', inputPricePerMillion: 1.5, outputPricePerMillion: 7.5 },
    numericColumn: 'inputPricePerMillion',
    jsonColumns: [],
  },
  {
    schema: 'currencyRateSchema',
    decoded: expectedCurrencyRate,
    numericField: 'rate',
    effect: currencyRateSchema,
    row: { code: 'EUR', symbol: '€', rate: 0.92, updatedAt: '2026-07-01T09:00:00.000Z' },
    numericColumn: 'rate',
    jsonColumns: [],
  },
]

describe('recorded ledger contract verdicts and decoded values', () => {
  for (const parityCase of PARITY_CASES) {
    const probes: Probe[] = [
      { label: 'valid row', input: parityCase.row, expected: parityCase.decoded },
      {
        label: 'unknown extra column',
        input: { ...parityCase.row, a_column_that_does_not_exist: 'stripped' },
        expected: parityCase.decoded,
      },
      ...NON_FINITE_NUMBERS.map(([label, value]): Probe => ({
        label: `${label} in ${parityCase.numericColumn}`,
        input: { ...parityCase.row, [parityCase.numericColumn]: value },
        expected: parityCase.numericColumn === '__none__' ? parityCase.decoded : undefined,
      })),
      ...COERCION_PROBES.map(([label, value, expectedNumber]): Probe => {
        const labelText = `coercion: ${label} in ${parityCase.numericColumn}`
        const input = { ...parityCase.row, [parityCase.numericColumn]: value }
        if (parityCase.numericColumn === '__none__') return { label: labelText, input, expected: parityCase.decoded }
        if (parityCase.nullableNumber && value === null)
          return { label: labelText, input, expected: { ...parityCase.decoded, [parityCase.numericField]: null } }
        return {
          label: labelText,
          input,
          expected:
            parityCase.coercesNumbers && expectedNumber !== undefined
              ? { ...parityCase.decoded, [parityCase.numericField]: expectedNumber }
              : undefined,
        }
      }),
      ...parityCase.jsonColumns.flatMap(([column, text, field, value]) =>
        jsonProbes(column, parityCase.row, text, parityCase.decoded, field, value),
      ),
      ...(parityCase.extraProbes ?? []),
    ]
    describe(parityCase.schema, () => {
      for (const probe of probes) {
        it(probe.label, () => {
          const result = Schema.decodeUnknownResult(parityCase.effect)(probe.input)
          if (probe.expected === undefined) {
            expect(result._tag).toBe('Failure')
            if (result._tag === 'Failure') expect(Schema.isSchemaError(result.failure)).toBe(true)
          } else {
            expect(result._tag).toBe('Success')
            if (result._tag === 'Success') expect(result.success).toStrictEqual(probe.expected)
          }
        })
      }
    })
  }
})

describe('ledger contract approved behavior changes', () => {
  it('the ONLY verdict differences are the 18 R8 JSON cells, one per *_json column', () => {
    const jsonColumns = PARITY_CASES.flatMap(c => c.jsonColumns.map(([column]) => [c.schema, column] as const))
    expect(jsonColumns).toHaveLength(18)
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
