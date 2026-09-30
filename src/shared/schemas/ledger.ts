import * as Schema from 'effect/Schema'
import * as SchemaGetter from 'effect/SchemaGetter'

// ── Two shapes owned by sibling Wave A modules, restated here ────────────
// `toolCallSchema` (./pipeline.js) and `fileVerdictSchema` (./port.js) are
// still Zod: those two modules are separate Wave A slices with their own
// consumers, and pulling them in would widen this diff past the slice. They are
// restated here — the same "same semantics, restated locally" move
// `store/read-projections.ts` already made for the JSON helpers — so this
// module is single-library end to end. Nothing consumes these two by identity;
// both are read only through the row schemas below.

/** `pipeline.ts`'s `toolCallSchema`: one tool invocation inside a call's
 *  captured tool sequence, with the same two optional fields. */
const toolCall = Schema.Struct({
  tool: Schema.String,
  file: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
})

/** `port.ts`'s `fileVerdictSchema`. */
const fileVerdict = Schema.Literals(['new', 'appended', 'modified', 'unchanged'])

// ── Scalar helpers ──────────────────────────────────────────────────────

/** `z.number()` — a FINITE number. Bare `Schema.Number` accepts `NaN` and
 *  `±Infinity`, which Zod rejects, and a `NaN` cost renders as
 *  `{"cost":null}`. Rule R2. */
const finiteNumber = Schema.Number.pipe(Schema.check(Schema.isFinite()))

/** `z.coerce.number()`, translated explicitly (rule R3).
 *
 *  Zod's coercion is `Number(input)` followed by its number check, so it
 *  ACCEPTS `""` → 0, `null` → 0, `true` → 1, `[]` → 0, `[5]` → 5 and
 *  `"5"` → 5, and REJECTS `"abc"`, `{}`, `NaN` and `±Infinity`. The ready-made
 *  `Schema.NumberFromString` covers only the numeric-string case, so the whole
 *  `Number()` semantics are spelled out here to keep the verdict identical.
 *
 *  The symbol guard is there to KEEP that verdict: Zod rejects a `Symbol`
 *  cleanly, but a bare `Number(sym)` is a `TypeError`, which inside `Effect.gen`
 *  would surface as a defect rather than a rejection. The guard makes it `NaN`,
 *  i.e. a `SchemaError` — same verdict as before, now typed. Measured, not
 *  assumed: `tests/ledger-schema-parity.test.ts` probes symbols and bigints
 *  alongside the rest of the R3 corpus. */
const num = Schema.Unknown.pipe(
  Schema.decodeTo(finiteNumber, {
    decode: SchemaGetter.transform((value: unknown) => (typeof value === 'symbol' ? Number.NaN : Number(value))),
    encode: SchemaGetter.transform((value: number) => value),
  }),
)

/** A nullable column that decodes to `undefined` rather than `null` — the
 *  `r.x ?? undefined` half of the old Zod transforms, with Zod's
 *  `.nullable().optional()` key semantics preserved (an absent key, `null` and
 *  `undefined` all decode). */
const nullish = <S extends Schema.Constraint>(schema: S) =>
  Schema.optional(Schema.NullOr(schema)).pipe(
    Schema.decodeTo(Schema.optional(schema), {
      decode: SchemaGetter.transform((value: S['Type'] | null | undefined) => value ?? undefined),
      encode: SchemaGetter.transform((value: S['Type'] | undefined) => value ?? null),
    }),
  )

/** A nullable column that decodes to `fallback` — Zod's `r.x ?? fallback`. */
const nullTo = <S extends Schema.Constraint>(schema: S, fallback: S['Type']) =>
  Schema.NullOr(schema).pipe(
    Schema.decodeTo(schema, {
      decode: SchemaGetter.transform((value: S['Type'] | null) => value ?? fallback),
      encode: SchemaGetter.transform((value: S['Type']) => value),
    }),
  )

// ── JSON column helpers ─────────────────────────────────────────────────
// The ledger's `*_json` columns are TEXT holding JSON.stringify output. Each
// helper parses the string AND validates the parsed value in one schema.
//
// `Schema.fromJsonString` is the rc.115 replacement for the old
// `z.string().transform(JSON.parse).pipe(...)` (R8). It is ALSO the clearest
// instance of this slice's point: the Zod pipe THREW out of `safeParse`/`parse`
// on a malformed cell, so there was no verdict at all and the read died as a
// defect in `Cause`. `SchemaGetter.parseJson` catches the `SyntaxError` and
// raises `SchemaIssue.InvalidValue` instead, so a truncated `*_json` column is
// now a `SchemaError` in the error channel. Owner-approved behaviour change.
//
// `Schema.mutable` is applied inside the pipe because `Schema.Array` decodes to
// `ReadonlyArray` while the old Zod schemas produced a mutable `T[]`. The wire
// payloads assembled from these rows (`SessionSummary.prLinks`,
// `ParsedApiCall.toolSequence`, …) are typed `string[]`/`ToolCall[][]`, and
// keeping them assignable is what lets the frozen wire stay byte-identical
// without touching a single consumer.

const stringArrayJson = Schema.fromJsonString(Schema.mutable(Schema.Array(Schema.String)))
const stringRecordJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))
const toolCallMatrixJson = Schema.fromJsonString(Schema.mutable(Schema.Array(Schema.mutable(Schema.Array(toolCall)))))

// ── Snake→camel storage shapes ──────────────────────────────────────────
// Every row schema below maps its DB (snake_case) columns onto the camelCase
// shape the aggregation seam consumes. `Schema.encodeKeys` is the rc.115
// combinator for that: it takes a `{ decodedKey: encodedKey }` mapping, builds
// the storage-side struct itself, and yields a bidirectional codec — so the
// encoded key set stays machine-introspectable (`SchemaAST.toEncoded`), unknown
// columns still strip, and the seven `.transform(r => ({ ... }))` bodies in the
// old file disappear. It renames TOP-LEVEL keys only; `ledgerSourceRowSchema`,
// the one shape that also GROUPS four flat columns under a nested
// `fingerprint`, composes an explicit `Schema.decodeTo` pair instead.

// ── LedgerSourceRow ──────────────────────────────────────────────────────

/** The decoded (camelCase) side of `LedgerSourceRow`. Every field is an IDENTITY
 *  codec — `Schema.optional`, `finiteNumber`, plain strings — because
 *  `Schema.decodeTo` bridges `From["Type"]` to `To["Encoded"]`: a transforming
 *  field on the target side would make the two ends describe different shapes.
 *  The NULL→`undefined` and the four-column grouping happen in the getters
 *  below.
 *
 *  `fingerprint` is the one place the flat `fingerprint_*` columns are grouped
 *  under a nested object. `dev`/`ino` are read back as TEXT (NTFS inodes exceed
 *  2^53) and stay digit-exact strings, never arithmetized; `mtimeMs`/`sizeBytes`
 *  stay numeric. */
const ledgerSourceRowDecoded = Schema.Struct({
  id: finiteNumber,
  provider: Schema.String,
  envFingerprint: Schema.String,
  filePath: Schema.String,
  repoUrl: Schema.optional(Schema.String),
  project: Schema.optional(Schema.String),
  fingerprint: Schema.Struct({
    dev: Schema.optional(Schema.String),
    ino: Schema.optional(Schema.String),
    mtimeMs: Schema.optional(finiteNumber),
    sizeBytes: Schema.optional(finiteNumber),
  }),
  lastPortedAt: Schema.optional(Schema.String),
})
type LedgerSourceRowDecoded = Schema.Schema.Type<typeof ledgerSourceRowDecoded>

const ledgerSourceRowEncoded = Schema.Struct({
  id: num,
  provider: Schema.String,
  env_fingerprint: Schema.String,
  file_path: Schema.String,
  repo_url: nullish(Schema.String),
  project: nullish(Schema.String),
  fingerprint_dev: nullish(Schema.String),
  fingerprint_ino: nullish(Schema.String),
  fingerprint_mtime_ms: nullish(finiteNumber),
  fingerprint_size_bytes: nullish(finiteNumber),
  last_ported_at: nullish(Schema.String),
})
type LedgerSourceRowEncoded = Schema.Schema.Type<typeof ledgerSourceRowEncoded>

export const ledgerSourceRowSchema = ledgerSourceRowEncoded.pipe(
  Schema.decodeTo<typeof ledgerSourceRowDecoded, typeof ledgerSourceRowEncoded>(ledgerSourceRowDecoded, {
    decode: SchemaGetter.transform((r: LedgerSourceRowEncoded): LedgerSourceRowDecoded => ({
      id: r.id,
      provider: r.provider,
      envFingerprint: r.env_fingerprint,
      filePath: r.file_path,
      repoUrl: r.repo_url,
      project: r.project,
      fingerprint: {
        dev: r.fingerprint_dev,
        ino: r.fingerprint_ino,
        mtimeMs: r.fingerprint_mtime_ms,
        sizeBytes: r.fingerprint_size_bytes,
      },
      lastPortedAt: r.last_ported_at,
    })),
    // The inverse of the decode getter. Nothing encodes through a ledger row
    // schema today (they are read-only projections), but a one-way codec would
    // make `Schema.encodeSync` a defect — and the encoder is the cheapest proof
    // available that the two mappings really are inverses.
    encode: SchemaGetter.transform((r: LedgerSourceRowDecoded): LedgerSourceRowEncoded => ({
      id: r.id,
      provider: r.provider,
      env_fingerprint: r.envFingerprint,
      file_path: r.filePath,
      repo_url: r.repoUrl,
      project: r.project,
      fingerprint_dev: r.fingerprint.dev,
      fingerprint_ino: r.fingerprint.ino,
      fingerprint_mtime_ms: r.fingerprint.mtimeMs,
      fingerprint_size_bytes: r.fingerprint.sizeBytes,
      last_ported_at: r.lastPortedAt,
    })),
  }),
)
export type LedgerSourceRow = Schema.Schema.Type<typeof ledgerSourceRowSchema>

// ── LedgerSessionRow ────────────────────────────────────────────────────

export const ledgerSessionRowSchema = Schema.Struct({
  sourceId: num,
  sessionId: Schema.String,
  project: Schema.NullOr(Schema.String),
  projectPath: Schema.NullOr(Schema.String),
  workingDirectory: Schema.NullOr(Schema.String),
  canonicalProject: Schema.NullOr(Schema.String),
  canonicalCwd: Schema.NullOr(Schema.String),
  agentType: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  prLinks: stringArrayJson,
  isSidechain: num,
  parentSessionId: Schema.NullOr(Schema.String),
  agentSpawnLinks: stringRecordJson,
  mcpInventory: stringArrayJson,
  ambiguousSpawnAgentIds: stringArrayJson,
  everHadBranch: num,
}).pipe(
  Schema.encodeKeys({
    sourceId: 'source_id',
    sessionId: 'session_id',
    projectPath: 'project_path',
    workingDirectory: 'working_directory',
    canonicalProject: 'canonical_project',
    canonicalCwd: 'canonical_cwd',
    agentType: 'agent_type',
    prLinks: 'pr_links_json',
    isSidechain: 'is_sidechain',
    parentSessionId: 'parent_session_id',
    agentSpawnLinks: 'agent_spawn_links_json',
    mcpInventory: 'mcp_inventory_json',
    ambiguousSpawnAgentIds: 'ambiguous_spawn_agent_ids_json',
    everHadBranch: 'ever_had_branch',
  }),
)
export type LedgerSessionRow = Schema.Schema.Type<typeof ledgerSessionRowSchema>

// ── LedgerTurnRow ───────────────────────────────────────────────────────

export const ledgerTurnRowSchema = Schema.Struct({
  sourceId: num,
  sessionId: Schema.String,
  turnIndex: num,
  timestamp: Schema.String,
  // `user_message` is nullable in the DDL but required (`string`) on
  // `ClassifiedTurn`, so a NULL reads back as `''` — the old transform's
  // `r.user_message ?? ''`.
  userMessage: nullTo(Schema.String, ''),
  gitBranch: Schema.NullOr(Schema.String),
  prRefs: stringArrayJson,
  spawnToolUseIds: stringArrayJson,
  category: Schema.String,
  subCategory: Schema.NullOr(Schema.String),
  retries: num,
  hasEdits: num,
}).pipe(
  Schema.encodeKeys({
    sourceId: 'source_id',
    sessionId: 'session_id',
    turnIndex: 'turn_index',
    userMessage: 'user_message',
    gitBranch: 'git_branch',
    prRefs: 'pr_refs_json',
    spawnToolUseIds: 'spawn_tool_use_ids_json',
    subCategory: 'sub_category',
    hasEdits: 'has_edits',
  }),
)
export type LedgerTurnRow = Schema.Schema.Type<typeof ledgerTurnRowSchema>

// ── LedgerCallRow ───────────────────────────────────────────────────────

export const ledgerCallRowSchema = Schema.Struct({
  sourceId: num,
  sessionId: Schema.String,
  turnIndex: num,
  callIndex: num,
  callKey: Schema.String,
  dedupKey: Schema.NullOr(Schema.String),
  provider: Schema.String,
  model: Schema.String,
  timestamp: Schema.String,
  // `Schema.Literals([...])`, never `Schema.Literal(a, b)`: `Schema.Literal`
  // takes ONE argument and silently drops the rest (rule R1).
  speed: Schema.Literals(['standard', 'fast']),
  project: Schema.NullOr(Schema.String),
  projectPath: Schema.NullOr(Schema.String),
  workingDirectory: Schema.NullOr(Schema.String),
  baseCostUSD: num,
  isEstimated: num,
  savingsUSD: num,
  savingsBaselineModel: Schema.NullOr(Schema.String),
  inputTokens: num,
  outputTokens: num,
  cacheCreationInputTokens: num,
  cacheReadInputTokens: num,
  cachedInputTokens: num,
  reasoningTokens: num,
  webSearchRequests: num,
  cacheCreationOneHourTokens: num,
  agentType: Schema.NullOr(Schema.String),
  tools: stringArrayJson,
  mcpTools: stringArrayJson,
  skills: stringArrayJson,
  subagentTypes: stringArrayJson,
  bashCommands: stringArrayJson,
  toolSequence: toolCallMatrixJson,
  locAdded: Schema.NullOr(finiteNumber),
  locRemoved: Schema.NullOr(finiteNumber),
  interrupted: num,
  userModified: num,
  toolErrors: Schema.NullOr(finiteNumber),
  editFailed: Schema.NullOr(finiteNumber),
}).pipe(
  Schema.encodeKeys({
    sourceId: 'source_id',
    sessionId: 'session_id',
    turnIndex: 'turn_index',
    callIndex: 'call_index',
    callKey: 'call_key',
    dedupKey: 'dedup_key',
    projectPath: 'project_path',
    workingDirectory: 'working_directory',
    baseCostUSD: 'base_cost_usd',
    isEstimated: 'is_estimated',
    savingsUSD: 'savings_usd',
    savingsBaselineModel: 'savings_baseline_model',
    inputTokens: 'input_tokens',
    outputTokens: 'output_tokens',
    cacheCreationInputTokens: 'cache_creation_input_tokens',
    cacheReadInputTokens: 'cache_read_input_tokens',
    cachedInputTokens: 'cached_input_tokens',
    reasoningTokens: 'reasoning_tokens',
    webSearchRequests: 'web_search_requests',
    cacheCreationOneHourTokens: 'cache_creation_one_hour_tokens',
    agentType: 'agent_type',
    tools: 'tools_json',
    mcpTools: 'mcp_tools_json',
    skills: 'skills_json',
    subagentTypes: 'subagent_types_json',
    bashCommands: 'bash_commands_json',
    toolSequence: 'tool_sequence_json',
    locAdded: 'loc_added',
    locRemoved: 'loc_removed',
    userModified: 'user_modified',
    toolErrors: 'tool_errors',
    editFailed: 'edit_failed',
  }),
)
export type LedgerCallRow = Schema.Schema.Type<typeof ledgerCallRowSchema>

// ── PortResult / config shapes ──────────────────────────────────────────

export const portResultSchema = Schema.Struct({
  verdict: fileVerdict,
  sourceId: Schema.NullOr(finiteNumber),
  inserted: Schema.Struct({
    sessions: finiteNumber,
    turns: finiteNumber,
    calls: finiteNumber,
  }),
})
export type PortResult = Schema.Schema.Type<typeof portResultSchema>

export const modelAliasSchema = Schema.Struct({
  model: Schema.String,
  aliasOf: Schema.String,
})
export type ModelAlias = Schema.Schema.Type<typeof modelAliasSchema>

export const priceOverrideSchema = Schema.Struct({
  model: Schema.String,
  inputPricePerMillion: finiteNumber,
  outputPricePerMillion: finiteNumber,
})
export type PriceOverride = Schema.Schema.Type<typeof priceOverrideSchema>

export const currencyRateSchema = Schema.Struct({
  code: Schema.String,
  symbol: Schema.String,
  rate: finiteNumber,
  updatedAt: Schema.String,
})
export type CurrencyRate = Schema.Schema.Type<typeof currencyRateSchema>

// ── Config row read-back (DB shape → config shape) ─────────────────────
// The store's config getters read snake_case columns and map them to the
// camelCase config shapes the IPC layer serves (the schemas above). Modeling
// the row shapes here — instead of inline structs in the store — keeps the
// DB→API mapping in the single source of truth (ADR 0003).

export const modelAliasRowSchema = Schema.Struct({
  model: Schema.String,
  aliasOf: Schema.String,
}).pipe(Schema.encodeKeys({ aliasOf: 'alias_of' }))
export type ModelAliasRow = Schema.Schema.Type<typeof modelAliasRowSchema>

export const priceOverrideRowSchema = Schema.Struct({
  model: Schema.String,
  inputPricePerMillion: finiteNumber,
  outputPricePerMillion: finiteNumber,
}).pipe(
  Schema.encodeKeys({
    inputPricePerMillion: 'input_price_per_million',
    outputPricePerMillion: 'output_price_per_million',
  }),
)
export type PriceOverrideRow = Schema.Schema.Type<typeof priceOverrideRowSchema>

export const currencyRateRowSchema = Schema.Struct({
  code: Schema.String,
  symbol: Schema.String,
  rate: finiteNumber,
  updatedAt: Schema.String,
}).pipe(Schema.encodeKeys({ updatedAt: 'updated_at' }))
export type CurrencyRateRow = Schema.Schema.Type<typeof currencyRateRowSchema>
