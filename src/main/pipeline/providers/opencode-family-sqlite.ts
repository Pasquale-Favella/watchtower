import { Effect, Result, Schema, Stream } from 'effect'
import { readdir } from 'fs/promises'
import { join } from 'path'

import { type AppPaths, overrideFor } from '../../env.js'
import { fileErrorCode, reportProviderIssue } from '../file-errors.js'
import { captureScanPricing } from '../models.js'
import { isScanAbortedError } from '../scan-control.js'
import { checkScanAbort, scanIo } from '../scan-io.js'
import type { ScanPricing } from '../scan-pricing.js'
import { blobToText, isSqliteAvailable, isSqliteBusyError, openDatabase, type SqliteDatabase } from '../sqlite.js'
import { buildAssistantCall, type MessageData, parseTimestamp, type PartData, sanitize } from './session-message.js'
import type { ParsedProviderCall, ProviderScanContext, SessionParser, SessionSource } from './types.js'

// ─────────────────────────────────────────────────────────────────────────────
// THIS IS NOT A GENERIC SQLITE READER.
//
// It reads the OpenCode-FAMILY SQLite schema: the one tool wrote, plus the
// forks that write the same tables — `tokens_input` / `tokens_output` /
// `tokens_cache_read` / `tokens_cache_write` / `cost` / `model_id` /
// `parent_id`, and `CAST(data AS BLOB)` for every text column. A tool whose
// SQLite layout differs in any of those is NOT served by this file, whatever
// its filename suggests.
//
// Which schema GENERATION a tool is read as is a per-provider policy, declared
// in that tool's own file through `SqliteProviderConfig.generations` — never
// decided here. A provider opts into a generation by naming it; this module
// only knows how to read the generations the family has published and how to
// pick, per DB and per session, among the ones a provider declared. That is
// the isolation ADR 0006 asks for: a change made for OpenCode cannot alter
// what kilo-code reads, because kilo-code names no OpenCode-2.x table.
//
// ── STRUCTURAL PROPERTY: NO SQL HERE IS BUILT BY INTERPOLATION. ────────────
// Every statement that names a table is a LITERAL inside a `SqliteGeneration`
// method. The mechanism below never concatenates a name off a descriptor into
// a statement: it only calls a method, or runs a statement a method returned.
// A reader verifies the property by reading this file — there is no `${` inside
// any `SELECT`.
//
// It is a structural property, not a promise, because `SqliteGeneration` is
// exported: a descriptor's table names are reachable from any provider file, so
// a future provider could build one out of config and put anything in those
// fields. Owning the statements is what makes such a string inert here instead
// of merely improbable. `tests/sqlite-generation-policy.test.ts` pins it.
// ─────────────────────────────────────────────────────────────────────────────

type MessageRow = {
  session_id: string
  id: string
  time_created: number
  data: Uint8Array | string
}

/// One OpenCode 2.x row of `session_message`. v2 has no `part` table: the
/// message content is inline in the `data` JSON blob, so `type` + `seq` are the
/// only structural columns the legacy shape has no equivalent for.
export type V2MessageRow = {
  session_id: string
  id: string
  type: string
  seq: number
  time_created: number
  data: Uint8Array | string
}

/// One projected top-level session row, as discovery reads it. The `CAST(... AS
/// BLOB)` on the text columns is what lets the reader hand them to `blobToText`
/// instead of letting the driver decode invalid UTF-8 in a V8 CHECK abort.
export type SessionRow = {
  id: string
  directory: Uint8Array | string | null
  title: Uint8Array | string | null
  time_created: number
}

type SessionTokenRow = {
  cost?: number
  tokens_input?: number
  tokens_output?: number
  tokens_reasoning?: number
  tokens_cache_read?: number
  tokens_cache_write?: number
  model_id?: string
}

const sqliteTextSchema = Schema.Union([Schema.String, Schema.Uint8Array])
const nullableSqliteTextSchema = Schema.NullOr(sqliteTextSchema)
const sessionRowSchema = Schema.Struct({
  id: Schema.String,
  directory: nullableSqliteTextSchema,
  title: nullableSqliteTextSchema,
  time_created: Schema.Finite,
})
const legacyMessageRowSchema = Schema.Struct({
  session_id: Schema.String,
  id: Schema.String,
  time_created: Schema.Finite,
  data: sqliteTextSchema,
})
const partRowSchema = Schema.Struct({ message_id: Schema.String, data: sqliteTextSchema })
const v2MessageRowSchema = Schema.Struct({
  session_id: Schema.String,
  id: Schema.String,
  type: Schema.String,
  seq: Schema.Finite,
  time_created: Schema.Finite,
  data: sqliteTextSchema,
})
const objectSchema = Schema.Record(Schema.String, Schema.Unknown)
const decodeSessionRow = Schema.decodeUnknownResult(sessionRowSchema)
const decodeLegacyMessageRow = Schema.decodeUnknownResult(legacyMessageRowSchema)
const decodePartRow = Schema.decodeUnknownResult(partRowSchema)
const decodeV2MessageRow = Schema.decodeUnknownResult(v2MessageRowSchema)
const decodeObject = Schema.decodeUnknownResult(objectSchema)

/// The vendor's own per-session rollup — what the session row itself claims it
/// spent, used only as a fallback for a session whose messages yielded nothing.
export type SessionTotals = {
  cost: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  model: string | undefined
}

/// The `{ messages, partsByMsg }` pair the parse loop consumes, whatever shape
/// the generation's rows arrived in.
export type NormalizedMessages = {
  messages: MessageRow[]
  partsByMsg: Map<string, PartData[]>
  /// Raw rows read out of the generation's `part` table, for the verbose
  /// "yielded 0 calls" notice only. A generation with no part table reports 0 —
  /// the same number the pre-2.x code reported for it.
  partRowCount: number
}

/// One write generation of the family's schema, as a COMPLETE STRATEGY: every
/// statement that names one of its tables lives on it, and the mechanism that
/// drives it only ever calls a method. A provider file names a generation; it
/// never writes SQL the reader then splices a table name into.
///
/// `sessionTable` / `messageTable` / `partTable` are the generation's own
/// bookkeeping — what it is, what the availability probe reports missing, what
/// a test asserts a provider named. No statement is built from them here.
export type SqliteGeneration = {
  /// Stable name for logs, warnings and tests. Never parsed for behaviour.
  label: string
  /// Where the sessions (and the per-session token/cost rollup) live.
  sessionTable: string
  /// Where the messages live.
  messageTable: string
  /// Where the parts live, or `null` for a generation whose message content is
  /// inline in the message blob (2.x has no part table).
  partTable: string | null
  /// Read this generation's messages for one session and shape them into what
  /// the shared parse loop already consumes — including the parts query for a
  /// generation that HAS a part table, so no generation's read order is
  /// decided out here.
  normalizeMessages: (db: SqliteDatabase, sessionId: string) => NormalizedMessages
  /// The session's own vendor rollup, or `null` when there is none / the read
  /// failed ordinarily. A fallback only: a null here costs nothing.
  readSessionTotals: (db: SqliteDatabase, sessionId: string) => SessionTotals | null
  /// The exact session directory for the canonical project identity, or
  /// `undefined` when the schema has no `directory` column. A missing path
  /// costs the session its project identity, never its history.
  readSessionDirectory: (db: SqliteDatabase, sessionId: string) => string | undefined
  /// Whether THIS generation holds this session id — the per-session routing
  /// check, so a session that never migrated is read where its rows live.
  hasSession: (db: SqliteDatabase, sessionId: string) => boolean
  /// Every top-level, unarchived session this generation holds, for discovery.
  projectSessions: (db: SqliteDatabase) => SessionRow[]
  /// Which of this generation's own tables this DB cannot serve, in
  /// declaration order (session, message, part). Empty means available; a
  /// non-empty list is the `schema-drift` warning's evidence.
  missingTables: (db: SqliteDatabase) => string[]
}

/// `MessageData` plus the `providerID` sibling the OpenCode stores write next
/// to `modelID` (1.x) and that the 2.x `model` ref carries. Kept local: nothing
/// in `session-message.ts` reads it — the shared builder keys off `modelID` —
/// but serializing it keeps a v2 message byte-comparable with a 1.x one.
type MessageDataWithProvider = MessageData & { providerID?: string }

/// Every declared generation whose tables ALL exist and are readable, in
/// declaration order — most-preferred first. A generation missing ANY of its
/// tables is not available: half a migration is not a readable generation, and
/// reading it would find no messages at all. The availability probe lives on the
/// generation, so "which tables prove this generation readable" is part of the
/// generation's own statement set and never re-derived here.
function availableGenerations(db: SqliteDatabase, generations: readonly SqliteGeneration[]): SqliteGeneration[] {
  return generations.filter(g => g.missingTables(db).length === 0)
}

/// Which write generation this DB is on: the FIRST generation the provider
/// declared whose tables are all readable, or null when none is. Busy errors
/// propagate out of the probe, so a live-but-contended DB aborts the file
/// instead of being recorded as an empty (fully scanned) period.
export function detectGeneration(
  db: SqliteDatabase,
  generations: readonly SqliteGeneration[],
): SqliteGeneration | null {
  return availableGenerations(db, generations)[0] ?? null
}

/// The generation this SPECIFIC session id is read through. A tool that froze
/// its older tables at a migration keeps them readable: a session id that never
/// migrated is still fully readable where it lives, and reading it through the
/// newer message table would find nothing and drop its whole history. So the
/// per-session id decides, not the DB: the first declared generation that
/// actually holds this id wins, and an id in none of them falls back to the
/// preferred generation. That is one rule, stated without naming any one tool's
/// tables.
function generationForSession(
  db: SqliteDatabase,
  sessionId: string,
  available: readonly SqliteGeneration[],
): SqliteGeneration {
  for (const generation of available) {
    if (generation.hasSession(db, sessionId)) return generation
  }
  return available[0]!
}

/// The tables a provider declared but could not read — the `schema-drift`
/// warning's evidence. Only reached when NO declared generation was available.
/// The names come from each generation, in its own declaration order.
function missingTables(db: SqliteDatabase, generations: readonly SqliteGeneration[]): string[] {
  const missing: string[] = []
  for (const generation of generations) {
    for (const table of generation.missingTables(db)) {
      if (!missing.includes(table)) missing.push(table)
    }
  }
  return missing
}

const warnedSchemas = new Map<string, Set<string>>()

function warnUnrecognizedSchemaOnce(providerLabel: string, missing: string[]): void {
  const providerSet = warnedSchemas.get(providerLabel) ?? new Set()
  const key = missing.slice().sort().join(',')
  if (providerSet.has(key)) return
  providerSet.add(key)
  warnedSchemas.set(providerLabel, providerSet)
  reportProviderIssue(providerLabel, 'schema-drift')
}

export type SqliteProviderConfig = {
  providerName: string
  displayName: string
  dbDir: string
  dbFilePrefix: string
  /// The schema generations this tool's DB may be on, MOST-PREFERRED FIRST.
  ///
  /// This is the tool's own policy statement, and it is the only place one can
  /// be made: the reader above resolves whatever is declared here and never
  /// assumes a generation exists. A tool that has not migrated declares one
  /// generation and is therefore unreachable by any other tool's migration.
  generations: readonly SqliteGeneration[]
}

class SqliteFamilyError extends Schema.TaggedError<SqliteFamilyError>()('SqliteFamilyError', {
  operation: Schema.Literals(['open', 'read', 'close']),
  cause: Schema.Defect(),
  message: Schema.String,
  code: Schema.optional(Schema.String),
  errcode: Schema.optional(Schema.Number),
}) {}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause), { cause })
}

function databaseError(operation: SqliteFamilyError['operation'], cause: unknown): SqliteFamilyError {
  const error = toError(cause) as Error & { code?: unknown; errcode?: unknown }
  return new SqliteFamilyError({
    operation,
    cause: error,
    message: error.message,
    ...(typeof error.code === 'string' ? { code: error.code } : {}),
    ...(typeof error.errcode === 'number' ? { errcode: error.errcode } : {}),
  })
}

const sourceRows = Effect.fnUntraced(function* <A>(
  path: string,
  read: (db: SqliteDatabase) => A,
): Effect.fn.Return<A, SqliteFamilyError> {
  const readResult = yield* Effect.acquireUseRelease(
    Effect.try({
      try: () => openDatabase(path),
      catch: cause => databaseError('open', cause),
    }),
    db => Effect.result(Effect.try({ try: () => read(db), catch: cause => databaseError('read', cause) })),
    db => Effect.try({ try: () => db.close(), catch: cause => databaseError('close', cause) }),
  )
  if (Result.isFailure(readResult)) return yield* Effect.fail(readResult.failure)
  return readResult.success
})

type SourceDatabase = { db: SqliteDatabase; closed: boolean }

function closeSourceDatabase(source: SourceDatabase): Effect.Effect<void, SqliteFamilyError> {
  return Effect.suspend(() => {
    if (source.closed) return Effect.void
    source.closed = true
    return Effect.try({ try: () => source.db.close(), catch: cause => databaseError('close', cause) })
  })
}

const LEGACY_MESSAGES_SQL = `WITH RECURSIVE session_tree(id) AS (
            SELECT id FROM session WHERE id = ?
            UNION
            SELECT child.id
            FROM session child
            JOIN session_tree parent ON child.parent_id = parent.id
            WHERE child.time_archived IS NULL
          )
          SELECT session_id, id, time_created, CAST(data AS BLOB) AS data
          FROM message
          WHERE session_id IN (SELECT id FROM session_tree)
          ORDER BY time_created ASC, id ASC`

const LEGACY_PARTS_SQL = `WITH RECURSIVE session_tree(id) AS (
            SELECT id FROM session WHERE id = ?
            UNION
            SELECT child.id
            FROM session child
            JOIN session_tree parent ON child.parent_id = parent.id
            WHERE child.time_archived IS NULL
          )
          SELECT message_id, CAST(data AS BLOB) AS data
          FROM part
          WHERE session_id IN (SELECT id FROM session_tree)
          ORDER BY message_id, id`

/// The 1.x generation's remaining statements, over the `session` table. Each
/// names its table outright; none of them is assembled from a descriptor field
/// by the mechanism that runs it.
const LEGACY_SESSION_TOTALS_SQL = `SELECT cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, model_id FROM session WHERE id = ?`

const LEGACY_SESSION_DIR_SQL = `SELECT CAST(directory AS BLOB) AS directory FROM session WHERE id = ?`

const LEGACY_HAS_SESSION_SQL = `SELECT id FROM session WHERE id = ?`

const LEGACY_PROJECTION_SQL = `SELECT id, CAST(directory AS BLOB) AS directory, CAST(title AS BLOB) AS title, time_created FROM session WHERE time_archived IS NULL AND parent_id IS NULL ORDER BY time_created DESC`

/// v2 has no part table — the walk returns whole rows, and content arrives
/// inline inside each row's `data` blob. The ORDER BY is the tie-break chain:
/// `time_created` alone is not unique across a forked session tree, and
/// `session_id` + `seq` make the order total and stable across runs.
///
/// `child.time_archived IS NULL` mirrors the legacy walk's filter on purpose, so
/// the two generations agree about which sub-agent sessions contribute. Without
/// it a v2 parent would pull in an archived child's tokens where the legacy path
/// would not — inert on a database that has never archived a child, a silent
/// over-count on one that has.
const V2_MESSAGES_SQL = `WITH RECURSIVE session_tree(id) AS (
            SELECT id FROM session_v2 WHERE id = ?
            UNION
            SELECT child.id
            FROM session_v2 child
            JOIN session_tree parent ON child.parent_id = parent.id
            WHERE child.time_archived IS NULL
          )
          SELECT session_id, id, type, seq, time_created, CAST(data AS BLOB) AS data
          FROM session_message
          WHERE session_id IN (SELECT id FROM session_tree)
          ORDER BY time_created ASC, session_id ASC, seq ASC`

/// The 2.x generation's remaining statements, over the `session_v2` table.
/// Same discipline as the 1.x block above: every table is named in the literal.
const V2_SESSION_TOTALS_SQL = `SELECT cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, model_id FROM session_v2 WHERE id = ?`

const V2_SESSION_DIR_SQL = `SELECT CAST(directory AS BLOB) AS directory FROM session_v2 WHERE id = ?`

const V2_HAS_SESSION_SQL = `SELECT id FROM session_v2 WHERE id = ?`

const V2_PROJECTION_SQL = `SELECT id, CAST(directory AS BLOB) AS directory, CAST(title AS BLOB) AS title, time_created FROM session_v2 WHERE time_archived IS NULL AND parent_id IS NULL ORDER BY time_created DESC`

/// Whether a table exists AND can be read, from a COMPLETE statement the
/// generation supplied. It takes a finished statement rather than a table name
/// precisely so this helper cannot grow the habit the old shared probe had: the
/// name is nowhere in scope to be concatenated into a query.
///
/// A `SELECT 1 … LIMIT 1` rather than a bare `sqlite_master` lookup, for two
/// reasons: a table can be listed while its btree is corrupt, and a generation
/// owning it would then be selected and throw out of the unguarded parse loop;
/// and one row costs the same on an empty table and a multi-million-row one,
/// which `SELECT COUNT(*)` does not.
///
/// A locked DB is not an empty one. Swallowing the busy error here would mark a
/// live-but-busy schema as absent, so the whole scan for this file would be
/// recorded as an empty (fully scanned) period — hence the re-throw.
function tableIsReadable(db: SqliteDatabase, statement: string): boolean {
  try {
    db.query<{ one: number }>(statement)
    return true
  } catch (err) {
    if (isSqliteBusyError(err)) throw err
    return false
  }
}

function decodeRecord(value: unknown): Record<string, unknown> | null {
  const decoded = decodeObject(value)
  return Result.isSuccess(decoded) ? decoded.success : null
}

/// Normalize OpenCode 2.x `session_message` rows into the 1.x `MessageRow` /
/// `PartData` pair the parse loop already consumes, so v2 needs NO downstream
/// change: cost and token math stay in the shared `buildAssistantCall`.
///
/// Drops: `idle`, `synthetic`, `system` and the `*-switched` rows (none is a
/// model call). Keeps `compaction` — a compaction request is a real completion
/// carrying its own cost + tokens, and 1.x counted it as an assistant message,
/// so skipping it would undercount every compacted 2.x session. A compaction
/// still `running` has no cost and no tokens, so the shared builder drops it on
/// its own `allZero && !hasActivity` rule.
export function v2RowsToLegacyShape(rows: readonly V2MessageRow[]): {
  messages: MessageRow[]
  partsByMsg: Map<string, PartData[]>
} {
  const messages: MessageRow[] = []
  const partsByMsg = new Map<string, PartData[]>()

  for (const row of rows) {
    let payload: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(blobToText(row.data))
      const decoded = decodeRecord(parsed)
      if (decoded === null) continue
      payload = decoded
    } catch {
      // skip corrupt message data
      continue
    }

    const base = { session_id: row.session_id, id: row.id, time_created: row.time_created }

    if (row.type === 'user') {
      messages.push({ ...base, data: JSON.stringify({ role: 'user' }) })
      const text = payload['text']
      if (typeof text === 'string' && text.length > 0) {
        partsByMsg.set(row.id, [{ type: 'text', text }])
      }
      continue
    }

    if (row.type !== 'assistant' && row.type !== 'compaction') continue

    const data: MessageDataWithProvider = { role: 'assistant' }

    // 2.x nests the model as a `{ id, providerID }` ref where 1.x wrote a bare
    // `modelID` string next to a sibling `providerID`. `buildAssistantCall`
    // keys off `modelID`, and the pricing resolver tries a provider-prefixed
    // id before the bare one, so the ref is rebuilt as `providerID/id`.
    const model = payload['model']
    const modelRef = decodeRecord(model)
    if (modelRef) {
      const providerID = modelRef['providerID']
      const modelID = modelRef['id']
      if (typeof providerID === 'string' && providerID.length > 0) data.providerID = providerID
      if (
        typeof providerID === 'string' &&
        providerID.length > 0 &&
        typeof modelID === 'string' &&
        modelID.length > 0
      ) {
        data.modelID = `${providerID}/${modelID}`
      }
    }

    const cost = payload['cost']
    if (typeof cost === 'number') data.cost = cost
    const tokens = payload['tokens']
    const tokenRecord = decodeRecord(tokens)
    if (tokenRecord) data.tokens = tokenRecord as MessageData['tokens']

    messages.push({ ...base, data: JSON.stringify(data) })

    const parts: PartData[] = []
    const content = payload['content']
    if (Array.isArray(content)) {
      for (const element of content) {
        const contentRecord = decodeRecord(element)
        if (!contentRecord) continue
        const type = contentRecord['type']
        if (type === 'text' || type === 'reasoning') {
          const text = contentRecord['text']
          if (typeof text === 'string' && text.length > 0) parts.push({ type, text })
          continue
        }
        if (type === 'tool') {
          const state = decodeRecord(contentRecord['state'])
          const input = state?.['input']
          const name = contentRecord['name']
          parts.push({
            type: 'tool',
            tool: typeof name === 'string' ? name : '',
            // The shared builder reads `state.input.command` for Bash and
            // `state.input.name` / `.subagent_type` for skills and subagents,
            // so a missing or non-object input must still be an object.
            state: { input: decodeRecord(input) ?? {} },
          })
        }
      }
    }
    if (parts.length > 0) partsByMsg.set(row.id, parts)
  }

  return { messages, partsByMsg }
}

/// The family's 1.x generation: `session` / `message` / `part`, messages already
/// in the shared shape, parts already separate rows. Published as part of the
/// FAMILY's schema, not as any one tool's — a tool declares it whether it is
/// OpenCode itself, a fork, or a tool that merely borrowed the layout.
///
/// Every statement that names one of those tables is below, written out. The
/// table names in the fields are there for logs and for tests to assert on; no
/// statement above or below is assembled from them.
export const OPENCODE_FAMILY_1X: SqliteGeneration = {
  label: '1.x',
  sessionTable: 'session',
  messageTable: 'message',
  partTable: 'part',
  normalizeMessages(db, sessionId) {
    const messages = db.query(LEGACY_MESSAGES_SQL, [sessionId]).flatMap(raw => {
      const decoded = decodeLegacyMessageRow(raw)
      return Result.isSuccess(decoded) ? [decoded.success] : []
    })
    const rawParts = db.query(LEGACY_PARTS_SQL, [sessionId])
    const partsByMsg = new Map<string, PartData[]>()
    for (const raw of rawParts) {
      const decodedPart = decodePartRow(raw)
      if (Result.isFailure(decodedPart)) continue
      const part = decodedPart.success
      try {
        const decodedData = decodeRecord(JSON.parse(blobToText(part.data)))
        if (!decodedData || typeof decodedData['type'] !== 'string') continue
        const input = decodeRecord(decodeRecord(decodedData['state'])?.['input'])
        const parsed: PartData = {
          type: decodedData['type'],
          ...(typeof decodedData['text'] === 'string' ? { text: decodedData['text'] } : {}),
          ...(typeof decodedData['tool'] === 'string' ? { tool: decodedData['tool'] } : {}),
          ...(input ? { state: { input } } : {}),
        }
        const list = partsByMsg.get(part.message_id) ?? []
        list.push(parsed)
        partsByMsg.set(part.message_id, list)
      } catch {
        // skip corrupt part data
      }
    }
    return { messages, partsByMsg, partRowCount: rawParts.length }
  },
  /// The session row's own vendor rollup. Tolerant by design: a schema without
  /// these columns (or a row that will not read) yields `null`, which costs the
  /// caller a session-level fallback call and nothing else. A busy DB is NOT
  /// ordinary: swallowing it here would report a live-but-contended schema as
  /// one that claimed no totals, so it propagates like the probe's does.
  readSessionTotals(db, sessionId) {
    try {
      const rows = db.query<SessionTokenRow>(LEGACY_SESSION_TOTALS_SQL, [sessionId])
      if (rows.length === 0) return null
      const r = rows[0]!
      return {
        cost: r.cost ?? 0,
        input: r.tokens_input ?? 0,
        output: r.tokens_output ?? 0,
        reasoning: r.tokens_reasoning ?? 0,
        cacheRead: r.tokens_cache_read ?? 0,
        cacheWrite: r.tokens_cache_write ?? 0,
        model: r.model_id ?? undefined,
      }
    } catch (err) {
      if (isSqliteBusyError(err)) throw err
      return null
    }
  },
  /// Older vendor schemas have no `directory` column — then this yields
  /// `undefined` and the session flows to the orphan bucket instead of aborting
  /// the whole parse (same degradation shape as the totals read above, busy
  /// re-thrown the same way).
  readSessionDirectory(db, sessionId) {
    try {
      const rows = db.query<{ directory: Uint8Array | string }>(LEGACY_SESSION_DIR_SQL, [sessionId])
      return blobToText(rows[0]?.directory) || undefined
    } catch (err) {
      if (isSqliteBusyError(err)) throw err
      return undefined
    }
  },
  hasSession(db, sessionId) {
    try {
      return db.query<{ id: string }>(LEGACY_HAS_SESSION_SQL, [sessionId]).length > 0
    } catch (err) {
      if (isSqliteBusyError(err)) throw err
      return false
    }
  },
  projectSessions(db) {
    return db.query<SessionRow>(LEGACY_PROJECTION_SQL)
  },
  /// Declaration order is the order the pre-2.x `schema-drift` warning reported
  /// its missing tables in.
  missingTables(db) {
    const missing: string[] = []
    if (!tableIsReadable(db, 'SELECT 1 AS one FROM session LIMIT 1')) missing.push('session')
    if (!tableIsReadable(db, 'SELECT 1 AS one FROM message LIMIT 1')) missing.push('message')
    if (!tableIsReadable(db, 'SELECT 1 AS one FROM part LIMIT 1')) missing.push('part')
    return missing
  },
}

/// The family's 2.x generation: `session_v2` / `session_message`, no part table
/// (content is inline), and rows shaped by `v2RowsToLegacyShape`. OpenCode 2.x
/// freezes the 1.x tables at the upgrade, so a DB carries both generations at
/// once — which is why the reader resolves per session, not per DB.
export const OPENCODE_FAMILY_2X: SqliteGeneration = {
  label: '2.x',
  sessionTable: 'session_v2',
  messageTable: 'session_message',
  partTable: null,
  normalizeMessages(db, sessionId) {
    const rows = db.query(V2_MESSAGES_SQL, [sessionId]).flatMap(raw => {
      const decoded = decodeV2MessageRow(raw)
      return Result.isSuccess(decoded) ? [decoded.success] : []
    })
    const shape = v2RowsToLegacyShape(rows)
    return { ...shape, partRowCount: 0 }
  },
  /// 2.x writes the same rollup columns on `session_v2`, so the fallback reads
  /// the same totals by the same field mapping. Same tolerance, same re-throw
  /// of busy: only the table in the statement differs from 1.x.
  readSessionTotals(db, sessionId) {
    try {
      const rows = db.query<SessionTokenRow>(V2_SESSION_TOTALS_SQL, [sessionId])
      if (rows.length === 0) return null
      const r = rows[0]!
      return {
        cost: r.cost ?? 0,
        input: r.tokens_input ?? 0,
        output: r.tokens_output ?? 0,
        reasoning: r.tokens_reasoning ?? 0,
        cacheRead: r.tokens_cache_read ?? 0,
        cacheWrite: r.tokens_cache_write ?? 0,
        model: r.model_id ?? undefined,
      }
    } catch (err) {
      if (isSqliteBusyError(err)) throw err
      return null
    }
  },
  readSessionDirectory(db, sessionId) {
    try {
      const rows = db.query<{ directory: Uint8Array | string }>(V2_SESSION_DIR_SQL, [sessionId])
      return blobToText(rows[0]?.directory) || undefined
    } catch (err) {
      if (isSqliteBusyError(err)) throw err
      return undefined
    }
  },
  hasSession(db, sessionId) {
    try {
      return db.query<{ id: string }>(V2_HAS_SESSION_SQL, [sessionId]).length > 0
    } catch (err) {
      if (isSqliteBusyError(err)) throw err
      return false
    }
  },
  projectSessions(db) {
    return db.query<SessionRow>(V2_PROJECTION_SQL)
  },
  /// No part table to probe — content is inline in the message blob — so an
  /// available 2.x generation reports nothing missing.
  missingTables(db) {
    const missing: string[] = []
    if (!tableIsReadable(db, 'SELECT 1 AS one FROM session_v2 LIMIT 1')) missing.push('session_v2')
    if (!tableIsReadable(db, 'SELECT 1 AS one FROM session_message LIMIT 1')) missing.push('session_message')
    return missing
  },
}

/// The shared reader, parameterized by whichever tools the family covers — so
/// the AppPaths seam is ONE trailing slot for the whole family, not one per
/// tool: `paths` is the binding seam convention from `env.ts` (one optional
/// trailing param, always last, read only your own key out of it). The reader
/// reads exactly one key, `WATCHTOWER_VERBOSE`, and only through it — the
/// notice below is the reader's sole env consumer, and it was the last direct
/// `process.env` read left in this file.
///
/// A caller with no seam to thread (`kilo-code.ts` today) omits it and resolves
/// `appPaths()`, which reads the same ambient value the bare read did — so
/// omitting the argument is behavior-preserving, not a silent opt-out.
export function createSqliteSessionParser(
  source: SessionSource,
  seenKeys: Set<string>,
  config: SqliteProviderConfig,
  paths?: AppPaths,
  pricing?: ScanPricing,
  context?: ProviderScanContext,
): SessionParser {
  const signal = context?.signal
  const activePricing = context?.pricing ?? pricing ?? captureScanPricing(paths)
  const segments = source.path.split(':')
  const sessionId = segments[segments.length - 1]!
  const dbPath = segments.slice(0, -1).join(':')

  const parseStream: NonNullable<SessionParser['parseStream']> = () =>
    Stream.scoped(
      Stream.unwrap(
        Effect.gen(function* () {
          yield* checkScanAbort(signal)
          if (!isSqliteAvailable()) {
            reportProviderIssue(config.displayName, 'sqlite-unavailable')
            return Stream.empty
          }

          const acquired = yield* Effect.acquireRelease(
            Effect.try({ try: () => openDatabase(dbPath), catch: cause => databaseError('open', cause) }).pipe(
              Effect.catchTag('SqliteFamilyError', error => {
                if (error.operation === 'open') {
                  reportProviderIssue(config.displayName, fileErrorCode(error.cause, 'db-open-failed'))
                  return Effect.succeed(null)
                }
                return Effect.fail(error)
              }),
              Effect.map(db => (db ? { db, closed: false } : null)),
            ),
            source => (source ? closeSourceDatabase(source).pipe(Effect.orDie) : Effect.void),
          )
          if (!acquired) return Stream.empty
          const db = acquired.db

          const initialized = yield* checkScanAbort(signal).pipe(
            Effect.andThen(
              Effect.try({
                try: () => {
                  const available = availableGenerations(db, config.generations)
                  if (available.length === 0) {
                    warnUnrecognizedSchemaOnce(config.displayName, missingTables(db, config.generations))
                    return null
                  }
                  const generation = generationForSession(db, sessionId, available)
                  const sessionDir = generation.readSessionDirectory(db, sessionId)
                  const normalized = generation.normalizeMessages(db, sessionId)
                  return { generation, sessionDir, ...normalized }
                },
                catch: cause => databaseError('read', cause),
              }),
            ),
            Effect.catch(error => closeSourceDatabase(acquired).pipe(Effect.andThen(Effect.fail(error)))),
          )
          if (!initialized) return Stream.fromEffectDrain(closeSourceDatabase(acquired))

          const currentUserMessageBySession = new Map<string, string>()
          let yieldCount = 0
          let parseFailCount = 0
          let roleSkipCount = 0
          const messageStream = Stream.fromIterable(initialized.messages).pipe(
            Stream.mapEffect(
              msg =>
                Effect.gen(function* () {
                  yield* checkScanAbort(signal)
                  let data: MessageData
                  try {
                    data = JSON.parse(blobToText(msg.data)) as MessageData
                  } catch {
                    parseFailCount++
                    return null
                  }

                  if (data.role === 'user') {
                    const textParts = (initialized.partsByMsg.get(msg.id) ?? [])
                      .filter(part => part.type === 'text')
                      .map(part => part.text ?? '')
                      .filter(Boolean)
                    if (textParts.length > 0) currentUserMessageBySession.set(msg.session_id, textParts.join(' '))
                    return null
                  }
                  if (data.role !== 'assistant' && data.role !== 'model') {
                    if (data.role !== 'user') roleSkipCount++
                    return null
                  }

                  const dedupKey = `${config.providerName}:${msg.session_id}:${msg.id}`
                  if (seenKeys.has(dedupKey)) return null
                  const call = yield* Effect.try({
                    try: () =>
                      buildAssistantCall({
                        providerName: config.providerName,
                        dedupKey,
                        sessionId,
                        data,
                        parts: initialized.partsByMsg.get(msg.id) ?? [],
                        timeCreatedMs: msg.time_created,
                        userMessage: currentUserMessageBySession.get(msg.session_id) ?? '',
                        ...(initialized.sessionDir ? { directory: initialized.sessionDir } : {}),
                        pricing: activePricing,
                      }),
                    catch: toError,
                  })
                  yield* checkScanAbort(signal)
                  if (!call) return null
                  seenKeys.add(dedupKey)
                  yieldCount++
                  return call
                }),
              { concurrency: 1 },
            ),
            Stream.filter((call): call is ParsedProviderCall => call !== null),
            Stream.rechunk(1),
          )

          const fallbackStream = Stream.unwrap(
            Effect.gen(function* () {
              yield* checkScanAbort(signal)
              if (yieldCount === 0 && initialized.messages.length > 0) {
                const sessionTokens = yield* Effect.try({
                  try: () => initialized.generation.readSessionTotals(db, sessionId),
                  catch: cause => databaseError('read', cause),
                })
                yield* checkScanAbort(signal)
                if (sessionTokens && (sessionTokens.cost > 0 || sessionTokens.input > 0 || sessionTokens.output > 0)) {
                  const dedupKey = `${config.providerName}:${sessionId}:session-level`
                  if (!seenKeys.has(dedupKey)) {
                    seenKeys.add(dedupKey)
                    const model = sessionTokens.model ?? 'unknown'
                    const costUSD = yield* Effect.try({
                      try: () => {
                        const calculated = activePricing.calculateCost(
                          model,
                          sessionTokens.input,
                          sessionTokens.output,
                          sessionTokens.cacheWrite,
                          sessionTokens.cacheRead,
                          0,
                        )
                        return calculated === 0 && sessionTokens.cost > 0 ? sessionTokens.cost : calculated
                      },
                      catch: toError,
                    })
                    const timestamp = yield* Effect.try({
                      try: () => parseTimestamp(initialized.messages[0]!.time_created),
                      catch: toError,
                    })
                    yield* checkScanAbort(signal)
                    const call: ParsedProviderCall = {
                      provider: config.providerName,
                      model,
                      inputTokens: sessionTokens.input,
                      outputTokens: sessionTokens.output,
                      cacheCreationInputTokens: sessionTokens.cacheWrite,
                      cacheReadInputTokens: sessionTokens.cacheRead,
                      cachedInputTokens: sessionTokens.cacheRead,
                      reasoningTokens: sessionTokens.reasoning,
                      webSearchRequests: 0,
                      costUSD,
                      tools: [],
                      bashCommands: [],
                      timestamp,
                      speed: 'standard',
                      deduplicationKey: dedupKey,
                      userMessage: '',
                      sessionId,
                      ...(initialized.sessionDir
                        ? { projectPath: initialized.sessionDir, workingDirectory: initialized.sessionDir }
                        : {}),
                    }
                    return Stream.make(call)
                  }
                }
              }
              if (yieldCount === 0 && overrideFor(paths, 'WATCHTOWER_VERBOSE') === '1') {
                process.stderr.write(
                  `watchtower: ${config.displayName} session has ${initialized.messages.length} messages ` +
                    `(${parseFailCount} unparseable, ${roleSkipCount} non-user/assistant roles) ` +
                    `but yielded 0 calls. Parts: ${initialized.partRowCount}.\n`,
                )
              }
              return Stream.empty
            }),
          )
          // EOF and expected read failures close through the typed channel. The
          // scope finalizer is the fallback for early stop or interruption.
          return Stream.concat(
            Stream.concat(messageStream, fallbackStream),
            Stream.fromEffectDrain(closeSourceDatabase(acquired)),
          ).pipe(
            Stream.catch(error =>
              Stream.fromEffect(closeSourceDatabase(acquired).pipe(Effect.andThen(Effect.fail(error)))),
            ),
          )
        }),
      ),
    )

  return {
    parseStream,
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      try {
        yield* Stream.toAsyncIterable(parseStream())
      } catch (error) {
        if (error instanceof SqliteFamilyError) throw error.cause
        throw error
      }
    },
  }
}

/// Every declared generation's top-level unarchived sessions, in declaration
/// order and DEDUPED BY ID: a session present in two generations' tables is
/// surfaced once, by the preferred generation. That is what the pre-2.x union's
/// `NOT IN (SELECT id FROM session_v2)` was hand-rolling — it only ever existed
/// to stop the second projection re-emitting an id the first had, and it had to
/// name another generation's table to do it. Iterating declared generations in
/// order gets the same result without naming any tool's tables: the preferred
/// generation claims the id, and the older generation only contributes the ids
/// that never migrated.
function projectAvailableGenerations(db: SqliteDatabase, available: readonly SqliteGeneration[]): SessionRow[] {
  const rows: SessionRow[] = []
  const claimed = new Set<string>()
  for (const generation of available) {
    for (const raw of generation.projectSessions(db)) {
      const decoded = decodeSessionRow(raw)
      if (Result.isFailure(decoded)) continue
      const row = decoded.success
      if (claimed.has(row.id)) continue
      claimed.add(row.id)
      rows.push(row)
    }
  }
  return rows
}

export const discoverSqliteSessionsEffect = Effect.fnUntraced(function* (
  config: SqliteProviderConfig,
  context?: ProviderScanContext,
): Effect.fn.Return<SessionSource[], Error> {
  if (!isSqliteAvailable()) return []
  const entries = yield* scanIo(() => readdir(config.dbDir), context?.signal).pipe(
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed([]))),
  )
  const dbPaths = entries
    .filter(file => file.startsWith(config.dbFilePrefix) && file.endsWith('.db'))
    .map(file => join(config.dbDir, file))
  const sessions: SessionSource[] = []

  for (const dbPath of dbPaths) {
    yield* checkScanAbort(context?.signal)
    const rows = yield* sourceRows(dbPath, db => {
      const available = availableGenerations(db, config.generations)
      return available.length === 0 ? [] : projectAvailableGenerations(db, available)
    }).pipe(
      Effect.catchTag('SqliteFamilyError', error =>
        error.operation === 'close' ? Effect.fail(toError(error.cause)) : Effect.succeed([]),
      ),
    )
    yield* checkScanAbort(context?.signal)
    for (const row of rows) {
      const dir = blobToText(row.directory)
      const title = blobToText(row.title)
      sessions.push({
        path: `${dbPath}:${row.id}`,
        project: dir ? sanitize(dir) : sanitize(title),
        provider: config.providerName,
        ...(dir ? { workingDirectory: dir } : {}),
      })
    }
  }
  return sessions
})

/// Remove after every consumer composes discovery through discoverSqliteSessionsEffect.
export function discoverSqliteSessions(
  config: SqliteProviderConfig,
  context?: ProviderScanContext,
): Promise<SessionSource[]> {
  return Effect.runPromise(discoverSqliteSessionsEffect(config, context))
}
