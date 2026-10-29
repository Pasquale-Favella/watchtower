import * as fsPromises from 'node:fs/promises'

import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import { existsSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import { parsedProviderCallSchema } from '../../shared/schemas/providers.js'
import { type AppPaths, readOptionalEnv } from '../config/environment.js'
import { extractBashCommands } from '../../core/ingestion/parsers/bash-utils.js'
import { readCachedResultsEffect, writeCachedResultsEffect } from '../ingestion/cursor-cache.js'
import { fileErrorCode, queueLogRecord, reportProviderIssue } from '../ingestion/file-errors.js'
import { captureScanPricing } from '../pricing/models.js'
import { checkScanAbort, scanIo } from '../ingestion/scan-io.js'
import {
  blobToText,
  isSqliteAvailable,
  isSqliteBusyError,
  openDatabase,
  type SqliteDatabase,
} from '../ingestion/sqlite.js'
import { estimateTokensFromChars } from '../../core/ingestion/parsers/token-estimate.js'
import type { DateRange } from '../../core/domain/observations/types.js'
import type { ParsedProviderCall, Provider, ProviderScanContext, SessionParser, SessionSource } from './types.js'

/** Matches cli-date.ts "all" period cap (6 months). */
const CURSOR_MAX_LOOKBACK_MONTHS = 6

export function getCursorTimeFloor(dateRange?: DateRange, now = new Date()): string {
  const maxStart = new Date(now.getFullYear(), now.getMonth() - CURSOR_MAX_LOOKBACK_MONTHS, now.getDate())
  const start = dateRange?.start ?? maxStart
  const effective = start < maxStart ? maxStart : start
  return effective.toISOString()
}

const CURSOR_COST_MODEL = 'claude-sonnet-4-5'

class CursorDatabaseError extends Schema.TaggedError<CursorDatabaseError>()('CursorDatabaseError', {
  operation: Schema.Literals(['open', 'read', 'close']),
  cause: Schema.Defect(),
  message: Schema.String,
}) {}

function databaseError(operation: CursorDatabaseError['operation'], cause: unknown): CursorDatabaseError {
  const error = cause instanceof Error ? cause : new Error(String(cause), { cause })
  return new CursorDatabaseError({ operation, cause: error, message: error.message })
}

function queryCursorRows(
  db: SqliteDatabase,
  sql: string,
  params?: ReadonlyArray<unknown>,
): Effect.Effect<unknown[], CursorDatabaseError> {
  return Effect.try({
    try: () => db.query<Record<string, unknown>>(sql, params ? [...params] : undefined),
    catch: cause => databaseError('read', cause),
  })
}

const modelDisplayNames: Record<string, string> = {
  'claude-4.5-opus-high-thinking': 'Opus 4.5 (Thinking)',
  'claude-4-opus': 'Opus 4',
  'claude-4-sonnet-thinking': 'Sonnet 4 (Thinking)',
  'claude-4.5-sonnet-thinking': 'Sonnet 4.5 (Thinking)',
  'claude-4.6-sonnet': 'Sonnet 4.6',
  'composer-1': 'Composer 1',
  'grok-code-fast-1': 'Grok Code Fast',
  'gemini-3-pro': 'Gemini 3 Pro',
  'gpt-5.2-low': 'GPT-5.2 Low',
  'gpt-5.2': 'GPT-5.2',
  'gpt-5.1-codex-high': 'GPT-5.1 Codex',
  'gpt-5': 'GPT-5',
  'gpt-4.1': 'GPT-4.1',
  'cursor-auto': 'Cursor (auto)',
}

type BubbleRow = {
  bubble_key: string
  input_tokens: number | null
  output_tokens: number | null
  model: string | null
  created_at: string | null
  request_id: string | null
  user_text: Uint8Array | string | null
  text_length: number | null
  bubble_type: number | null
  code_blocks: Uint8Array | string | null
  /// Only populated on the paged scan path (BUBBLE_QUERY_PAGE) used for very
  /// large databases; undefined on the un-paged BUBBLE_QUERY_SINCE path.
  rid?: number
}

const bubbleRowSchema = Schema.Struct({
  bubble_key: Schema.String,
  input_tokens: Schema.NullOr(Schema.Finite),
  output_tokens: Schema.NullOr(Schema.Finite),
  model: Schema.NullOr(Schema.String),
  created_at: Schema.NullOr(Schema.String),
  request_id: Schema.NullOr(Schema.String),
  user_text: Schema.NullOr(Schema.Union([Schema.Uint8Array, Schema.String])),
  text_length: Schema.NullOr(Schema.Finite),
  bubble_type: Schema.NullOr(Schema.Finite),
  code_blocks: Schema.NullOr(Schema.Union([Schema.Uint8Array, Schema.String])),
  rid: Schema.optional(Schema.Finite),
})
const decodeBubbleRow = Schema.decodeUnknownResult(bubbleRowSchema)

function decodeBubbleRows(values: ReadonlyArray<unknown>): { rows: BubbleRow[]; skipped: number } {
  const rows: BubbleRow[] = []
  let skipped = 0
  for (const value of values) {
    const decoded = decodeBubbleRow(value)
    if (Result.isFailure(decoded)) {
      skipped++
      continue
    }
    rows.push(decoded.success)
  }
  return { rows, skipped }
}

const agentKvRowSchema = Schema.Struct({
  role: Schema.NullOr(Schema.String),
  content: Schema.NullOr(Schema.Union([Schema.Uint8Array, Schema.String])),
  request_id: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
})
const decodeAgentKvRow = Schema.decodeUnknownResult(agentKvRowSchema)

function getCursorDbPath(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  }
  if (process.platform === 'win32') {
    return join(homedir(), 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  }
  return join(homedir(), '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
}

function getCursorWorkspaceStorageDir(globalDbPath: string): string {
  // Sibling of globalStorage. Cursor lays out User/{globalStorage,workspaceStorage}/.
  // We derive the workspaceStorage path from the global DB path so a test or
  // override can supply both consistently from one root.
  // globalDbPath = .../User/globalStorage/state.vscdb
  // workspaceStorage = .../User/workspaceStorage
  const userDir = join(globalDbPath, '..', '..')
  return join(userDir, 'workspaceStorage')
}

/// Per-conversation workspace lookup table. Cursor stores each chat as
/// `bubbleId:<composerId>:<bubbleUuid>` rows in the GLOBAL state.vscdb but
/// does NOT carry a workspace path on the bubble itself. The mapping lives
/// in per-workspace dirs at `workspaceStorage/<hash>/`:
///   - `workspace.json` carries the folder URI (`file:///Users/me/proj`)
///   - `state.vscdb`'s `ItemTable['composer.composerData']` lists every
///     composerId opened in that workspace
/// We walk every workspace dir, pull both, and build composerId -> folder.
type WorkspaceMapping = {
  composerToWorkspace: Map<string, string> // composerId -> folder URI
  workspaceProjectName: Map<string, string> // folder URI -> sanitized project name
}

function getComposerFilter(
  workspaceTag: string,
  workspaceMap: WorkspaceMapping | null,
): { readonly composers: Set<string> | null; readonly mode: 'include' | 'exclude' } {
  if (workspaceTag === '__all__' || workspaceMap === null) return { composers: null, mode: 'include' }
  if (workspaceTag === ORPHAN_TAG) {
    return { composers: new Set(workspaceMap.composerToWorkspace.keys()), mode: 'exclude' }
  }
  const composers = new Set<string>()
  for (const [composerId, folder] of workspaceMap.composerToWorkspace) {
    if (folder === workspaceTag) composers.add(composerId)
  }
  return { composers, mode: 'include' }
}

const ORPHAN_TAG = '__orphan__'
// Catch-all project label for composers that did not register against any
// workspace. When the user has no workspaces at all this is the only label
// shown, matching the pre-PR `cursor` project so legacy installs are not
// renamed by the breakdown change.
const ORPHAN_PROJECT = 'cursor'

function sanitizeWorkspaceUri(uri: string): string {
  // Mirrors Claude's slug convention so two providers reporting the same
  // project path produce identical project keys for cross-provider rollup.
  // file:///Users/me/myproject → -Users-me-myproject
  // vscode-remote://wsl+Ubuntu/home/me/proj → -wsl-Ubuntu-home-me-proj
  let path: string
  if (uri.startsWith('file://')) {
    path = uri.slice('file://'.length)
  } else {
    // Other URI schemes (vscode-remote://, ssh+remote://, etc.): swap "://"
    // for a leading "/" so the slugifier produces a predictable shape.
    path = uri.replace(/^[^:]+:\/\//, '/').replace(/\+/g, '-')
  }
  try {
    path = decodeURIComponent(path)
  } catch {
    // Malformed percent encoding — keep as-is rather than throw.
  }
  return path.replace(/\/+/g, '-')
}

/// Decode a workspace folder URI to a local filesystem path for the canonical
/// project identity. Only `file://` URIs map to a real checkout; remote
/// flavours (vscode-remote, ssh, wsl) have no host-local path and yield
/// undefined so those sessions keep flowing to the orphan bucket instead of
/// inventing an identity. Visible for tests.
export function workspaceFsPath(uri: string): string | undefined {
  if (!uri.startsWith('file://')) return undefined
  let path = uri.slice('file://'.length)
  try {
    path = decodeURIComponent(path)
  } catch {
    // Malformed percent encoding — keep the raw remainder rather than throw.
  }
  // file:///C:/work → C:/work (drop the URI-root slash before a drive letter).
  return path.replace(/^\/([a-zA-Z]:\/)/, '$1')
}

let workspaceMapCache: WorkspaceMapping | null = null
let workspaceMapCacheRoot: string | null = null

/// Attach a source's exact checkout to one parsed call for the canonical
/// project identity. A local workspace path sets both path fields; an
/// undefined checkout (remote URI, orphan source) leaves the call untouched
/// so the session keeps flowing to the orphan bucket. Pure — the yield-attach
/// seam under test without a bubble-DB fixture.
export function attachWorkspacePaths(call: ParsedProviderCall, workspacePath: string | undefined): ParsedProviderCall {
  return workspacePath ? { ...call, projectPath: workspacePath, workingDirectory: workspacePath } : call
}

/// Visible for tests so a fixture can rebuild the map after writing fresh
/// workspace directories.
export function clearCursorWorkspaceMapCache(): void {
  workspaceMapCache = null
  workspaceMapCacheRoot = null
}

const workspaceJsonSchema = Schema.fromJsonString(Schema.Struct({ folder: Schema.optional(Schema.String) }))
const decodeWorkspaceJson = Schema.decodeUnknownResult(workspaceJsonSchema)
const workspaceComposersSchema = Schema.fromJsonString(
  Schema.Struct({ allComposers: Schema.optional(Schema.Array(Schema.Unknown)) }),
)
const decodeWorkspaceComposers = Schema.decodeUnknownResult(workspaceComposersSchema)
const workspaceComposerSchema = Schema.Struct({ composerId: Schema.optional(Schema.Unknown) })
const decodeWorkspaceComposer = Schema.decodeUnknownResult(workspaceComposerSchema)
const decodeString = Schema.decodeUnknownResult(Schema.String)
const workspaceValueRowSchema = Schema.Struct({ value: Schema.String })
const decodeWorkspaceValueRow = Schema.decodeUnknownResult(workspaceValueRowSchema)

const loadWorkspaceMapEffect = Effect.fnUntraced(function* (
  workspaceStorageDir: string,
  signal?: AbortSignal,
): Effect.fn.Return<WorkspaceMapping, Error> {
  const cached = yield* Effect.sync(() =>
    workspaceMapCache && workspaceMapCacheRoot === workspaceStorageDir ? workspaceMapCache : null,
  )
  if (cached) return cached

  const result: WorkspaceMapping = { composerToWorkspace: new Map(), workspaceProjectName: new Map() }
  const entries = yield* scanIo(() => fsPromises.readdir(workspaceStorageDir), signal).pipe(
    Effect.catch(() => Effect.as(checkScanAbort(signal), [] as string[])),
  )

  for (const hashDir of entries) {
    yield* checkScanAbort(signal)
    const wsJsonPath = join(workspaceStorageDir, hashDir, 'workspace.json')
    const wsDbPath = join(workspaceStorageDir, hashDir, 'state.vscdb')
    const json = yield* scanIo(() => fsPromises.readFile(wsJsonPath, 'utf-8'), signal).pipe(
      Effect.catch(() => Effect.as(checkScanAbort(signal), null)),
    )
    if (json === null) continue
    const decodedWorkspace = decodeWorkspaceJson(json)
    if (Result.isFailure(decodedWorkspace) || !decodedWorkspace.success.folder) continue
    const folder = decodedWorkspace.success.folder
    const dbExists = yield* Effect.try({
      try: () => existsSync(wsDbPath),
      catch: cause => (cause instanceof Error ? cause : new Error(String(cause), { cause })),
    })
    if (!dbExists) continue

    const rows = yield* Effect.acquireUseRelease(
      openCursorDatabase(wsDbPath).pipe(
        Effect.catchTag('CursorDatabaseError', error =>
          isSqliteBusyError(error) ? Effect.fail(error) : Effect.succeed(null),
        ),
      ),
      owned =>
        owned
          ? queryCursorRows(
              owned.db,
              "SELECT value FROM ItemTable WHERE key IN ('composer.composerData', 'composer.composerHeaders')",
            ).pipe(
              Effect.catchTag('CursorDatabaseError', error =>
                isSqliteBusyError(error) ? Effect.fail(error) : Effect.succeed([]),
              ),
            )
          : Effect.succeed([]),
      owned => (owned ? closeCursorDatabase(owned) : Effect.void),
    )

    let added = 0
    for (const value of rows) {
      const decodedRow = decodeWorkspaceValueRow(value)
      if (Result.isFailure(decodedRow)) continue
      const decoded = decodeWorkspaceComposers(decodedRow.success.value)
      if (Result.isFailure(decoded)) continue
      for (const composer of decoded.success.allComposers ?? []) {
        const decodedComposer = decodeWorkspaceComposer(composer)
        if (Result.isFailure(decodedComposer)) continue
        const composerId = decodedComposer.success.composerId
        const decodedId = composerId === undefined ? undefined : decodeString(composerId)
        if (!decodedId || Result.isFailure(decodedId) || !decodedId.success) continue
        result.composerToWorkspace.set(decodedId.success, folder)
        added++
      }
    }
    if (added > 0) result.workspaceProjectName.set(folder, sanitizeWorkspaceUri(folder))
  }

  yield* Effect.sync(() => {
    workspaceMapCache = result
    workspaceMapCacheRoot = workspaceStorageDir
  })
  return result
})

/// Pulls the composer id out of a `bubbleId:<composerId>:<bubbleUuid>` key.
/// Returns null when the composer segment contains a CR/LF, which is the
/// signature Cursor uses for tool-call sub-composer rows in real data —
/// e.g. `bubbleId:task-call_xxxx\nfc_yyyy:<bubbleUuid>` is one key with a
/// literal newline between the `task-call_` and `fc_` halves. Those rows
/// are not standalone composers and would otherwise inflate the orphan
/// project's session count.
function parseComposerIdFromKey(key: string | undefined): string | null {
  if (!key) return null
  const firstColon = key.indexOf(':')
  if (firstColon < 0) return null
  const secondColon = key.indexOf(':', firstColon + 1)
  if (secondColon < 0) return null
  const candidate = key.slice(firstColon + 1, secondColon)
  if (!candidate) return null
  // Reject any multi-line / control-char composer id. Real composer ids
  // (UUIDs) and synthetic fixture ids are both single-line.
  if (/[\r\n\x00]/.test(candidate)) return null
  return candidate
}

// Encodes the active workspace into source.path so the parser knows which
// composers to filter for. `#cursor-ws=` is a private separator: `state.vscdb`
// does not contain `#` (we construct the path ourselves), and the literal
// token only appears in source paths emitted from this provider, so there
// is no realistic collision.
const WORKSPACE_SEP = '#cursor-ws='

function encodeSourcePath(dbPath: string, workspaceTag: string): string {
  return `${dbPath}${WORKSPACE_SEP}${workspaceTag}`
}

function decodeSourcePath(sourcePath: string): { dbPath: string; workspaceTag: string } {
  const idx = sourcePath.indexOf(WORKSPACE_SEP)
  // Backwards-compat: a bare DB path with no workspace tag means "give me
  // every call from this DB". Older cached SessionSource entries and any
  // hand-constructed source from a test land here.
  if (idx < 0) return { dbPath: sourcePath, workspaceTag: '__all__' }
  return {
    dbPath: sourcePath.slice(0, idx),
    workspaceTag: sourcePath.slice(idx + WORKSPACE_SEP.length),
  }
}

const codeBlocksJsonSchema = Schema.fromJsonString(Schema.Array(Schema.Unknown))
const decodeCodeBlocksJson = Schema.decodeUnknownResult(codeBlocksJsonSchema)
const codeBlockSchema = Schema.Struct({ languageId: Schema.optional(Schema.Unknown) })
const decodeCodeBlock = Schema.decodeUnknownResult(codeBlockSchema)

function extractLanguages(codeBlocksJson: string | null): string[] {
  if (!codeBlocksJson) return []
  const decoded = decodeCodeBlocksJson(codeBlocksJson)
  if (Result.isFailure(decoded)) return []
  const languages = new Set<string>()
  for (const value of decoded.success) {
    const block = decodeCodeBlock(value)
    if (Result.isFailure(block) || block.success.languageId === undefined) continue
    const language = decodeString(block.success.languageId)
    if (Result.isSuccess(language) && language.success && language.success !== 'plaintext') {
      languages.add(language.success)
    }
  }
  return [...languages]
}

function resolveModel(raw: string | null): string {
  if (!raw || raw === 'default') return CURSOR_COST_MODEL
  return raw
}

function modelForDisplay(raw: string | null): string {
  if (!raw || raw === 'default') return 'cursor-auto'
  return raw
}

const BUBBLE_QUERY_BASE = `
  SELECT
    key as bubble_key,
    json_extract(value, '$.tokenCount.inputTokens') as input_tokens,
    json_extract(value, '$.tokenCount.outputTokens') as output_tokens,
    json_extract(value, '$.modelInfo.modelName') as model,
    json_extract(value, '$.createdAt') as created_at,
    json_extract(value, '$.requestId') as request_id,
    CAST(substr(json_extract(value, '$.text'), 1, 500) AS BLOB) as user_text,
    length(json_extract(value, '$.text')) as text_length,
    json_extract(value, '$.type') as bubble_type,
    CAST(json_extract(value, '$.codeBlocks') AS BLOB) as code_blocks
  FROM cursorDiskKV
  WHERE key LIKE 'bubbleId:%'
`

const AGENTKV_QUERY = `
  SELECT
    json_extract(value, '$.role') as role,
    CAST(json_extract(value, '$.content') AS BLOB) as content,
    json_extract(value, '$.providerOptions.cursor.requestId') as request_id,
    json_extract(value, '$.providerOptions.cursor.modelName') as model
  FROM cursorDiskKV
  WHERE key LIKE 'agentKv:blob:%'
    AND hex(substr(value, 1, 1)) = '7B'
  ORDER BY ROWID ASC
`

const USER_MESSAGES_QUERY = `
  SELECT
    key as bubble_key,
    CAST(substr(json_extract(value, '$.text'), 1, 500) AS BLOB) as text
  FROM cursorDiskKV
  WHERE key LIKE 'bubbleId:%'
    AND json_extract(value, '$.type') = 1
    AND (json_extract(value, '$.createdAt') > ? OR json_extract(value, '$.createdAt') IS NULL)
  ORDER BY ROWID ASC
`

// Split into HEAD (predicates we always emit) and TAIL (ORDER BY) so the
// caller can splice in an optional `ROWID >= ?` cutoff without rewriting
// the whole template. The original combined string is preserved as
// BUBBLE_QUERY_SINCE for any caller that doesn't want the cap.
const BUBBLE_QUERY_SINCE_HEAD =
  BUBBLE_QUERY_BASE +
  `
    AND json_extract(value, '$.createdAt') IS NOT NULL
    AND json_extract(value, '$.createdAt') > ?`
const BUBBLE_QUERY_SINCE_TAIL = `
  ORDER BY ROWID ASC
`
const BUBBLE_QUERY_SINCE = BUBBLE_QUERY_SINCE_HEAD + BUBBLE_QUERY_SINCE_TAIL

// Paged variant for very large DBs: fetches one ROWID-descending page below a
// cursor. Returns ROWID and createdAt so the caller can stop once it has paged
// past the requested window floor. No date predicate here — the caller filters
// by createdAt in JS so it can see the window boundary.
const BUBBLE_QUERY_PAGE = `
  SELECT
    key as bubble_key,
    ROWID as rid,
    json_extract(value, '$.tokenCount.inputTokens') as input_tokens,
    json_extract(value, '$.tokenCount.outputTokens') as output_tokens,
    json_extract(value, '$.modelInfo.modelName') as model,
    json_extract(value, '$.createdAt') as created_at,
    json_extract(value, '$.requestId') as request_id,
    CAST(substr(json_extract(value, '$.text'), 1, 500) AS BLOB) as user_text,
    length(json_extract(value, '$.text')) as text_length,
    json_extract(value, '$.type') as bubble_type,
    CAST(json_extract(value, '$.codeBlocks') AS BLOB) as code_blocks
  FROM cursorDiskKV
  WHERE key LIKE 'bubbleId:%' AND ROWID < ?
  ORDER BY ROWID DESC
  LIMIT ?
`

type UserMsgRow = { bubble_key: string; text: Uint8Array | string }
const userMessageRowSchema = Schema.Struct({
  bubble_key: Schema.String,
  text: Schema.Union([Schema.Uint8Array, Schema.String]),
})
const decodeUserMessageRow = Schema.decodeUnknownResult(userMessageRowSchema)

function decodeUserMessageRows(values: ReadonlyArray<unknown>): { rows: UserMsgRow[]; skipped: number } {
  const rows: UserMsgRow[] = []
  let skipped = 0
  for (const value of values) {
    const decoded = decodeUserMessageRow(value)
    if (Result.isFailure(decoded)) {
      skipped++
      continue
    }
    rows.push(decoded.success)
  }
  return { rows, skipped }
}

/// Per-conversation user-message buffer. We pop messages in arrival order via
/// the `pos` cursor — a previous implementation called Array.shift() which is
/// O(n) per call on large conversations and pinned multi-GB Cursor DBs at
/// minutes-of-parse for power users. The cursor walk is O(1).
type UserMessageQueue = {
  messages: string[]
  pos: number
}

function buildUserMessageMap(rows: ReadonlyArray<UserMsgRow>): Map<string, UserMessageQueue> {
  const map = new Map<string, UserMessageQueue>()
  for (const row of rows) {
    const composerId = parseComposerIdFromKey(row.bubble_key)
    if (!composerId || !row.text) continue
    const text = blobToText(row.text)
    const existing = map.get(composerId)
    if (existing) {
      existing.messages.push(text)
    } else {
      map.set(composerId, { messages: [text], pos: 0 })
    }
  }
  return map
}

function takeUserMessage(queues: Map<string, UserMessageQueue>, conversationId: string): string {
  const queue = queues.get(conversationId)
  if (!queue || queue.pos >= queue.messages.length) return ''
  const msg = queue.messages[queue.pos]
  queue.pos += 1
  return msg
}

/// Scans bubbles for very large DBs by paging ROWID-descending (newest first),
/// keeping only rows within the requested window (createdAt > timeFloor), and
/// stopping once a full page lands below the floor. A `budget` caps the number
/// of in-range bubbles collected so a genuinely enormous in-range scan can't
/// stall; `truncated` is set only when that budget is actually hit, so the
/// caller warns only when older in-range sessions were really dropped.
const scanBubblesPagedEffect = Effect.fnUntraced(function* (
  db: SqliteDatabase,
  timeFloor: string,
  budget: number,
): Effect.fn.Return<{ rows: BubbleRow[]; truncated: boolean; skipped: number }, CursorDatabaseError> {
  const BATCH = 25_000
  const collected: BubbleRow[] = []
  let beforeRowId = Number.MAX_SAFE_INTEGER
  let truncated = false
  let skipped = 0

  paging: while (true) {
    const rawBatch = yield* queryCursorRows(db, BUBBLE_QUERY_PAGE, [beforeRowId, BATCH])
    const decoded = decodeBubbleRows(rawBatch)
    skipped += decoded.skipped
    const batch = decoded.rows
    if (batch.length === 0) break

    for (const row of batch) {
      if (collected.length >= budget) {
        truncated = true
        break paging
      }
      if (row.created_at != null && row.created_at > timeFloor) collected.push(row)
    }

    const oldest = batch[batch.length - 1]
    if (!oldest) break
    beforeRowId = oldest.rid ?? 0
    if (beforeRowId <= 0 || batch.length < BATCH) break
    if (oldest.created_at != null && oldest.created_at <= timeFloor) break
  }

  collected.sort((left, right) => (left.rid ?? 0) - (right.rid ?? 0))
  return { rows: collected, truncated, skipped }
})

// Cursor leaves the per-bubble tokenCount at {0,0} on current builds. The only
// real input figure on disk is the latest context-window snapshot, which Cursor
// records in composerData.promptTokenBreakdown.totalUsedTokens or
// contextTokensUsed (the in-app context meter). This is not cumulative per-turn,
// so local SQLite undercounts admin-console usage; parity requires the opt-in
// Cursor Admin API: POST api.cursor.com/teams/filtered-usage-events.
// The key-range predicate seeks the primary key instead of scanning the table.
const COMPOSER_META_QUERY = `
  SELECT
    substr(key, length('composerData:') + 1) as composer_id,
    json_extract(value, '$.promptTokenBreakdown.totalUsedTokens') as used,
    json_extract(value, '$.contextTokensUsed') as ctx,
    json_extract(value, '$.createdAt') as created_at
  FROM cursorDiskKV
  WHERE key >= 'composerData:' AND key < 'composerData;'
`

type ComposerMeta = { tokens: number; createdAt: number | null }

const composerMetaRowSchema = Schema.Struct({
  composer_id: Schema.String,
  used: Schema.NullOr(Schema.Finite),
  ctx: Schema.NullOr(Schema.Finite),
  created_at: Schema.NullOr(Schema.Finite),
})
const decodeComposerMetaRow = Schema.decodeUnknownResult(composerMetaRowSchema)

function loadComposerMeta(rows: ReadonlyArray<unknown>): { meta: Map<string, ComposerMeta>; skipped: number } {
  const map = new Map<string, ComposerMeta>()
  let skipped = 0
  for (const value of rows) {
    const decoded = decodeComposerMetaRow(value)
    if (Result.isFailure(decoded)) {
      skipped++
      continue
    }
    const row = decoded.success
    const tokens = (row.used || row.ctx) ?? 0
    if (row.composer_id && tokens > 0) map.set(row.composer_id, { tokens, createdAt: row.created_at ?? null })
  }
  return { meta: map, skipped }
}

type AgentStream = {
  tools: string[]
  bash: string[]
  userChars: number
  contextChars: number
  assistantChars: number
  model: string | null
}

function newAgentStream(): AgentStream {
  return { tools: [], bash: [], userChars: 0, contextChars: 0, assistantChars: 0, model: null }
}

// agentKv rows store content as a plain string or a block array; count only
// the text inside blocks so the JSON envelope and non-text parts are not
// billed as prompt characters.
const contentJsonSchema = Schema.fromJsonString(
  Schema.Union([Schema.Array(Schema.Unknown), Schema.Record(Schema.String, Schema.Unknown)]),
)
const decodeContentJson = Schema.decodeUnknownResult(contentJsonSchema)
const textContentBlockSchema = Schema.Struct({
  text: Schema.optional(Schema.Unknown),
  content: Schema.optional(Schema.Unknown),
})
const decodeTextContentBlock = Schema.decodeUnknownResult(textContentBlockSchema)
const assistantContentJsonSchema = Schema.fromJsonString(Schema.Array(Schema.Unknown))
const decodeAssistantContentJson = Schema.decodeUnknownResult(assistantContentJsonSchema)
const assistantContentBlockSchema = Schema.Struct({
  type: Schema.optional(Schema.Unknown),
  text: Schema.optional(Schema.Unknown),
  toolName: Schema.optional(Schema.Unknown),
  args: Schema.optional(Schema.Unknown),
})
const decodeAssistantContentBlock = Schema.decodeUnknownResult(assistantContentBlockSchema)
const assistantArgsSchema = Schema.Struct({ command: Schema.optional(Schema.Unknown) })
const decodeAssistantArgs = Schema.decodeUnknownResult(assistantArgsSchema)

function contentTextLength(raw: string): number {
  const trimmed = raw.trimStart()
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = decodeContentJson(trimmed)
    if (Result.isFailure(parsed)) return raw.length
    const blocks = Array.isArray(parsed.success) ? parsed.success : [parsed.success]
    let length = 0
    for (const value of blocks) {
      const block = decodeTextContentBlock(value)
      if (Result.isFailure(block)) continue
      const text = block.success.text === undefined ? undefined : decodeString(block.success.text)
      if (text && Result.isSuccess(text)) {
        length += text.success.length
        continue
      }
      const content = block.success.content === undefined ? undefined : decodeString(block.success.content)
      if (content && Result.isSuccess(content)) length += content.success.length
    }
    return length
  }
  return raw.length
}

// Cursor logs the agent's stream (prompt, injected context, tool calls, reply
// deltas) in agentKv blobs keyed by requestId. Bubbles carry the same
// requestId, so the map built from the scanned bubbles joins each request to
// its conversation. Requests with no matching bubble are kept separately:
// they are real sessions (background runs, older builds) that would otherwise
// vanish from totals.
function loadAgentStreams(
  rows: ReadonlyArray<unknown>,
  requestToComposer: Map<string, string>,
): { byComposer: Map<string, AgentStream>; unjoined: Map<string, AgentStream>; skipped: number } {
  const byComposer = new Map<string, AgentStream>()
  const unjoined = new Map<string, AgentStream>()
  let skipped = 0

  const bucketFor = (requestId: string): AgentStream => {
    const composer = requestToComposer.get(requestId)
    const map = composer ? byComposer : unjoined
    const key = composer ?? requestId
    const existing = map.get(key)
    if (existing) return existing
    const fresh = newAgentStream()
    map.set(key, fresh)
    return fresh
  }

  // Only the turn-opening (user) agentKv row carries the requestId; rows that
  // follow inherit it. Rows written BEFORE their request's id appears (the
  // system prompt and opening user prompt at a conversation start) buffer
  // until the next id, and a system row closes the previous request so
  // interleaved sessions cannot inherit across a conversation boundary.
  let currentRequestId: string | null = null
  let pendingUserChars = 0
  let pendingContextChars = 0
  for (const value of rows) {
    const decodedRow = decodeAgentKvRow(value)
    if (Result.isFailure(decodedRow)) {
      skipped++
      continue
    }
    const row = decodedRow.success
    if (row.request_id) {
      currentRequestId = row.request_id
      if (pendingUserChars > 0 || pendingContextChars > 0) {
        const bucket = bucketFor(currentRequestId)
        bucket.userChars += pendingUserChars
        bucket.contextChars += pendingContextChars
        pendingUserChars = 0
        pendingContextChars = 0
      }
    }
    if (row.model && currentRequestId) {
      const bucket = bucketFor(currentRequestId)
      if (!bucket.model) bucket.model = row.model
    }
    if (!row.content) continue

    if (row.role === 'system') {
      pendingContextChars += contentTextLength(blobToText(row.content))
      currentRequestId = null
      continue
    }
    if (row.role === 'user') {
      const len = contentTextLength(blobToText(row.content))
      if (currentRequestId) bucketFor(currentRequestId).userChars += len
      else pendingUserChars += len
      continue
    }
    if (row.role === 'tool') {
      if (currentRequestId) bucketFor(currentRequestId).contextChars += contentTextLength(blobToText(row.content))
      continue
    }
    if (row.role !== 'assistant' || !currentRequestId) continue

    const content = decodeAssistantContentJson(blobToText(row.content))
    if (Result.isFailure(content)) continue
    const bucket = bucketFor(currentRequestId)
    for (const value of content.success) {
      const decodedBlock = decodeAssistantContentBlock(value)
      if (Result.isFailure(decodedBlock)) continue
      const block = decodedBlock.success
      const text = block.text === undefined ? undefined : decodeString(block.text)
      if (text && Result.isSuccess(text)) bucket.assistantChars += text.success.length
      const type = block.type === undefined ? undefined : decodeString(block.type)
      const toolName = block.toolName === undefined ? undefined : decodeString(block.toolName)
      if (!type || Result.isFailure(type) || type.success !== 'tool-call') continue
      if (!toolName || Result.isFailure(toolName) || !toolName.success) continue
      // Cursor's terminal tool is 'Shell'; emit the canonical 'Bash' so the
      // cross-provider tool and command breakdowns merge.
      bucket.tools.push(toolName.success === 'Shell' ? 'Bash' : toolName.success)
      if (toolName.success === 'Shell' && block.args !== undefined) {
        const args = decodeAssistantArgs(block.args)
        if (Result.isFailure(args) || args.success.command === undefined) continue
        const command = decodeString(args.success.command)
        if (Result.isSuccess(command)) bucket.bash.push(...extractBashCommands(command.success))
      }
    }
  }
  return { byComposer, unjoined, skipped }
}

// What drives a conversation's input figure, decided once per conversation so
// the sources can never stack on each other:
//   bubbleTokens - some bubble carries a real tokenCount (older builds), so
//                  per-turn counts are authoritative and nothing is estimated.
//   meter        - the composerData context meter exists; one conversation
//                  record carries it.
//   stream       - no meter, but the agent stream holds the prompt/context; one
//                  conversation record carries the estimate.
//   text         - only visible bubble text exists; estimated per bubble.
type InputSource = 'bubbleTokens' | 'meter' | 'stream' | 'text'

type ComposerScan = {
  hasRealTokens: boolean
  firstBubbleTs: string | null
  assistantTextChars: number
  model: string | null
}

type CursorFacts = {
  readonly bubbles: BubbleRow[]
  readonly composerMeta: ReadonlyArray<unknown>
  readonly agentKv: ReadonlyArray<unknown>
  readonly userMessages: UserMsgRow[]
  readonly skippedRows: number
  readonly truncatedCount: number | null
}

const bubbleCountRowSchema = Schema.Struct({ cnt: Schema.Finite })
const decodeBubbleCountRow = Schema.decodeUnknownResult(bubbleCountRowSchema)

const validateCursorSchema = Effect.fnUntraced(function* (
  db: SqliteDatabase,
): Effect.fn.Return<boolean, CursorDatabaseError> {
  const result = yield* Effect.result(queryCursorRows(db, 'SELECT 1 FROM cursorDiskKV LIMIT 0'))
  if (Result.isFailure(result)) {
    if (isSqliteBusyError(result.failure)) return yield* Effect.fail(result.failure)
    return false
  }
  return true
})

const readCursorFacts = Effect.fnUntraced(function* (
  db: SqliteDatabase,
  timeFloor: string,
): Effect.fn.Return<CursorFacts, CursorDatabaseError> {
  const countResult = yield* Effect.result(
    queryCursorRows(db, "SELECT COUNT(*) as cnt FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'"),
  )
  let total = 0
  if (Result.isFailure(countResult)) {
    if (isSqliteBusyError(countResult.failure)) return yield* Effect.fail(countResult.failure)
  } else {
    const count = countResult.success[0] === undefined ? undefined : decodeBubbleCountRow(countResult.success[0])
    if (count && Result.isSuccess(count)) total = count.success.cnt
  }

  const maxBubblesRaw = yield* readOptionalEnv('WATCHTOWER_CURSOR_MAX_BUBBLES')
  const maxBubbles = Number(maxBubblesRaw) || 250_000
  let bubbles: BubbleRow[]
  let skippedRows = 0
  let truncatedCount: number | null = null
  if (total > maxBubbles) {
    const paged = yield* scanBubblesPagedEffect(db, timeFloor, maxBubbles)
    bubbles = paged.rows
    skippedRows += paged.skipped
    if (paged.truncated) truncatedCount = total
  } else {
    const result = yield* Effect.result(queryCursorRows(db, BUBBLE_QUERY_SINCE, [timeFloor]))
    if (Result.isFailure(result)) {
      if (isSqliteBusyError(result.failure)) return yield* Effect.fail(result.failure)
      bubbles = []
    } else {
      const decoded = decodeBubbleRows(result.success)
      bubbles = decoded.rows
      skippedRows += decoded.skipped
    }
  }

  const readOptionalRows = (sql: string, params?: ReadonlyArray<unknown>) =>
    queryCursorRows(db, sql, params).pipe(
      Effect.catchTag('CursorDatabaseError', error =>
        isSqliteBusyError(error) ? Effect.fail(error) : Effect.succeed([]),
      ),
    )
  const composerMeta = yield* readOptionalRows(COMPOSER_META_QUERY)
  const agentKv = yield* readOptionalRows(AGENTKV_QUERY)
  const rawUserMessages = yield* readOptionalRows(USER_MESSAGES_QUERY, [timeFloor])
  const userMessages = decodeUserMessageRows(rawUserMessages)
  skippedRows += userMessages.skipped

  return {
    bubbles,
    composerMeta,
    agentKv,
    userMessages: userMessages.rows,
    skippedRows,
    truncatedCount,
  }
})

type CursorCandidate = Omit<ParsedProviderCall, 'costUSD'> & { pricingModel: string }

function parseBubbles(
  rows: BubbleRow[],
  composerMetaRows: ReadonlyArray<unknown>,
  agentKvRows: ReadonlyArray<unknown>,
  userMessageRows: ReadonlyArray<UserMsgRow>,
  skippedRows: number,
  truncatedCount: number | null,
  seenKeys: Set<string>,
  agentKvTimestamp: string,
): { calls: CursorCandidate[] } {
  const results: CursorCandidate[] = []
  const composerMetaResult = loadComposerMeta(composerMetaRows)
  const composerMeta = composerMetaResult.meta
  let skipped = skippedRows + composerMetaResult.skipped
  if (truncatedCount !== null) {
    queueLogRecord({
      logEvent: 'scan.file-error',
      level: 'warn',
      fields: { op: 'scan', provider: 'cursor', code: 'scan-truncated', count: truncatedCount },
    })
  }

  // Pre-pass: per-conversation facts the crediting decisions need, plus the
  // requestId join for the agent stream — all from the rows already fetched,
  // so no extra unbudgeted table scans.
  const scans = new Map<string, ComposerScan>()
  const requestToComposer = new Map<string, string>()
  for (const row of rows) {
    const cid = parseComposerIdFromKey(row.bubble_key)
    if (!cid) continue
    if (row.request_id) requestToComposer.set(row.request_id, cid)
    let scan = scans.get(cid)
    if (!scan) {
      scan = { hasRealTokens: false, firstBubbleTs: null, assistantTextChars: 0, model: null }
      scans.set(cid, scan)
    }
    if ((row.input_tokens ?? 0) > 0 || (row.output_tokens ?? 0) > 0) scan.hasRealTokens = true
    if (!scan.firstBubbleTs && row.created_at) scan.firstBubbleTs = row.created_at
    if (row.bubble_type !== 1) scan.assistantTextChars += row.text_length ?? 0
    if (!scan.model && row.model) scan.model = row.model
  }

  const agentStreamResult = loadAgentStreams(agentKvRows, requestToComposer)
  const { byComposer: agentStreams, unjoined } = agentStreamResult
  skipped += agentStreamResult.skipped
  const userMessages = buildUserMessageMap(userMessageRows)
  const lastUserMsg = new Map<string, string>()

  const inputSource = (cid: string): InputSource => {
    if (scans.get(cid)?.hasRealTokens) return 'bubbleTokens'
    if (composerMeta.has(cid)) return 'meter'
    const stream = agentStreams.get(cid)
    if ((stream?.userChars ?? 0) + (stream?.contextChars ?? 0) > 0) return 'stream'
    return 'text'
  }

  const emit = (
    call: Omit<
      ParsedProviderCall,
      | 'costUSD'
      | 'provider'
      | 'speed'
      | 'cacheCreationInputTokens'
      | 'cacheReadInputTokens'
      | 'cachedInputTokens'
      | 'reasoningTokens'
      | 'webSearchRequests'
      | 'costIsEstimated'
    > & { pricingModel: string },
  ): void => {
    results.push({
      provider: 'cursor',
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      speed: 'standard',
      // Output is a reply-text estimate and the input meter is the latest
      // context snapshot, not a per-turn sum, so no cursor figure is exact.
      costIsEstimated: true,
      ...call,
    })
  }

  const toolsAttached = new Set<string>()
  for (const row of rows) {
    try {
      // The real composerId lives in the row key `bubbleId:<composerId>:<uuid>`
      // (the JSON conversationId field is empty in current builds).
      // parseComposerIdFromKey returns null for non-UUID composer segments
      // (tool-call output rows and similar shapes), which are NOT sessions.
      const conversationId = parseComposerIdFromKey(row.bubble_key)
      if (!conversationId) {
        skipped++
        continue
      }
      const createdAt = row.created_at
      if (!createdAt) continue

      // Pair each user turn with its own prompt (even when the turn itself
      // emits nothing) so the assistant reply that follows classifies against
      // the right question.
      if (row.bubble_type === 1) {
        lastUserMsg.set(conversationId, takeUserMessage(userMessages, conversationId))
      }

      let inputTokens = row.input_tokens ?? 0
      let outputTokens = row.output_tokens ?? 0
      if (inputTokens === 0 && outputTokens === 0) {
        const textLen = row.text_length ?? 0
        if (row.bubble_type === 1) {
          // Conversation-level input (meter or stream) is emitted once after
          // this loop; per-bubble text only counts when it is the
          // conversation's best available signal.
          if (inputSource(conversationId) === 'text' && textLen > 0) {
            inputTokens = estimateTokensFromChars(textLen)
          }
        } else {
          outputTokens = estimateTokensFromChars(textLen)
        }
        if (inputTokens === 0 && outputTokens === 0) continue
      }

      // Use the SQLite row key (bubbleId:<unique>) as the dedup key.
      // Cursor mutates token counts on the row in place when streaming
      // completes — including tokens in the dedup key (the previous
      // implementation) caused the same bubble to be counted twice once
      // its tokens stabilized.
      const dedupKey = `cursor:bubble:${row.bubble_key}`
      if (seenKeys.has(dedupKey)) continue
      seenKeys.add(dedupKey)

      // User bubbles (type=1) carry no modelInfo, so fall back to the
      // conversation's model seen on its assistant bubbles or agent stream.
      const effectiveModel =
        row.model ?? scans.get(conversationId)?.model ?? agentStreams.get(conversationId)?.model ?? null
      const pricingModel = resolveModel(effectiveModel)
      const userQuestion = lastUserMsg.get(conversationId) ?? ''
      const assistantText = blobToText(row.user_text)
      const userText = (userQuestion + ' ' + assistantText).trim()

      const languages = extractLanguages(blobToText(row.code_blocks))
      const hasCode = languages.length > 0

      // Meter/stream conversations carry their agent tools on the synthetic
      // conversation record below; the rest attach them to their first
      // emitted call so they are counted exactly once.
      let agentTurn: AgentStream | undefined
      const source = inputSource(conversationId)
      if ((source === 'text' || source === 'bubbleTokens') && !toolsAttached.has(conversationId)) {
        agentTurn = agentStreams.get(conversationId)
        if (agentTurn) toolsAttached.add(conversationId)
      }

      emit({
        model: modelForDisplay(effectiveModel),
        inputTokens,
        outputTokens,
        pricingModel,
        tools: [...(hasCode ? ['cursor:edit', ...languages.map(l => `lang:${l}`)] : []), ...(agentTurn?.tools ?? [])],
        bashCommands: agentTurn?.bash ?? [],
        timestamp: createdAt,
        deduplicationKey: dedupKey,
        userMessage: userText,
        sessionId: conversationId,
      })
    } catch {
      skipped++
    }
  }

  // One conversation-level input record per metered/stream conversation,
  // anchored to the conversation's own start (composerData.createdAt) so the
  // credited day never depends on the parse window or cache state, and keyed
  // by composerId so re-parses and daily-cache gap fills dedupe instead of
  // multiplying. The meter is the LATEST context size, not a per-turn sum;
  // growth after the anchor day is finalized stays uncounted, which keeps the
  // documented undercount-vs-admin-console tradeoff but never double counts.
  for (const [cid, scan] of scans) {
    const source = inputSource(cid)
    if (source !== 'meter' && source !== 'stream') continue
    const stream = agentStreams.get(cid)
    const meta = composerMeta.get(cid)
    const inputTokens =
      source === 'meter'
        ? (meta?.tokens ?? 0)
        : estimateTokensFromChars((stream?.userChars ?? 0) + (stream?.contextChars ?? 0))
    // Reply text normally lives on assistant bubbles; count the stream's
    // reply deltas only when the bubbles carried none.
    const outputTokens = scan.assistantTextChars > 0 ? 0 : estimateTokensFromChars(stream?.assistantChars ?? 0)
    if (inputTokens === 0 && outputTokens === 0) continue

    const dedupKey = `cursor:composer-input:${cid}`
    if (seenKeys.has(dedupKey)) continue
    seenKeys.add(dedupKey)

    const createdAtMs = meta?.createdAt
    const timestamp =
      typeof createdAtMs === 'number' && createdAtMs > 0 ? new Date(createdAtMs).toISOString() : scan.firstBubbleTs
    if (!timestamp) continue

    const effectiveModel = scan.model ?? stream?.model ?? null
    emit({
      model: modelForDisplay(effectiveModel),
      inputTokens,
      outputTokens,
      pricingModel: resolveModel(effectiveModel),
      tools: stream?.tools ?? [],
      bashCommands: stream?.bash ?? [],
      timestamp,
      deduplicationKey: dedupKey,
      userMessage: '',
      sessionId: cid,
    })
  }

  // Sessions recorded only in the agent stream (no bubble carries their
  // requestId). agentKv stores no timestamps, so these reuse the DB file's
  // mtime as a bounded "last write" time, like the pre-composer parser did.
  for (const [requestId, stream] of unjoined) {
    const inputTokens = estimateTokensFromChars(stream.userChars + stream.contextChars)
    const outputTokens = estimateTokensFromChars(stream.assistantChars)
    if (inputTokens === 0 && outputTokens === 0) continue

    const dedupKey = `cursor:agentKv:${requestId}`
    if (seenKeys.has(dedupKey)) continue
    seenKeys.add(dedupKey)

    emit({
      model: modelForDisplay(stream.model),
      inputTokens,
      outputTokens,
      pricingModel: resolveModel(stream.model),
      tools: stream.tools,
      bashCommands: stream.bash,
      timestamp: agentKvTimestamp,
      deduplicationKey: dedupKey,
      userMessage: '',
      sessionId: requestId,
    })
  }

  if (skipped > 0) {
    queueLogRecord({
      logEvent: 'scan.file-error',
      level: 'warn',
      fields: { op: 'scan', provider: 'cursor', code: 'entries-unreadable', count: skipped },
    })
  }

  return { calls: results }
}

type OwnedDatabase = { readonly db: SqliteDatabase; closed: boolean }

function openCursorDatabase(path: string): Effect.Effect<OwnedDatabase, CursorDatabaseError> {
  return Effect.try({
    try: () => ({ db: openDatabase(path), closed: false }),
    catch: cause => databaseError('open', cause),
  })
}

function closeCursorDatabase(owned: OwnedDatabase): Effect.Effect<void, CursorDatabaseError> {
  return Effect.suspend(() => {
    if (owned.closed) return Effect.void
    owned.closed = true
    return Effect.try({
      try: () => owned.db.close(),
      catch: cause => databaseError('close', cause),
    })
  })
}

const decodeCachedCalls = Schema.decodeUnknownResult(Schema.Array(parsedProviderCallSchema))

function matchesWorkspaceFilter(
  sessionId: string,
  composers: Set<string> | null,
  mode: 'include' | 'exclude',
): boolean {
  if (composers === null) return true
  const included = composers.has(sessionId)
  return mode === 'include' ? included : !included
}

function filterWorkspaceCalls<T extends Pick<ParsedProviderCall, 'sessionId'>>(
  calls: ReadonlyArray<T>,
  composers: Set<string> | null,
  mode: 'include' | 'exclude',
): T[] {
  return calls.filter(call => matchesWorkspaceFilter(call.sessionId, composers, mode))
}

function emitCursorCalls(
  calls: ReadonlyArray<ParsedProviderCall>,
  seenKeys: Set<string>,
  workspacePath: string | undefined,
  signal?: AbortSignal,
): Stream.Stream<ParsedProviderCall, Error> {
  return Stream.fromIterable(calls).pipe(
    Stream.mapEffect(call =>
      Effect.gen(function* () {
        yield* checkScanAbort(signal)
        if (seenKeys.has(call.deduplicationKey)) return Result.fail(undefined)
        seenKeys.add(call.deduplicationKey)
        return Result.succeed(attachWorkspacePaths(call, workspacePath))
      }),
    ),
    Stream.filterMap(value => value),
  )
}

function createParser(
  source: SessionSource,
  seenKeys: Set<string>,
  dateRange?: DateRange,
  paths?: AppPaths,
  pricing = captureScanPricing(),
  signal?: AbortSignal,
): SessionParser<FileSystem.FileSystem> {
  const { dbPath, workspaceTag } = decodeSourcePath(source.path)
  const workspacePath = workspaceFsPath(workspaceTag)

  const parseStream: NonNullable<SessionParser<FileSystem.FileSystem>['parseStream']> = () =>
    Stream.scoped(
      Stream.unwrap(
        Effect.gen(function* () {
          yield* checkScanAbort(signal)
          const timeFloor = getCursorTimeFloor(dateRange, new Date(yield* Clock.currentTimeMillis))
          if (!isSqliteAvailable()) {
            reportProviderIssue('cursor', 'sqlite-unavailable')
            return Stream.empty
          }

          const workspaceMap =
            workspaceTag === '__all__'
              ? null
              : yield* loadWorkspaceMapEffect(getCursorWorkspaceStorageDir(dbPath), signal)
          const { composers: composerFilter, mode: filterMode } = getComposerFilter(workspaceTag, workspaceMap)

          const cachedUnknown = yield* readCachedResultsEffect(dbPath, timeFloor, signal)
          const cached = cachedUnknown === null ? null : decodeCachedCalls(cachedUnknown)
          if (cached !== null && Result.isSuccess(cached)) {
            return emitCursorCalls(
              filterWorkspaceCalls(cached.success, composerFilter, filterMode),
              seenKeys,
              workspacePath,
              signal,
            )
          }

          const acquired = yield* Effect.acquireRelease(
            openCursorDatabase(dbPath).pipe(
              Effect.catchTag('CursorDatabaseError', error => {
                if (isSqliteBusyError(error)) return Effect.fail(error)
                reportProviderIssue('cursor', fileErrorCode(error.cause, 'db-open-failed'))
                return Effect.succeed(null)
              }),
            ),
            owned => (owned ? closeCursorDatabase(owned).pipe(Effect.orDie) : Effect.void),
          )
          if (!acquired) return Stream.empty

          const valid = yield* validateCursorSchema(acquired.db)
          if (!valid) {
            reportProviderIssue('cursor', 'format-unrecognized')
            return Stream.fromEffectDrain(closeCursorDatabase(acquired))
          }

          yield* checkScanAbort(signal)
          const localSeen = new Set<string>()
          const agentKvTimestamp = yield* Effect.try({
            try: () => {
              try {
                return new Date(statSync(dbPath).mtimeMs).toISOString()
              } catch {
                return new Date().toISOString()
              }
            },
            catch: cause => databaseError('read', cause),
          })
          const facts = yield* readCursorFacts(acquired.db, timeFloor)
          const extracted = parseBubbles(
            facts.bubbles,
            facts.composerMeta,
            facts.agentKv,
            facts.userMessages,
            facts.skippedRows,
            facts.truncatedCount,
            localSeen,
            agentKvTimestamp,
          ).calls
          yield* checkScanAbort(signal)
          // The SQLite snapshot is complete. Close it before per-call pricing,
          // which remains lazy and follows downstream stream demand.
          yield* closeCursorDatabase(acquired)

          const cacheCalls: ParsedProviderCall[] = []
          const neutralCalls = Stream.fromIterable(extracted).pipe(
            Stream.mapEffect(candidate =>
              Effect.gen(function* () {
                yield* checkScanAbort(signal)
                const { pricingModel, ...call } = candidate
                const pricedCall: ParsedProviderCall = {
                  ...call,
                  costUSD: pricing.calculateCost(pricingModel, call.inputTokens, call.outputTokens, 0, 0, 0),
                }
                cacheCalls.push(pricedCall)
                return pricedCall
              }),
            ),
          )
          const publicCalls = neutralCalls.pipe(
            Stream.filter(call => matchesWorkspaceFilter(call.sessionId, composerFilter, filterMode)),
            Stream.mapEffect(call =>
              Effect.gen(function* () {
                yield* checkScanAbort(signal)
                if (seenKeys.has(call.deduplicationKey)) return Result.fail(undefined)
                seenKeys.add(call.deduplicationKey)
                return Result.succeed(attachWorkspacePaths(call, workspacePath))
              }),
            ),
            Stream.filterMap(value => value),
          )
          return Stream.concat(
            publicCalls,
            Stream.fromEffectDrain(
              writeCachedResultsEffect(dbPath, cacheCalls, timeFloor, paths?.suppressCacheWrites, signal),
            ),
          )
        }),
      ),
    )

  return {
    parseStream,
  }
}

const discoverCursorSessionsEffect = Effect.fn('discoverCursorSessions')(function* (
  dbPathOverride?: string,
  context?: ProviderScanContext,
): Effect.fn.Return<SessionSource[], Error> {
  yield* checkScanAbort(context?.signal)
  if (!isSqliteAvailable()) return []
  const dbPath = dbPathOverride ?? getCursorDbPath()
  const exists = yield* Effect.try({
    try: () => existsSync(dbPath),
    catch: cause => (cause instanceof Error ? cause : new Error(String(cause), { cause })),
  })
  yield* checkScanAbort(context?.signal)
  if (!exists) return []

  const wsMap = yield* loadWorkspaceMapEffect(getCursorWorkspaceStorageDir(dbPath), context?.signal)
  const sources: SessionSource[] = []
  for (const [folder, project] of wsMap.workspaceProjectName) {
    yield* checkScanAbort(context?.signal)
    const workspacePath = workspaceFsPath(folder)
    sources.push({
      path: encodeSourcePath(dbPath, folder),
      project,
      provider: 'cursor',
      ...(workspacePath ? { workingDirectory: workspacePath } : {}),
    })
  }
  sources.push({ path: encodeSourcePath(dbPath, ORPHAN_TAG), project: ORPHAN_PROJECT, provider: 'cursor' })
  return sources
})

export function createCursorProvider(dbPathOverride?: string, paths?: AppPaths): Provider<FileSystem.FileSystem> {
  return {
    name: 'cursor',
    displayName: 'Cursor',

    modelDisplayName(model: string): string {
      return modelDisplayNames[model] ?? model
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    discoverSessionsEffect: context => discoverCursorSessionsEffect(dbPathOverride, context),

    createSessionParser(
      source: SessionSource,
      seenKeys: Set<string>,
      dateRange?: DateRange,
      context?: ProviderScanContext,
    ): SessionParser<FileSystem.FileSystem> {
      return createParser(source, seenKeys, dateRange, paths, context?.pricing ?? captureScanPricing(), context?.signal)
    },
  }
}

export const cursor = createCursorProvider()
