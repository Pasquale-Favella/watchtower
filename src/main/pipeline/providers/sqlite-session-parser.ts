import { readdir } from 'fs/promises'
import { join } from 'path'

import { fileErrorCode, reportProviderIssue } from '../file-errors.js'
import { calculateCost } from '../models.js'
import { blobToText, isSqliteAvailable, isSqliteBusyError, openDatabase, type SqliteDatabase } from '../sqlite.js'
import { buildAssistantCall, type MessageData, parseTimestamp, type PartData, sanitize } from './session-message.js'
import type { ParsedProviderCall, SessionParser, SessionSource } from './types.js'

type MessageRow = {
  session_id: string
  id: string
  time_created: number
  data: Uint8Array | string
}

type PartRow = {
  message_id: string
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

type SessionRow = {
  id: string
  directory: Uint8Array | string
  title: Uint8Array | string
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

/// The session table a read came from. On an upgraded DB BOTH `session` and
/// `session_v2` exist and hold disjoint-by-id rows, so the table is a
/// PER-SESSION fact threaded down from the single generation decision made in
/// `createSqliteSessionParser` / `discoverSqliteSessions` — never re-derived by
/// the helpers below, which is what keeps "which generation is this?" answered
/// in exactly one place.
type SessionTable = 'session' | 'session_v2'

/// `MessageData` plus the `providerID` sibling the OpenCode stores write next
/// to `modelID` (1.x) and that the 2.x `model` ref carries. Kept local: nothing
/// in `session-message.ts` reads it — the shared builder keys off `modelID` —
/// but serializing it keeps a v2 message byte-comparable with a 1.x one.
type MessageDataWithProvider = MessageData & { providerID?: string }

function tryQuerySessionTokens(
  db: SqliteDatabase,
  sessionId: string,
  table: SessionTable,
): {
  cost: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  model: string | undefined
} | null {
  try {
    const rows = db.query<SessionTokenRow>(
      `SELECT cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, model_id FROM ${table} WHERE id = ?`,
      [sessionId],
    )
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
  } catch {
    return null
  }
}

/// Exact session directory for the canonical project identity. Older vendor
/// schemas have no `directory` column — then this yields undefined and the
/// session flows to the orphan bucket instead of aborting the whole parse
/// (same degradation shape as tryQuerySessionTokens above).
function tryQuerySessionDir(db: SqliteDatabase, sessionId: string, table: SessionTable): string | undefined {
  try {
    const rows = db.query<{ directory: Uint8Array | string }>(
      `SELECT CAST(directory AS BLOB) AS directory FROM ${table} WHERE id = ?`,
      [sessionId],
    )
    return blobToText(rows[0]?.directory) || undefined
  } catch {
    return undefined
  }
}

type SchemaCheckResult = { ok: true } | { ok: false; missing: string[] }

function validateSchemaDetailed(db: SqliteDatabase): SchemaCheckResult {
  const required = ['session', 'message', 'part']
  const missing: string[] = []
  for (const table of required) {
    try {
      db.query<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM ${table} LIMIT 1`)
    } catch (err) {
      if (isSqliteBusyError(err)) throw err
      missing.push(table)
    }
  }
  return missing.length === 0 ? { ok: true } : { ok: false, missing }
}

/// The write generation a DB is on. OpenCode 2.x writes sessions to
/// `session_v2` / `session_message` and FREEZES the 1.x `session` / `message` /
/// `part` tables at the upgrade, so on an upgraded DB BOTH generations' rows are
/// present and a per-session decision is required.
export type SessionGeneration = 'v2' | 'legacy'

function tableExists(db: SqliteDatabase, name: string): boolean {
  try {
    const rows = db.query<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [name])
    return rows.length > 0
  } catch (err) {
    // A locked DB is not an empty one. Swallowing the busy error here would
    // mark a live-but-busy schema as absent, so the whole scan for this file
    // would be recorded as an empty (fully scanned) period.
    if (isSqliteBusyError(err)) throw err
    return false
  }
}

/// Which write generation this DB is on. `'v2'` needs BOTH `session_v2` and
/// `session_message` — half a migration is a legacy DB, and reading it through
/// the v2 path would find no messages at all.
export function detectGeneration(db: SqliteDatabase): SessionGeneration | null {
  if (tableExists(db, 'session_v2') && tableExists(db, 'session_message')) return 'v2'
  return validateSchemaDetailed(db).ok ? 'legacy' : null
}

/// Whether this specific session id exists in `session_v2`. On an upgraded DB
/// the legacy rows are frozen, not dead: a session id that never migrated is
/// still fully readable from `session` / `message` / `part`, and reading it
/// from `session_message` would find nothing and drop its whole history.
function sessionInV2(db: SqliteDatabase, id: string): boolean {
  try {
    const rows = db.query<{ id: string }>('SELECT id FROM session_v2 WHERE id = ?', [id])
    return rows.length > 0
  } catch (err) {
    if (isSqliteBusyError(err)) throw err
    return false
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
      if (!isRecord(parsed)) continue
      payload = parsed
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
    if (isRecord(model)) {
      const providerID = model['providerID']
      const modelID = model['id']
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
    if (isRecord(tokens)) data.tokens = tokens as MessageData['tokens']

    messages.push({ ...base, data: JSON.stringify(data) })

    const parts: PartData[] = []
    const content = payload['content']
    if (Array.isArray(content)) {
      for (const element of content) {
        if (!isRecord(element)) continue
        const type = element['type']
        if (type === 'text' || type === 'reasoning') {
          const text = element['text']
          if (typeof text === 'string' && text.length > 0) parts.push({ type, text })
          continue
        }
        if (type === 'tool') {
          const state = element['state']
          const input = isRecord(state) ? state['input'] : undefined
          const name = element['name']
          parts.push({
            type: 'tool',
            tool: typeof name === 'string' ? name : '',
            // The shared builder reads `state.input.command` for Bash and
            // `state.input.name` / `.subagent_type` for skills and subagents,
            // so a missing or non-object input must still be an object.
            state: { input: isRecord(input) ? input : {} },
          })
        }
      }
    }
    if (parts.length > 0) partsByMsg.set(row.id, parts)
  }

  return { messages, partsByMsg }
}

export function createSqliteSessionParser(
  source: SessionSource,
  seenKeys: Set<string>,
  config: SqliteProviderConfig,
): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      if (!isSqliteAvailable()) {
        reportProviderIssue(config.displayName, 'sqlite-unavailable')
        return
      }

      const segments = source.path.split(':')
      const sessionId = segments[segments.length - 1]!
      const dbPath = segments.slice(0, -1).join(':')

      let db: SqliteDatabase
      try {
        db = openDatabase(dbPath)
      } catch (err) {
        reportProviderIssue(config.displayName, fileErrorCode(err, 'db-open-failed'))
        return
      }

      try {
        // The generation is resolved ONCE per parse — probing sqlite_master per
        // message would tax the hot path. detectGeneration re-throws busy, so a
        // live-but-contended DB aborts this file instead of being recorded as an
        // empty (fully scanned) period.
        const generation = detectGeneration(db)
        if (generation === null) {
          const schema = validateSchemaDetailed(db)
          if (!schema.ok) warnUnrecognizedSchemaOnce(config.displayName, schema.missing)
          return
        }

        // An upgraded DB holds BOTH generations, and the legacy rows are frozen
        // rather than dead: a session id that never migrated is still fully
        // readable from session/message/part, while reading it from
        // session_message would find nothing and drop its whole history. So the
        // per-session id decides, not the DB. This is the ONE place the
        // generation is decided; `sessionTable` is what every read below uses.
        const inV2 = generation === 'v2' ? sessionInV2(db, sessionId) : false
        const effective: SessionGeneration =
          generation === 'v2' && !inV2 && validateSchemaDetailed(db).ok ? 'legacy' : generation
        const sessionTable: SessionTable = effective === 'v2' ? 'session_v2' : 'session'

        // Exact session directory for the canonical project identity. The
        // discovery label is a lossy slug; this is the real checkout path.
        const sessionDir = tryQuerySessionDir(db, sessionId, sessionTable)

        let messages: MessageRow[]
        let parts: PartRow[] = []
        let partsByMsg: Map<string, PartData[]>

        if (effective === 'v2') {
          const shape = v2RowsToLegacyShape(db.query<V2MessageRow>(V2_MESSAGES_SQL, [sessionId]))
          messages = shape.messages
          partsByMsg = shape.partsByMsg
        } else {
          messages = db.query<MessageRow>(LEGACY_MESSAGES_SQL, [sessionId])
          parts = db.query<PartRow>(LEGACY_PARTS_SQL, [sessionId])
          partsByMsg = new Map<string, PartData[]>()
          for (const part of parts) {
            try {
              const parsed = JSON.parse(blobToText(part.data)) as PartData
              const list = partsByMsg.get(part.message_id) ?? []
              list.push(parsed)
              partsByMsg.set(part.message_id, list)
            } catch {
              // skip corrupt part data
            }
          }
        }

        const currentUserMessageBySession = new Map<string, string>()
        let yieldCount = 0
        let parseFailCount = 0
        let roleSkipCount = 0

        for (const msg of messages) {
          let data: MessageData
          try {
            data = JSON.parse(blobToText(msg.data)) as MessageData
          } catch {
            parseFailCount++
            continue
          }

          if (data.role === 'user') {
            const textParts = (partsByMsg.get(msg.id) ?? [])
              .filter(p => p.type === 'text')
              .map(p => p.text ?? '')
              .filter(Boolean)
            if (textParts.length > 0) {
              currentUserMessageBySession.set(msg.session_id, textParts.join(' '))
            }
            continue
          }

          if (data.role !== 'assistant' && data.role !== 'model') {
            if (data.role !== 'user') roleSkipCount++
            continue
          }

          const dedupKey = `${config.providerName}:${msg.session_id}:${msg.id}`
          if (seenKeys.has(dedupKey)) continue

          const call = buildAssistantCall({
            providerName: config.providerName,
            dedupKey,
            sessionId,
            data,
            parts: partsByMsg.get(msg.id) ?? [],
            timeCreatedMs: msg.time_created,
            userMessage: currentUserMessageBySession.get(msg.session_id) ?? '',
            ...(sessionDir ? { directory: sessionDir } : {}),
          })
          if (!call) continue

          seenKeys.add(dedupKey)
          yieldCount++
          yield call
        }

        if (yieldCount === 0 && messages.length > 0) {
          const sessionTokens = tryQuerySessionTokens(db, sessionId, sessionTable)
          if (sessionTokens && (sessionTokens.cost > 0 || sessionTokens.input > 0 || sessionTokens.output > 0)) {
            const dedupKey = `${config.providerName}:${sessionId}:session-level`
            if (!seenKeys.has(dedupKey)) {
              seenKeys.add(dedupKey)
              const model = sessionTokens.model ?? 'unknown'
              let costUSD = calculateCost(
                model,
                sessionTokens.input,
                sessionTokens.output,
                sessionTokens.cacheWrite,
                sessionTokens.cacheRead,
                0,
              )
              if (costUSD === 0 && sessionTokens.cost > 0) costUSD = sessionTokens.cost
              yield {
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
                timestamp: parseTimestamp(messages[0]!.time_created),
                speed: 'standard',
                deduplicationKey: dedupKey,
                userMessage: '',
                sessionId,
                ...(sessionDir ? { projectPath: sessionDir, workingDirectory: sessionDir } : {}),
              }
              yieldCount++
            }
          }

          if (yieldCount === 0 && process.env['WATCHTOWER_VERBOSE'] === '1') {
            process.stderr.write(
              `watchtower: ${config.displayName} session has ${messages.length} messages ` +
                `(${parseFailCount} unparseable, ${roleSkipCount} non-user/assistant roles) ` +
                `but yielded 0 calls. Parts: ${parts.length}.\n`,
            )
          }
        }
      } finally {
        db.close()
      }
    },
  }
}

/// The discovery projection, shared by both generations. `table` is a closed
/// union of the two table names, never caller-supplied.
function SESSION_PROJECTION_SQL(table: SessionTable): string {
  return `SELECT id, CAST(directory AS BLOB) AS directory, CAST(title AS BLOB) AS title, time_created FROM ${table} WHERE time_archived IS NULL AND parent_id IS NULL ORDER BY time_created DESC`
}

/// Legacy top-level sessions on an upgraded DB whose id never migrated. The
/// `NOT IN` is what makes a session present in BOTH tables be read once, by v2.
const LEGACY_UNMIGRATED_SESSIONS_SQL = `SELECT id, CAST(directory AS BLOB) AS directory, CAST(title AS BLOB) AS title, time_created FROM session WHERE parent_id IS NULL AND id NOT IN (SELECT id FROM session_v2) ORDER BY time_created DESC`

export async function discoverSqliteSessions(config: SqliteProviderConfig): Promise<SessionSource[]> {
  if (!isSqliteAvailable()) return []

  let dbPaths: string[]
  try {
    const entries = await readdir(config.dbDir)
    dbPaths = entries
      .filter(f => f.startsWith(config.dbFilePrefix) && f.endsWith('.db'))
      .map(f => join(config.dbDir, f))
  } catch {
    return []
  }

  if (dbPaths.length === 0) return []

  const sessions: SessionSource[] = []
  for (const dbPath of dbPaths) {
    let db: SqliteDatabase
    try {
      db = openDatabase(dbPath)
    } catch {
      continue
    }

    try {
      // The session projection is identical on both generations — only the table
      // the rows come from moves. detectGeneration re-throws busy so a
      // contended DB skips this file instead of being reported as empty.
      const generation = detectGeneration(db)
      if (generation === null) continue

      const rows = db.query<SessionRow>(SESSION_PROJECTION_SQL(generation === 'v2' ? 'session_v2' : 'session'))

      // An upgraded DB has both tables. v2 is the superset for anything that
      // migrated, so the legacy rows are unioned in ONLY for top-level ids that
      // never made it across — otherwise a session present in both is emitted
      // twice, and the frozen-but-unmigrated ones would vanish from the ledger.
      if (generation === 'v2' && validateSchemaDetailed(db).ok) {
        rows.push(...db.query<SessionRow>(LEGACY_UNMIGRATED_SESSIONS_SQL))
      }

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
    } catch {
      // skip this DB
    } finally {
      db.close()
    }
  }

  return sessions
}
