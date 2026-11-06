// =============================================================================
// copilot.ts — Copilot provider (multi-source)
// =============================================================================
//
// WHAT CHANGED:
//   The base provider only reads Copilot's JSONL session-state files from
//   ~/.copilot/session-state/, which only log output tokens. Input tokens,
//   cache-read tokens, and cache-creation tokens are never written there, so
//   Copilot costs were underreported by 60-80%.
//
//   This modified version adds VS Code sources that can carry fuller token
//   data: the OTel SQLite store (agent-traces.db), VS Code core chatSessions
//   journals, and legacy extension transcripts. OTel and chatSessions contain
//   input/output token breakdowns for Copilot Chat users; legacy JSONL remains
//   a fallback when richer sources are absent.
//
//   It also adds the Copilot CLI's OWN store, session-store.db, whose
//   `assistant_usage_events` table records one row per API REQUEST. That is the
//   only place a CLI session's per-request input / cache-read / cache-write
//   split exists; the `session.shutdown` rollup in events.jsonl reports the
//   same tokens lumped per model.
//
// HOW TO ENABLE THE OTEL SQLITE STORE:
//   TWO settings must both be enabled in VS Code settings.json:
//
//     {
//       "github.copilot.chat.otel.enabled": true,
//       "github.copilot.chat.otel.dbSpanExporter.enabled": true
//     }
//
//   The first enables the OTel pipeline; the second (defaults to false) enables
//   the SQLite span exporter that actually writes agent-traces.db.
//   After changing these settings, restart VS Code — the extension watches for
//   these changes and requires a reload to take effect.
//
//   Or set the environment variable before launching VS Code:
//
//     export COPILOT_OTEL_ENABLED=true
//
//   The DB file is created in VS Code's global storage directory:
//     ~/Library/Application Support/Code/User/globalStorage/github.copilot-chat/agent-traces.db
//
// ENVIRONMENT VARIABLES:
//   WATCHTOWER_COPILOT_OTEL_DB    — Override the agent-traces.db path
//   WATCHTOWER_COPILOT_DISABLE_OTEL=1 — Skip OTel entirely, use only JSONL
//   WATCHTOWER_COPILOT_WS_STORAGE_DIR — Override VS Code workspaceStorage
//   WATCHTOWER_COPILOT_GLOBAL_STORAGE_DIR — Override VS Code globalStorage
//   WATCHTOWER_COPILOT_JETBRAINS_DIR — Override the JetBrains github-copilot root
//   WATCHTOWER_COPILOT_SESSION_STORE_DB — Override the CLI session-store.db path
//
// ARCHITECTURE:
//   discoverSessionsEffect() returns the CLI session-store source FIRST, then OTel
//   sessions and legacy JSONL sessions. Order is load-bearing: the scan parses
//   a provider's sources in the order discovery returned them (parser.ts
//   `for (const source of sources)` → `changedSources` → the parse loop), and
//   the store must be parsed before any `events.jsonl` source so it can record
//   which (session, model) pairs it covers — and how many tokens it covers —
//   before the shutdown rollup subtracts them. Discovery also finishes before the
//   first parser is created, so the set of sessions that HAVE a local
//   `events.jsonl` is already complete when the store parser runs; that set
//   decides which rows may own their output (see the OUTPUT OWNERSHIP block in
//   createSessionStoreParser). When OTel is present, VS Code core chatSessions
//   are skipped because they mirror the same Copilot turns under different IDs.
//   A core chat session saved by VS Code before 1.109 is read as ONE flat JSON
//   document beside the newer delta journals, and a chat session whose id the
//   store already bills (the agent host writes both) is left out.
//
// LIMITATIONS (session-store):
//   - The rollup is RECONCILED per leg interval, never suppressed whole. Rows
//     are authoritative per request, and what a leg claims BEYOND the rows of
//     its own interval is served once as a residual at the leg's own instant.
//     That interval starts at the leg's last successful in-session compaction
//     rather than at the previous leg: the CLI resets its counters at a
//     compaction, so the leg never claimed the pre-compaction conversation and
//     subtracting it would cancel usage the rollup does not describe. The only
//     direction left is under-reporting, when a store snapshot sits behind its
//     journal with no local signal — never invented spend.
//   - A resumed session writes one rollup per leg, each carrying CUMULATIVE
//     counters, so each leg serves as `cumulative - previous cumulative` under
//     its own key (`:1`, `:2`, …). A total below its predecessor is a fresh
//     accounting epoch (an older per-leg CLI, or the reset a compaction causes)
//     and is taken at face value instead of being clamped away.
//   - A row of a session that DOES have a local `events.jsonl` yields no output:
//     the per-turn `assistant.message` owns it. When the journal records no
//     per-turn output at all (CLI 1.0.8x / the VS Code agent host, or an ACP host
//     killed before it can shut down), that hand-off has nobody to take it, so
//     each such row serves its output as its own call
//     (`copilot:<session>:store-output:<row>`) and the rollup subtracts it as
//     covered. Rows of sessions with NO local journal keep `output_tokens` on
//     the row itself — nothing else on this machine can ever report them.
//
// LIMITATIONS:
//   - The OTel DB only contains Copilot Chat and Agent mode spans. Inline
//     completions (ghost text) and Agent Host spans are NOT yet written to
//     this DB (see https://github.com/microsoft/vscode/issues/315901).
//   - The DB schema is inferred from the official OTel GenAI semantic
//     conventions and the Copilot Budget extension's approach. If VS Code
//     changes the schema, this parser will need updating.
// =============================================================================

import { createHash } from 'crypto'
import * as Effect from 'effect/Effect'
import * as Predicate from 'effect/Predicate'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import { existsSync } from 'fs'
import { readdir, stat } from 'fs/promises'
import { homedir, platform } from 'os'
import { basename, dirname, join, posix, win32 } from 'path'

import { type AppPaths, overrideFor, platformFor } from '@/infrastructure/config/environment.js'
import { extractBashCommands } from '@/core/ingestion/parsers/bash-utils.js'
import { billableOutputTokens } from '@/core/ingestion/normalization/billable-output.js'
import { fileErrorCode, reportProviderIssue } from '@/infrastructure/ingestion/file-errors.js'
import {
  MAX_SESSION_FILE_BYTES,
  readSessionFileEffect,
  readSessionLinesStream,
} from '@/infrastructure/ingestion/fs-utils.js'
import { captureScanPricing } from '@/infrastructure/pricing/models.js'
import { isScanAbortedError, throwIfScanAborted } from '@/core/ingestion/reconciliation/scan-control.js'
import { checkScanAbort, scanIo } from '@/infrastructure/ingestion/scan-io.js'
import type { ScanPricing } from '@/core/domain/pricing/scan-pricing.js'
import { blobToText, openDatabase, type SqliteDatabase } from '@/infrastructure/ingestion/sqlite.js'
import { estimateTokensFromChars } from '@/core/ingestion/parsers/token-estimate.js'
import type { DateRange } from '@/core/domain/observations/types.js'
import type {
  ParsedProviderCall,
  Provider,
  ProviderScanContext,
  SessionParser,
  SessionSource,
} from '@/infrastructure/provider-adapters/types.js'

type CopilotParserContext = ProviderScanContext & { readonly pricing: ScanPricing }
const sqliteTextBlobSchema = Schema.Union([Schema.String, Schema.Uint8Array])
const nullableSqliteTextBlobSchema = Schema.NullOr(sqliteTextBlobSchema)
const textOrNullTypeSchema = Schema.Literals(['text', 'null'])

class CopilotDatabaseError extends Schema.TaggedError<CopilotDatabaseError>()('CopilotDatabaseError', {
  operation: Schema.Literals(['open', 'read', 'close']),
  cause: Schema.Defect(),
  message: Schema.String,
}) {}

type OwnedCopilotDatabase = { readonly db: SqliteDatabase; closed: boolean }

function copilotDatabaseError(operation: CopilotDatabaseError['operation'], cause: unknown): CopilotDatabaseError {
  const error = cause instanceof Error ? cause : new Error(String(cause), { cause })
  return new CopilotDatabaseError({ operation, cause: error, message: error.message })
}

function closeCopilotDatabase(owned: OwnedCopilotDatabase): Effect.Effect<void, CopilotDatabaseError> {
  return Effect.suspend(() => {
    if (owned.closed) return Effect.void
    owned.closed = true
    return Effect.try({ try: () => owned.db.close(), catch: cause => copilotDatabaseError('close', cause) })
  })
}

function openCopilotDatabase(path: string): Effect.Effect<OwnedCopilotDatabase, CopilotDatabaseError> {
  return Effect.try({
    try: () => ({ db: openDatabase(path), closed: false }),
    catch: cause => copilotDatabaseError('open', cause),
  })
}

function copilotParser(parseStream: NonNullable<SessionParser['parseStream']>): SessionParser {
  return {
    parseStream,
  }
}

const estimateTokens = (text: string) => estimateTokensFromChars(text.length)

// ---------------------------------------------------------------------------
// Copilot AI credits
// ---------------------------------------------------------------------------
//
// GitHub bills Copilot usage in AI credits: 1e9 nano-AIU = 1 credit = $0.01
// ("Usage-based billing for individuals"). This is the same conversion the
// reference implementation uses, and it is the only way a request whose tokens
// are not all recorded locally can still be priced exactly: the bill covers the
// whole request, subagents included.

const NANO_AIU_PER_CREDIT = 1e9
const AI_CREDIT_USD = 0.01

/** USD for a nano-AIU figure GitHub reported for one request. */
function nanoAiuToUsd(nanoAiu: number): number {
  return (nanoAiu / NANO_AIU_PER_CREDIT) * AI_CREDIT_USD
}

// ---------------------------------------------------------------------------
// Model display names (unchanged from original)
// ---------------------------------------------------------------------------
const modelDisplayNames: Record<string, string> = {
  'gpt-4.1-nano': 'GPT-4.1 Nano',
  'gpt-4.1-mini': 'GPT-4.1 Mini',
  'gpt-4.1': 'GPT-4.1',
  'gpt-4o-mini': 'GPT-4o Mini',
  'gpt-4o': 'GPT-4o',
  'gpt-5-mini': 'GPT-5 Mini',
  'gpt-5': 'GPT-5',
  'claude-sonnet-4-5': 'Sonnet 4.5',
  'claude-sonnet-4': 'Sonnet 4',
  'copilot-openai-auto': 'Copilot (OpenAI auto)',
  'copilot-anthropic-auto': 'Copilot (Anthropic auto)',
}

// ---------------------------------------------------------------------------
// Tool name normalisation (unchanged from original, plus OTel tool names)
// ---------------------------------------------------------------------------
const toolNameMap: Record<string, string> = {
  // JSONL session-state tool names
  bash: 'Bash',
  skill: 'Skill',
  read_file: 'Read',
  write_file: 'Edit',
  edit_file: 'Edit',
  delete_file: 'Delete',
  github_repo: 'GitHub',
  web_search: 'WebSearch',
  run_in_terminal: 'Shell',
  // JetBrains Copilot agent tool names (snake_case)
  insert_edit_into_file: 'Edit',
  create_file: 'Edit',
  get_errors: 'Diagnostics',
  file_search: 'Search',
  grep_search: 'Search',
  semantic_search: 'Search',
  list_dir: 'Search',
  fetch_webpage: 'Web',
  // OTel execute_tool span names from Copilot Chat:
  readFile: 'Read',
  writeFile: 'Edit',
  editFile: 'Edit',
  runCommand: 'Shell',
  runInTerminal: 'Shell',
  findFiles: 'Search',
  grepSearch: 'Search',
  codebaseSearch: 'Search',
  getErrors: 'Diagnostics',
  listCodeUsages: 'Search',
  createFile: 'Edit',
  deleteFile: 'Delete',
  renameOrMoveFile: 'Edit',
  fetchWebpage: 'Web',
}

/**
 * Normalise a raw tool name to its display form.
 * - Known tools are mapped via toolNameMap.
 * - MCP tools (containing both '-' and '_') are formatted as
 *   mcp__server_name__tool_name.
 * - Everything else is returned unchanged.
 */
function normalizeTool(rawTool: string): string {
  const mapped = toolNameMap[rawTool]
  if (mapped) return mapped
  // MCP tool names follow the pattern: server-name-tool_operand
  // e.g. github-mcp-server-list_issues → mcp__github_mcp_server__list_issues
  const dashIdx = rawTool.lastIndexOf('-')
  if (dashIdx > 0 && rawTool.includes('_')) {
    const server = rawTool.slice(0, dashIdx).replace(/-/g, '_')
    const tool = rawTool.slice(dashIdx + 1)
    return `mcp__${server}__${tool}`
  }
  return rawTool
}

const modelDisplayEntries = Object.entries(modelDisplayNames).sort((a, b) => b[0].length - a[0].length)

// Tool names that represent shell/bash execution. When the AI calls one of
// these, we extract the `arguments.command` string into bashCommands[].
const BASH_TOOL_NAMES = new Set(['bash', 'run_in_terminal', 'runInTerminal', 'runCommand'])

type CopilotJsonlEvent = {
  readonly type: string
  readonly timestamp: unknown
  readonly data: Record<string, unknown>
}

type CopilotJsonlToolFacts = {
  tools: string[]
  skills: string[]
  bashCommands: string[]
  openaiToolIds: number
  anthropicToolIds: number
}

type ChatJournalPathSegment = string | number
type ChatSessionRequest = Record<string, unknown>

const copilotJsonSchema = Schema.fromJsonString(Schema.Unknown)
const copilotRecordSchema = Schema.Record(Schema.String, Schema.Unknown)
const copilotArraySchema = Schema.Array(Schema.Unknown)
const copilotFiniteSchema = Schema.Finite
const decodeCopilotString = Schema.decodeUnknownResult(Schema.String)
const decodeCopilotJson = Schema.decodeUnknownResult(copilotJsonSchema)
const decodeCopilotRecord = Schema.decodeUnknownResult(copilotRecordSchema)
const decodeCopilotArray = Schema.decodeUnknownResult(copilotArraySchema)
const decodeCopilotFinite = Schema.decodeUnknownResult(copilotFiniteSchema)

// ---------------------------------------------------------------------------
// Types for OTel span rows from agent-traces.db
// ---------------------------------------------------------------------------

// The OTel SQLite store schema uses a spans table where attributes are stored
// either as a JSON blob or as individual columns. We handle both patterns.
// The Copilot Budget extension reads from this same DB and uses per-span
// token counts, confirming this schema is stable enough to depend on.

// Parsed attribute bag from a span
interface SpanAttributes {
  'gen_ai.operation.name'?: string
  'gen_ai.response.model'?: string
  'gen_ai.request.model'?: string
  'gen_ai.usage.input_tokens'?: number
  'gen_ai.usage.output_tokens'?: number
  'gen_ai.usage.cache_read.input_tokens'?: number
  'gen_ai.usage.cache_creation.input_tokens'?: number
  'gen_ai.conversation.id'?: string
  'gen_ai.agent.name'?: string
  'gen_ai.tool.name'?: string
  'gen_ai.tool.call.arguments'?: string
  'copilot_chat.parent_chat_session_id'?: string
  'github.copilot.chat.turn.id'?: string
  [key: string]: unknown
}

const otelConversationRowSchema = Schema.Struct({
  conversation_id: sqliteTextBlobSchema,
  conversation_id_type: Schema.Literal('text'),
  project: sqliteTextBlobSchema,
  project_type: Schema.Literal('text'),
  min_start: Schema.Finite,
})
const otelSpanIdRowSchema = Schema.Struct({
  span_id: sqliteTextBlobSchema,
  span_id_type: Schema.Literal('text'),
  trace_id: sqliteTextBlobSchema,
  trace_id_type: Schema.Literal('text'),
})
const otelTraceSpanRowSchema = Schema.Struct({
  span_id: sqliteTextBlobSchema,
  span_id_type: Schema.Literal('text'),
  trace_id: sqliteTextBlobSchema,
  trace_id_type: Schema.Literal('text'),
  operation_name: nullableSqliteTextBlobSchema,
  operation_name_type: textOrNullTypeSchema,
  start_time_ms: Schema.Finite,
  response_model: nullableSqliteTextBlobSchema,
  response_model_type: textOrNullTypeSchema,
})
const spanAttributeRowSchema = Schema.Struct({
  key: sqliteTextBlobSchema,
  key_type: Schema.Literal('text'),
  value: Schema.Union([Schema.Null, Schema.Number, sqliteTextBlobSchema]),
  value_type: Schema.Literals(['null', 'integer', 'real', 'text', 'blob']),
})
const otelCallUsageSchema = Schema.Struct({
  model: Schema.String,
  inputTokens: Schema.Finite,
  outputTokens: Schema.Finite,
  cacheReadTokens: Schema.Finite,
  cacheCreationTokens: Schema.Finite,
})
const decodeOtelConversationRow = Schema.decodeUnknownResult(otelConversationRowSchema)
const decodeOtelSpanIdRow = Schema.decodeUnknownResult(otelSpanIdRowSchema)
const decodeOtelTraceSpanRow = Schema.decodeUnknownResult(otelTraceSpanRowSchema)
const decodeSpanAttributeRow = Schema.decodeUnknownResult(spanAttributeRowSchema)
const decodeOtelCallUsage = Schema.decodeUnknownResult(otelCallUsageSchema)

// ---------------------------------------------------------------------------
// Types for session-store.db rows (Copilot CLI)
// ---------------------------------------------------------------------------
//
// One `assistant_usage_events` row is one API REQUEST. `input_tokens` is
// cache-INCLUSIVE (uncached input + cache_read + cache_write), the same
// convention the `session.shutdown` rollup in events.jsonl uses — see the
// ShutdownModelUsage doc and the subtraction in the store parser.
//
// Only the columns this parser prices are listed; the store carries many more
// (durations, TTFT, finish_reason, token_details_json) that have no field in
// ParsedProviderCall. Every column is nullable in the file, so every field here
// is read defensively and NULL is treated as 0.

const sessionStoreUsageRowSchema = Schema.Struct({
  id: Schema.Finite,
  session_id: nullableSqliteTextBlobSchema,
  session_id_type: Schema.optional(textOrNullTypeSchema),
  model: nullableSqliteTextBlobSchema,
  model_type: Schema.optional(textOrNullTypeSchema),
  input_tokens: Schema.NullOr(Schema.Finite),
  output_tokens: Schema.NullOr(Schema.Finite),
  cache_read_tokens: Schema.NullOr(Schema.Finite),
  cache_write_tokens: Schema.NullOr(Schema.Finite),
  reasoning_tokens: Schema.NullOr(Schema.Finite),
  initiator: nullableSqliteTextBlobSchema,
  initiator_type: Schema.optional(textOrNullTypeSchema),
  created_at: nullableSqliteTextBlobSchema,
  created_at_type: Schema.optional(textOrNullTypeSchema),
  cwd: nullableSqliteTextBlobSchema,
  cwd_type: Schema.optional(textOrNullTypeSchema),
  repository: nullableSqliteTextBlobSchema,
  repository_type: Schema.optional(textOrNullTypeSchema),
  // Billing metadata. Only newer CLIs write it, so the SELECT ladder in
  // querySessionStoreRows drops the column for a store that predates it and the
  // row then prices from its tokens, exactly as before.
  total_nano_aiu: Schema.optional(Schema.NullOr(Schema.Finite)),
})
type SessionStoreUsageRow = Schema.Schema.Type<typeof sessionStoreUsageRowSchema>
const decodeSessionStoreUsageRow = Schema.decodeUnknownResult(sessionStoreUsageRowSchema)

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
//
// Every seam below takes the AppPaths snapshot as ONE optional trailing
// `paths` argument (`env.ts` seam convention). The snapshot REPORTS: each
// reader keeps its own `??` / truthy / `isAbsolute` chain, so a `null` from
// the snapshot produces exactly what `process.env[...] === undefined` did.

export function getCopilotSessionStateDir(override?: string, paths?: AppPaths): string {
  return (
    override ??
    overrideFor(paths, 'WATCHTOWER_COPILOT_SESSION_STATE_DIR') ??
    join(homedir(), '.copilot', 'session-state')
  )
}

/**
 * Locate the Copilot CLI's `session-store.db`.
 *
 * The CLI writes one `assistant_usage_events` row per API request here. It is
 * the ONLY place a CLI session's per-request input / cache-read / cache-write
 * split exists — `events.jsonl` reports the same tokens lumped per model in its
 * `session.shutdown` rollup, and one store spans every project, so its
 * `sessions.cwd` / `sessions.repository` are what attribute a row to a project.
 *
 * The store sits BESIDE `session-state/`, so the path is derived from the
 * already-registered `WATCHTOWER_COPILOT_SESSION_STATE_DIR` seam rather than
 * from a second, independent `homedir()` read: one override then moves the
 * whole CLI root, which is what a test or an embedder pointing the app at a
 * copied `~/.copilot` actually means. With nothing overridden the default is
 * still `~/.copilot/session-store.db`.
 *
 * `WATCHTOWER_COPILOT_SESSION_STORE_DB` is the eventual dedicated override, to
 * match `WATCHTOWER_COPILOT_OTEL_DB`. It is NOT yet registered in
 * `PROVIDER_ENV_KEYS` (src/infrastructure/config/environment.ts) — the single place a provider env var
 * is registered and the only thing `overrideFor` is typed against — so this
 * reader cannot resolve it yet. Registering the key there (alphabetically,
 * after `WATCHTOWER_COPILOT_SESSION_STATE_DIR`) and prepending
 * `overrideFor(paths, 'WATCHTOWER_COPILOT_SESSION_STORE_DB')` is the follow-up;
 * the exported helper's existsSync gate is unchanged either way. Discovery
 * checks this candidate with Effect-native stat.
 *
 * Returns null when the file is absent — the case on every machine that has
 * never run the Copilot CLI, and the case that must leave every other Copilot
 * source byte-for-byte unchanged.
 */
export function getCopilotSessionStoreDbPath(sessionStateDir?: string, paths?: AppPaths): string | null {
  const candidate = getCopilotSessionStoreDbCandidate(sessionStateDir, paths)
  return existsSync(candidate) ? candidate : null
}

function getCopilotSessionStoreDbCandidate(sessionStateDir?: string, paths?: AppPaths): string {
  const override = overrideFor(paths, 'WATCHTOWER_COPILOT_SESSION_STORE_DB')
  // The store sits beside `session-state/` in the CLI home, so the registered
  // session-state override doubles as a way to move the whole CLI root. The
  // dedicated override wins when set, for pointing at a relocated store alone.
  const candidate = override
    ? join(override, 'session-store.db')
    : join(dirname(getCopilotSessionStateDir(sessionStateDir, paths)), 'session-store.db')
  return candidate
}

/**
 * Locate the agent-traces.db file.
 *
 * Priority:
 *   1. WATCHTOWER_COPILOT_OTEL_DB env var
 *   2. Platform-specific default VS Code global storage path
 *   3. VSCodium variant paths
 */
export function getAgentTracesDbPath(paths?: AppPaths): string | null {
  return getAgentTracesDbCandidates(paths).find(candidate => existsSync(candidate)) ?? null
}

function getAgentTracesDbCandidates(paths?: AppPaths): string[] {
  // Allow explicit override
  const envOverride = overrideFor(paths, 'WATCHTOWER_COPILOT_OTEL_DB')
  if (envOverride) {
    return [envOverride]
  }

  const home = homedir()
  const candidates: string[] = []

  const p = platform()
  if (p === 'darwin') {
    // macOS: VS Code, VS Code Insiders, VSCodium
    candidates.push(
      join(
        home,
        'Library',
        'Application Support',
        'Code',
        'User',
        'globalStorage',
        'github.copilot-chat',
        'agent-traces.db',
      ),
      join(
        home,
        'Library',
        'Application Support',
        'Code - Insiders',
        'User',
        'globalStorage',
        'github.copilot-chat',
        'agent-traces.db',
      ),
      join(
        home,
        'Library',
        'Application Support',
        'VSCodium',
        'User',
        'globalStorage',
        'github.copilot-chat',
        'agent-traces.db',
      ),
    )
  } else if (p === 'linux') {
    // Linux: VS Code, VS Code Insiders, VSCodium
    candidates.push(
      join(home, '.config', 'Code', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
      join(home, '.config', 'Code - Insiders', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
      join(home, '.config', 'VSCodium', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
    )
  } else if (p === 'win32') {
    // Windows
    const appdata = platformFor(paths).appData ?? join(home, 'AppData', 'Roaming')
    candidates.push(
      join(appdata, 'Code', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
      join(appdata, 'Code - Insiders', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
      join(appdata, 'VSCodium', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
    )
  }

  return candidates
}

/**
 * Locate the GitHub Copilot config root used by the JetBrains IDE plugin
 * (IntelliJ IDEA, PyCharm, RubyMine, …). The JetBrains Copilot agent persists
 * chat/agent sessions here — a location none of the VS Code or CLI sources
 * touch, so this is the only way JetBrains-driven Copilot usage becomes
 * visible to the app.
 *
 * The path mirrors the plugin's own `getXdgConfigPath` logic (observed in the
 * bundled copilot-agent language server):
 *   - $XDG_CONFIG_HOME/github-copilot (when set to an absolute path)
 *   - macOS / Linux: ~/.config/github-copilot
 *   - Windows:       %USERPROFILE%\AppData\Local\github-copilot
 *
 * Under this root, each IDE has its own subdir (e.g. `iu` for IntelliJ IDEA
 * Ultimate, `intellij` for the community edition) containing
 * chat-agent-sessions/, chat-sessions/, and chat-edit-sessions/.
 */
export function getJetBrainsCopilotRoot(override?: string, paths?: AppPaths): string {
  const envOverride = override ?? overrideFor(paths, 'WATCHTOWER_COPILOT_JETBRAINS_DIR')
  if (envOverride) return envOverride

  const { xdgConfigHome: xdg, localAppData } = platformFor(paths)
  // Reader-side asymmetry the snapshot must not resolve: an EMPTY or RELATIVE
  // XDG_CONFIG_HOME is rejected here (`if (xdg && isAbsolute(xdg))`) and falls
  // through to the platform default, while the plain `??` readers would join
  // into a relative path. `null` ("unset") and `''` both fail this test.
  if (xdg && (posix.isAbsolute(xdg) || win32.isAbsolute(xdg))) {
    return join(xdg, 'github-copilot')
  }

  if (platform() === 'win32') {
    const local = localAppData ?? join(homedir(), 'AppData', 'Local')
    return join(local, 'github-copilot')
  }

  return join(homedir(), '.config', 'github-copilot')
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseCwd(yaml: string): string | null {
  const match = yaml.match(/^cwd:\s*(.+)$/m)
  if (!match?.[1]) return null
  let raw = match[1].trim()
  // Strip inline YAML comments (# preceded by optional whitespace)
  raw = raw.replace(/\s*#.*$/, '')
  // Strip surrounding single/double quotes
  raw = raw.replace(/^['"]|['"]$/g, '').trim()
  return raw || null
}

/**
 * Load span attributes from the span_attributes table (key-value pairs).
 * This handles the modern VS Code Copilot Chat schema where attributes
 * are stored as separate key-value rows rather than a JSON blob.
 */
const loadSpanAttributesFromTable = Effect.fnUntraced(function* (
  db: SqliteDatabase,
  spanId: string,
  signal?: AbortSignal,
  onUnparsedCall?: Effect.Effect<void>,
): Effect.fn.Return<SpanAttributes, CopilotDatabaseError | Error> {
  yield* checkScanAbort(signal)
  const rows = yield* Effect.try({
    try: () =>
      db.query(
        `SELECT
           CASE WHEN typeof(key) = 'text' THEN CAST(key AS BLOB) ELSE NULL END AS key,
           typeof(key) AS key_type,
           CASE WHEN typeof(value) = 'text' THEN CAST(value AS BLOB) ELSE value END AS value,
           typeof(value) AS value_type
         FROM span_attributes WHERE span_id = ?`,
        [spanId],
      ),
    catch: cause => copilotDatabaseError('read', cause),
  })
  yield* checkScanAbort(signal)
  const attrs: SpanAttributes = {}
  for (const candidate of rows) {
    const decoded = decodeSpanAttributeRow(candidate)
    if (Result.isFailure(decoded)) {
      if (onUnparsedCall) yield* onUnparsedCall
      continue
    }
    const { key: encodedKey, value, value_type: valueType } = decoded.success
    const key = blobToText(encodedKey)
    if (!key || value === null) continue
    const rawValue = valueType === 'text' || valueType === 'blob' ? blobToText(value as Uint8Array | string) : value
    if (rawValue !== '') {
      if (
        typeof rawValue === 'string' &&
        (key === 'gen_ai.response.model' || key === 'gen_ai.request.model') &&
        !rawValue.trim()
      ) {
        attrs[key as keyof SpanAttributes] = rawValue
        continue
      }
      const numValue = Number(rawValue)
      attrs[key as keyof SpanAttributes] = Number.isNaN(numValue) ? rawValue : numValue
    }
  }
  return attrs
})

/**
 * Convert nanosecond or millisecond epoch to ISO timestamp.
 * The OTel spec uses nanoseconds, but some implementations use milliseconds.
 */
function epochToISO(epoch: number): string {
  // Guard malformed rows: new Date(NaN).toISOString() throws. Fall back to the
  // epoch (1970) so a bad timestamp is excluded from period totals, not crashing.
  if (!Number.isFinite(epoch) || epoch <= 0) return new Date(0).toISOString()
  // If the value looks like nanoseconds (> 1e15), convert to ms
  const ms = epoch > 1e15 ? Math.floor(epoch / 1e6) : epoch > 1e12 ? epoch : epoch * 1000
  return new Date(ms).toISOString()
}

function timestampToISO(raw: unknown): string {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return epochToISO(raw)
  }
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return epochToISO(Number(trimmed))
  }
  const parsed = Date.parse(trimmed)
  return Number.isNaN(parsed) ? '' : new Date(parsed).toISOString()
}

function isReplayContainer(value: unknown): value is object {
  return Predicate.isObject(value) || Array.isArray(value)
}

function createReplayObject(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>
}

const FORBIDDEN_CHAT_JOURNAL_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const chatJournalPathSchema = Schema.Array(
  Schema.Union([
    Schema.String.check(
      Schema.makeFilter(segment =>
        FORBIDDEN_CHAT_JOURNAL_KEYS.has(segment) ? 'reserved journal path segment' : undefined,
      ),
    ),
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ]),
)
const decodeChatJournalPath = Schema.decodeUnknownResult(chatJournalPathSchema)

function parseChatJournalPath(
  rawPath: unknown,
  fallback?: readonly ChatJournalPathSegment[],
): ChatJournalPathSegment[] | null {
  const value = rawPath === undefined ? fallback : rawPath
  const decodedPath = decodeChatJournalPath(value)
  if (Result.isFailure(decodedPath)) return null
  return [...decodedPath.success]
}

function getReplayValue(container: object, segment: ChatJournalPathSegment): unknown {
  return (container as Record<string, unknown>)[String(segment)]
}

function setReplayValue(container: object, segment: ChatJournalPathSegment, value: unknown): void {
  ;(container as Record<string, unknown>)[String(segment)] = value
}

function createContainerForNext(segment: ChatJournalPathSegment): unknown[] | Record<string, unknown> {
  return typeof segment === 'number' ? [] : createReplayObject()
}

function ensureReplayParent(root: object, path: ChatJournalPathSegment[]): object | null {
  let current: object = root
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i]!
    const nextSegment = path[i + 1]!
    const child = getReplayValue(current, segment)
    if (!isReplayContainer(child)) {
      const created = createContainerForNext(nextSegment)
      setReplayValue(current, segment, created)
      current = created
      continue
    }
    current = child
  }
  return current
}

function applyChatJournalSet(root: unknown, path: ChatJournalPathSegment[], value: unknown): unknown {
  if (path.length === 0) return value

  const workingRoot = isReplayContainer(root) ? root : createReplayObject()
  const parent = ensureReplayParent(workingRoot, path)
  if (!parent) return workingRoot
  setReplayValue(parent, path[path.length - 1]!, value)
  return workingRoot
}

function applyChatJournalAppend(root: unknown, path: ChatJournalPathSegment[], items: readonly unknown[]): unknown {
  const workingRoot = isReplayContainer(root) ? root : createReplayObject()

  if (path.length === 0) {
    if (Array.isArray(workingRoot)) {
      for (const item of items) workingRoot.push(item)
    }
    return workingRoot
  }

  const parent = ensureReplayParent(workingRoot, path)
  if (!parent) return workingRoot

  const last = path[path.length - 1]!
  const target = getReplayValue(parent, last)
  const targetArray: unknown[] = Array.isArray(target) ? target : []
  if (target !== targetArray) {
    setReplayValue(parent, last, targetArray)
  }
  for (const item of items) targetArray.push(item)
  return workingRoot
}

function replayChatSessionJournalLine(root: unknown, line: string): unknown {
  const decodedJson = decodeCopilotJson(line)
  if (Result.isFailure(decodedJson)) return root
  const decodedEntry = decodeCopilotRecord(decodedJson.success)
  if (Result.isFailure(decodedEntry)) return root
  const entry = decodedEntry.success
  const kind = entry['kind']
  if (kind === 0) {
    return entry['v']
  }

  if (kind === 1) {
    const path = parseChatJournalPath(entry['k'])
    if (!path) return root
    return applyChatJournalSet(root, path, entry['v'])
  }

  if (kind === 2) {
    const hasPath = Object.prototype.hasOwnProperty.call(entry, 'k')
    const path = parseChatJournalPath(hasPath ? entry['k'] : undefined, ['requests'])
    const decodedItems = decodeCopilotArray(entry['v'])
    const items = Result.isSuccess(decodedItems) ? decodedItems.success : []
    if (!path) return root
    return applyChatJournalAppend(root, path, items)
  }
  return root
}

function numberOrZero(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0
}

function readString(raw: unknown): string {
  return typeof raw === 'string' ? raw : ''
}

/**
 * Sum one agent-mode request's `modelTotals` into its token breakdown.
 *
 * `inputTokens` includes the cached part when the figure comes from the Copilot
 * engine and excludes it when it comes from the Claude SDK; an input below the
 * cached count can only be the latter, so it is kept as-is.
 */
function chatSessionModelTotals(
  raw: unknown,
): { inputTokens: number; cacheReadTokens: number; outputTokens: number } | undefined {
  const entries = decodeCopilotArray(raw)
  if (Result.isFailure(entries)) return undefined
  let input = 0
  let cached = 0
  let output = 0
  let found = false
  for (const candidate of entries.success) {
    const decoded = decodeCopilotRecord(candidate)
    if (Result.isFailure(decoded)) continue
    found = true
    input += numberOrZero(decoded.success['inputTokens'])
    cached += numberOrZero(decoded.success['cachedTokens'])
    output += numberOrZero(decoded.success['outputTokens'])
  }
  if (!found) return undefined
  return { inputTokens: input >= cached ? input - cached : input, cacheReadTokens: cached, outputTokens: output }
}

/** `copilotCredits` (credits) as nano-AIU, the unit the pricing helper takes. */
function chatSessionNanoAiu(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.round(raw * NANO_AIU_PER_CREDIT) : undefined
}

function concreteChatSessionModel(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const model = raw.replace(/^(?:copilot|github\.copilot-chat)\//, '').trim()
  return model && !['auto', 'copilot-auto', 'unknown'].includes(model) ? model : undefined
}

function modelHintFromToolCallId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  if (raw.startsWith('call_')) return 'copilot-openai-auto'
  if (/^(?:tooluse_|toolu_)/.test(raw)) return 'copilot-anthropic-auto'
  return undefined
}

function inferChatSessionModel(session: Record<string, unknown>, requests: readonly unknown[]): string | undefined {
  for (const rawRequest of requests) {
    const request = decodeCopilotRecord(rawRequest)
    if (Result.isSuccess(request)) {
      const model = concreteChatSessionModel(request.success['modelId'])
      if (model) return model
    }
  }

  const selectedModels: unknown[] = []
  const inputState = decodeCopilotRecord(session['inputState'])
  if (Result.isSuccess(inputState)) {
    const selectedModel = decodeCopilotRecord(inputState.success['selectedModel'])
    if (Result.isSuccess(selectedModel)) {
      const metadata = decodeCopilotRecord(selectedModel.success['metadata'])
      if (Result.isSuccess(metadata)) selectedModels.push(metadata.success['version'], metadata.success['family'])
      selectedModels.push(selectedModel.success['identifier'])
    }
  }
  for (const candidate of selectedModels) {
    const model = concreteChatSessionModel(candidate)
    if (model) return model
  }

  for (const rawRequest of requests) {
    const request = decodeCopilotRecord(rawRequest)
    if (Result.isFailure(request)) continue
    const result = decodeCopilotRecord(request.success['result'])
    if (Result.isFailure(result)) continue
    const metadata = decodeCopilotRecord(result.success['metadata'])
    const rounds = Result.isSuccess(metadata)
      ? decodeCopilotArray(metadata.success['toolCallRounds'] ?? result.success['toolCallRounds'])
      : decodeCopilotArray(result.success['toolCallRounds'])
    if (Result.isSuccess(rounds)) {
      for (const rawRound of rounds.success) {
        const round = decodeCopilotRecord(rawRound)
        if (Result.isFailure(round)) continue
        const toolCalls = decodeCopilotArray(round.success['toolCalls'])
        if (Result.isFailure(toolCalls)) continue
        for (const rawToolCall of toolCalls.success) {
          const toolCall = decodeCopilotRecord(rawToolCall)
          if (Result.isFailure(toolCall)) continue
          const model = modelHintFromToolCallId(toolCall.success['id'])
          if (model) return model
        }
      }
    }

    const responses = decodeCopilotArray(request.success['response'])
    if (Result.isSuccess(responses)) {
      for (const rawResponse of responses.success) {
        const response = decodeCopilotRecord(rawResponse)
        if (Result.isFailure(response)) continue
        const model = modelHintFromToolCallId(response.success['toolCallId'])
        if (model) return model
      }
    }
  }

  return undefined
}

function modelFromChatSessionRequest(
  req: ChatSessionRequest,
  metadata: Record<string, unknown>,
  inferredSessionModel: string | undefined,
): string {
  const result = decodeCopilotRecord(req['result'])
  const resultRecord = Result.isSuccess(result) ? result.success : createReplayObject()
  const candidates: unknown[] = [
    metadata['resolvedModel'],
    metadata['model'],
    resultRecord['resolvedModel'],
    resultRecord['model'],
  ]

  const response = decodeCopilotArray(req['response'])
  if (Result.isSuccess(response)) {
    for (const rawPart of response.success) {
      const part = decodeCopilotRecord(rawPart)
      if (Result.isFailure(part) || part.success['kind'] !== 'autoModeResolution') continue
      candidates.push(part.success['resolvedModel'], part.success['model'], part.success['modelId'])
    }
  }

  candidates.push(req['modelId'], inferredSessionModel)
  for (const candidate of candidates) {
    const model = concreteChatSessionModel(candidate)
    if (model) return model
  }
  return 'unknown'
}

/**
 * Extract the user prompt text from a VS Code chatSession request record.
 * The prompt lives in `request.message.text` (fallback: concatenation of
 * `request.message.parts[].text`). Returns an empty string when neither
 * field is present, so callers can rely on the shape.
 */
function extractChatSessionUserMessage(rawReq: Record<string, unknown>): string {
  const message = rawReq['message']
  const decodedMessage = decodeCopilotRecord(message)
  if (Result.isFailure(decodedMessage)) return ''

  const direct = decodedMessage.success['text']
  if (typeof direct === 'string' && direct.trim()) return direct

  const decodedParts = decodeCopilotArray(decodedMessage.success['parts'])
  if (Result.isSuccess(decodedParts)) {
    const chunks: string[] = []
    for (const part of decodedParts.success) {
      const decodedPart = decodeCopilotRecord(part)
      if (Result.isFailure(decodedPart)) continue
      const text = decodedPart.success['text']
      if (typeof text === 'string' && text.trim()) chunks.push(text)
    }
    if (chunks.length > 0) return chunks.join('')
  }

  return ''
}

function extractChatSessionTools(metadata: Record<string, unknown>): string[] {
  const rounds = metadata['toolCallRounds']
  const decodedRounds = decodeCopilotArray(rounds)
  if (Result.isFailure(decodedRounds)) return []

  const names = new Set<string>()
  const addName = (raw: unknown): void => {
    if (typeof raw === 'string' && raw.trim()) names.add(normalizeTool(raw))
  }
  const addFromRecord = (record: Record<string, unknown>): void => {
    addName(record['toolName'])
    addName(record['name'])
    addName(record['tool'])
  }

  for (const rawRound of decodedRounds.success) {
    const decodedRound = decodeCopilotRecord(rawRound)
    if (Result.isFailure(decodedRound)) continue
    const round = decodedRound.success
    addFromRecord(round)

    for (const key of ['tools', 'toolCalls', 'toolRequests']) {
      const decodedEntries = decodeCopilotArray(round[key])
      if (Result.isFailure(decodedEntries)) continue
      for (const entry of decodedEntries.success) {
        if (typeof entry === 'string') {
          addName(entry)
        } else {
          const decodedEntry = decodeCopilotRecord(entry)
          if (Result.isSuccess(decodedEntry)) addFromRecord(decodedEntry.success)
        }
      }
    }
  }

  return [...names]
}

/**
 * Extract a shell command string from an OTel execute_tool span's
 * `gen_ai.tool.call.arguments` attribute. The attribute is a JSON-encoded
 * argument object (e.g. `{"command":"ls -la"}`); we pull out the `command`
 * field. Returns null when the attribute is absent or doesn't carry a command,
 * so callers can skip shell-command extraction cleanly.
 */
function parseToolCommand(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const command = parsed['command']
    return typeof command === 'string' ? command : null
  } catch {
    return null
  }
}

// Shell control-flow keywords. These lead a statement but are not commands, so
// they must never be reported as bash commands.
const OTEL_SHELL_KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'select',
  'function',
  'in',
  'time',
  'coproc',
])

/**
 * Normalise an OTEL shell command before command-name extraction.
 *
 * Unlike the Copilot CLI / VS Code JSONL logs — which record a single command
 * per tool call (e.g. `cd x && python3 y`) — the OTEL store records the FULL
 * multi-line script the agent ran (heredocs, for/if blocks, newline-separated
 * statements). The shared extractBashCommands helper only splits on `;`/`&&`/`|`
 * and has no concept of shell keywords, so those scripts leak control-flow words
 * (`for`, `do`, `if`, `then`, …) and collapse newline-separated statements.
 *
 * Normalising here — rather than in the shared helper — keeps every other
 * provider's behaviour unchanged. We (1) turn newlines into `;` so each
 * statement is its own segment, then (2) drop shell control-flow keywords.
 */
function extractOtelBashCommands(command: string): string[] {
  const normalized = command.replace(/\r?\n/g, '; ')
  return extractBashCommands(normalized).filter(c => !OTEL_SHELL_KEYWORDS.has(c))
}

// ---------------------------------------------------------------------------
// Helpers for JSONL / transcript parsing
// ---------------------------------------------------------------------------

function decodeCopilotJsonlEvent(line: string): CopilotJsonlEvent | undefined {
  const decodedJson = decodeCopilotJson(line)
  if (Result.isFailure(decodedJson)) return undefined
  const decodedEvent = decodeCopilotRecord(decodedJson.success)
  if (Result.isFailure(decodedEvent)) return undefined
  const event = decodedEvent.success
  const decodedType = decodeCopilotString(event['type'])
  if (Result.isFailure(decodedType)) return undefined
  const decodedData = decodeCopilotRecord(event['data'])
  const sourceData = Result.isSuccess(decodedData) ? decodedData.success : createReplayObject()
  const type = decodedType.success
  let fields: readonly string[]
  switch (type) {
    case 'session.start':
      fields = ['selectedModel']
      break
    case 'session.model_change':
      fields = ['newModel']
      break
    case 'user.message':
      fields = ['content']
      break
    case 'subagent.selected':
      fields = ['agentName']
      break
    case 'assistant.message':
      fields = ['messageId', 'model', 'outputTokens', 'toolRequests']
      break
    case 'session.shutdown':
      fields = ['modelMetrics', 'sessionStartTime']
      break
    default:
      fields = []
  }
  const data = Object.fromEntries(fields.flatMap(key => (key in sourceData ? [[key, sourceData[key]]] : [])))
  return { type, timestamp: event['timestamp'], data }
}

function extractCopilotJsonlToolFacts(rawRequests: unknown): CopilotJsonlToolFacts {
  const requests = decodeCopilotArray(rawRequests)
  if (Result.isFailure(requests)) {
    return { tools: [], skills: [], bashCommands: [], openaiToolIds: 0, anthropicToolIds: 0 }
  }

  const facts: CopilotJsonlToolFacts = {
    tools: [],
    skills: [],
    bashCommands: [],
    openaiToolIds: 0,
    anthropicToolIds: 0,
  }
  for (const rawRequest of requests.success) {
    const decodedRequest = decodeCopilotRecord(rawRequest)
    if (Result.isFailure(decodedRequest)) continue
    const request = decodedRequest.success
    const toolCallId = decodeCopilotString(request['toolCallId'])
    if (Result.isSuccess(toolCallId)) {
      if (toolCallId.success.startsWith('call_')) facts.openaiToolIds++
      else if (/^tooluse_|^toolu_/.test(toolCallId.success)) facts.anthropicToolIds++
    }

    const nameResult = decodeCopilotString(request['name'] ?? request['toolName'])
    const name = Result.isSuccess(nameResult) ? nameResult.success : ''
    if (name) facts.tools.push(normalizeTool(name))

    const argumentsResult = decodeCopilotRecord(request['arguments'])
    if (Result.isFailure(argumentsResult)) continue
    if (name === 'skill') {
      const skillResult = decodeCopilotString(argumentsResult.success['skill'])
      if (Result.isSuccess(skillResult) && skillResult.success.trim()) {
        facts.skills.push(skillResult.success.trim())
      }
    }
    if (BASH_TOOL_NAMES.has(name)) {
      const commandResult = decodeCopilotString(argumentsResult.success['command'])
      if (Result.isSuccess(commandResult)) facts.bashCommands.push(...extractBashCommands(commandResult.success))
    }
  }
  return facts
}

/**
 * Infer the model bucket for a VS Code transcript file by counting the
 * toolCallId prefixes across all assistant messages:
 *   call_*           → OpenAI
 *   tooluse_* / toolu_*  → Anthropic
 * The dominant prefix determines the model for the whole session.
 * Returns '' if no toolCallIds are present.
 */
function inferTranscriptModel(openaiCount: number, anthropicCount: number): string {
  if (openaiCount === 0 && anthropicCount === 0) return ''
  return openaiCount >= anthropicCount ? 'copilot-openai-auto' : 'copilot-anthropic-auto'
}

// ---------------------------------------------------------------------------
// JSONL parser (handles both regular session-state events and VS Code
// transcript format via session.start { producer: 'copilot-agent' })
// ---------------------------------------------------------------------------

/**
 * @param storeRows what the session-store parser has already described, one
 * record per row, per `${sessionId}\n${model}`. The `session.shutdown` handler
 * subtracts the rows of its own interval from each leg (see the residual), and
 * hands a withheld row's output its own call when the journal recorded none.
 * OTel / chatSessions / JetBrains / transcript sources never consult it: they
 * describe different tools' sessions, which the store does not record.
 * @param localSessionIds sessions that have a local `events.jsonl`; only their
 * rows sit with output withheld, so only they can have output to hand over.
 * @param agentHostUsageSessions sessions this pass has seen billed usage for; the
 * chat-session parser leaves such a session out rather than counting it twice.
 */
function createJsonlParser(
  source: SessionSource,
  seenKeys: Set<string>,
  storeRows: ReadonlyMap<string, readonly StoreRowUsage[]>,
  localSessionIds: ReadonlySet<string>,
  agentHostUsageSessions: Set<string>,
  context: CopilotParserContext,
): SessionParser {
  const sessionId = basename(dirname(source.path))
  const isTranscript = (source as JsonlSessionSource).sessionKind === 'transcript'
  const workingDirectory = source.workingDirectory
  const shutdownKey = (model: string, legIndex: number) =>
    'copilot:' + sessionId + ':shutdown:' + model + ':' + String(legIndex)
  // Keyed by the leg's own INSTANT, never its position: a journal discovered
  // later can contribute a leg that sorts before existing ones, and an index
  // that shifts would rename a key the cache (and any receiver) already holds.
  const residualKey = (model: string, leg: ShutdownLeg) =>
    'copilot:' + sessionId + ':shutdown-residual:' + model + ':' + (leg.timestamp || String(leg.legIndex))

  /** One reconciled rollup leg: what this session should serve for that leg. */
  type RollupCall = {
    model: string
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    reasoningTokens: number
    // GitHub's own figure for the WHOLE leg, when the rollup carried it. Only a
    // leg served whole can use it: a residual is a subset of the leg, and no
    // local source says which share of the bill it is.
    nanoAiu: number | undefined
    timestamp: string
    deduplicationKey: string
  }
  /** A rollup leg as the journal wrote it, already reduced to its own delta. */
  type ShutdownLeg = {
    model: string
    legIndex: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    reasoningTokens: number
    nanoAiu: number | undefined
    timestamp: string
    timestampMs: number
    // Stamp of the last SUCCESSFUL in-session compaction before this leg, or
    // -Infinity. Carried onto the leg because the CLI resets its rollup counters
    // there, so the leg describes only requests after it.
    compactedAtMs: number
  }
  type CumulativeUsage = {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    reasoningTokens: number
    nanoAiu: number
  }
  /** A withheld store row's output, served once the journal recorded none. */
  type StoreOutputCandidate = {
    kind: 'store-output'
    deduplicationKey: string
    model: string
    outputTokens: number
    timestamp: string
  }
  type AssistantCandidate = {
    kind: 'assistant'
    deduplicationKey: string
    model: string | undefined
    modelInvalid: boolean
    transcriptFallback: boolean
    outputTokens: number
    tokensInvalid: boolean
    tools: string[]
    bashCommands: string[]
    skills: string[]
    subagentType: string | undefined
    subagentInvalid: boolean
    timestamp: string
    timestampInvalid: boolean
    userMessage: string
    userMessageInvalid: boolean
    userMessageVersion: number
  }
  type Candidate =
    | AssistantCandidate
    | { kind: 'invalid-rollup'; deduplicationKey: string }
    | { kind: 'rollup'; value: RollupCall }
    | StoreOutputCandidate
  type FoldState = {
    model: string | undefined
    modelInvalid: boolean
    pendingUserMessage: string
    pendingUserMessageInvalid: boolean
    userMessageVersion: number
    currentSubagentType: string | undefined
    currentSubagentInvalid: boolean
    lastEventTimestamp: string
    openaiToolIds: number
    anthropicToolIds: number
    candidates: Candidate[]
    // One entry per `session.shutdown` leg, in file order. The CLI writes
    // CUMULATIVE counters per leg, so a leg can only be served as a delta, and
    // every delta keeps its own key: a resumed session appends legs instead of
    // rewriting the row already cached under an earlier key.
    legs: ShutdownLeg[]
    legCounts: Map<string, number>
    prevShutdown: Map<string, CumulativeUsage>
    // A model whose counters were unusable in any leg. That leg is reported as
    // unparsed and no later leg for the model is served: a partial sum of a
    // cumulative series is not a smaller truth, it is a wrong one.
    invalidRollups: Set<string>
    modelOrder: string[]
    // Whether the CURRENT leg's `assistant.message` events carried output.
    // Reset at every shutdown, because that is the scope a rollup covers.
    legHasPerTurnOutput: boolean
    lastCompactionMs: number
  }

  const parseStream: NonNullable<SessionParser['parseStream']> = onUnparsedCall =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* checkScanAbort(context.signal)
        const readResult = yield* Effect.result(
          Stream.runFold(
            readSessionLinesStream(source.path, undefined, {
              maxBytes: MAX_SESSION_FILE_BYTES,
              readFailure: 'fail',
              ...(context.signal ? { signal: context.signal } : {}),
            }),
            (): FoldState => ({
              model: undefined,
              modelInvalid: false,
              pendingUserMessage: '',
              pendingUserMessageInvalid: false,
              userMessageVersion: 0,
              currentSubagentType: undefined,
              currentSubagentInvalid: false,
              lastEventTimestamp: '',
              openaiToolIds: 0,
              anthropicToolIds: 0,
              candidates: [],
              legs: [],
              legCounts: new Map(),
              prevShutdown: new Map(),
              invalidRollups: new Set(),
              modelOrder: [],
              legHasPerTurnOutput: false,
              lastCompactionMs: Number.NEGATIVE_INFINITY,
            }),
            (state, rawLine) => {
              const line = typeof rawLine === 'string' ? rawLine : rawLine.toString('utf8')
              if (!line.trim()) return state
              const event = decodeCopilotJsonlEvent(line)
              if (event) foldEvent(event, state)
              return state
            },
          ),
        )
        yield* checkScanAbort(context.signal)
        if (Result.isFailure(readResult)) return Stream.empty

        const state = readResult.success
        const transcriptModel = isTranscript ? inferTranscriptModel(state.openaiToolIds, state.anthropicToolIds) : ''
        if (isTranscript && !transcriptModel) return Stream.empty
        appendStoreOutputCandidates(state)
        appendRollupCandidates(state)

        let emittedUserMessageVersion = 0
        return Stream.fromIterable(state.candidates).pipe(
          Stream.mapEffect(candidate =>
            Effect.gen(function* () {
              yield* checkScanAbort(context.signal)
              const deduplicationKey =
                candidate.kind === 'rollup' ? candidate.value.deduplicationKey : candidate.deduplicationKey
              if (seenKeys.has(deduplicationKey)) return Result.fail(undefined)
              seenKeys.add(deduplicationKey)

              const hasNewUserMessage =
                candidate.kind === 'assistant' && candidate.userMessageVersion > emittedUserMessageVersion
              if (hasNewUserMessage) emittedUserMessageVersion = candidate.userMessageVersion

              if (candidate.kind === 'invalid-rollup') {
                if (onUnparsedCall) yield* onUnparsedCall
                return Result.fail(undefined)
              }
              if (candidate.kind === 'store-output') {
                if (candidate.outputTokens <= 0) return Result.fail(undefined)
                const costUSD = yield* Effect.try({
                  try: () => context.pricing.calculateCost(candidate.model, 0, candidate.outputTokens, 0, 0, 0),
                  catch: cause => (cause instanceof Error ? cause : new Error(String(cause), { cause })),
                })
                agentHostUsageSessions.add(sessionId)
                const call: ParsedProviderCall = {
                  provider: 'copilot' as const,
                  sessionId,
                  model: candidate.model,
                  inputTokens: 0,
                  outputTokens: candidate.outputTokens,
                  cacheCreationInputTokens: 0,
                  cacheReadInputTokens: 0,
                  cachedInputTokens: 0,
                  reasoningTokens: 0,
                  webSearchRequests: 0,
                  costUSD,
                  costIsEstimated: false,
                  tools: [],
                  bashCommands: [],
                  timestamp: candidate.timestamp,
                  speed: 'standard' as const,
                  deduplicationKey,
                  userMessage: '',
                  ...(workingDirectory ? { projectPath: workingDirectory, workingDirectory } : {}),
                }
                return Result.succeed(call)
              }
              if (candidate.kind === 'assistant') {
                if (
                  candidate.modelInvalid ||
                  candidate.tokensInvalid ||
                  candidate.timestampInvalid ||
                  candidate.subagentInvalid ||
                  (hasNewUserMessage && candidate.userMessageInvalid)
                ) {
                  if (onUnparsedCall) yield* onUnparsedCall
                  return Result.fail(undefined)
                }
                const model = candidate.model ?? (candidate.transcriptFallback ? transcriptModel : '')
                if (!model) return Result.fail(undefined)
                const costUSD = context.pricing.calculateCost(model, 0, candidate.outputTokens, 0, 0, 0)
                if (candidate.outputTokens > 0) agentHostUsageSessions.add(sessionId)
                const userMessage = hasNewUserMessage ? candidate.userMessage : ''
                const call: ParsedProviderCall = {
                  provider: 'copilot' as const,
                  sessionId,
                  model,
                  inputTokens: 0,
                  outputTokens: candidate.outputTokens,
                  cacheCreationInputTokens: 0,
                  cacheReadInputTokens: 0,
                  cachedInputTokens: 0,
                  reasoningTokens: 0,
                  webSearchRequests: 0,
                  costUSD,
                  tools: candidate.tools,
                  bashCommands: candidate.bashCommands,
                  skills: candidate.skills.length > 0 ? candidate.skills : undefined,
                  subagentTypes: candidate.subagentType ? [candidate.subagentType] : undefined,
                  timestamp: candidate.timestamp,
                  speed: 'standard' as const,
                  deduplicationKey,
                  userMessage,
                  ...(workingDirectory ? { projectPath: workingDirectory, workingDirectory } : {}),
                }
                return Result.succeed(call)
              }

              const rollup = candidate.value
              // Nothing left to serve (a complete store, or a leg that only
              // repeated its predecessor) — no empty $0 call, exactly as a row
              // with no billable token is skipped.
              if (
                rollup.inputTokens === 0 &&
                rollup.outputTokens === 0 &&
                rollup.cacheReadTokens === 0 &&
                rollup.cacheWriteTokens === 0 &&
                rollup.reasoningTokens === 0 &&
                rollup.nanoAiu === undefined
              )
                return Result.fail(undefined)

              // GitHub's own figure for the leg prices it exactly (1e9 nano-AIU =
              // 1 credit = $0.01), subagents included. Absent on a CLI build that
              // does not bill the rollup, which then prices from its tokens as
              // before — measured counts either way, never a char estimate.
              const costUSD =
                rollup.nanoAiu !== undefined
                  ? nanoAiuToUsd(rollup.nanoAiu)
                  : yield* Effect.try({
                      try: () =>
                        context.pricing.calculateCost(
                          rollup.model,
                          rollup.inputTokens,
                          billableOutputTokens('copilot', rollup.outputTokens, rollup.reasoningTokens),
                          rollup.cacheWriteTokens,
                          rollup.cacheReadTokens,
                          0,
                        ),
                      catch: cause => (cause instanceof Error ? cause : new Error(String(cause), { cause })),
                    })
              agentHostUsageSessions.add(sessionId)
              const call: ParsedProviderCall = {
                provider: 'copilot' as const,
                sessionId,
                model: rollup.model,
                inputTokens: rollup.inputTokens,
                outputTokens: rollup.outputTokens,
                cacheCreationInputTokens: rollup.cacheWriteTokens,
                cacheReadInputTokens: rollup.cacheReadTokens,
                cachedInputTokens: 0,
                reasoningTokens: rollup.reasoningTokens,
                webSearchRequests: 0,
                costUSD,
                costIsEstimated: false,
                tools: [],
                bashCommands: [],
                timestamp: rollup.timestamp,
                speed: 'standard' as const,
                deduplicationKey,
                userMessage: '',
                ...(workingDirectory ? { projectPath: workingDirectory, workingDirectory } : {}),
              }
              return Result.succeed(call)
            }),
          ),
          Stream.filterMap(result => result),
        )
      }),
    )

  /**
   * Turn the folded legs into the calls this session serves.
   *
   * A leg is served WHOLE when the store has no rows for its (session, model):
   * nothing else describes those tokens. When rows exist they are authoritative
   * per request, so only what the leg claims BEYOND the rows of its own interval
   * is served, once, as a residual at the leg's own instant. The interval starts
   * at the leg's last successful compaction: the CLI reset its counters there,
   * so that leg never claimed the pre-compaction conversation and subtracting
   * it would cancel usage the rollup does not describe.
   */
  function appendRollupCandidates(state: FoldState): void {
    for (const model of state.modelOrder) {
      if (state.invalidRollups.has(model)) {
        state.candidates.push({
          kind: 'invalid-rollup',
          deduplicationKey: 'copilot:' + sessionId + ':shutdown:' + model,
        })
        continue
      }
      const modelLegs = state.legs
        .filter(leg => leg.model === model)
        .sort((left, right) => left.timestampMs - right.timestampMs)
      if (modelLegs.length === 0) continue
      const rows = storeRows.get(sessionId + '\n' + model) ?? []
      if (rows.length === 0) {
        for (const leg of modelLegs) state.candidates.push({ kind: 'rollup', value: servedLeg(leg) })
        continue
      }

      // Legs sharing one instant have no interval between them: the strict
      // (previous, this] rule would hand every row to the first and mint a full
      // delta for the second, billing the same tokens twice. Coalesce them.
      const coalesced: ShutdownLeg[] = []
      for (const leg of modelLegs) {
        const last = coalesced[coalesced.length - 1]
        if (last && last.timestampMs === leg.timestampMs) {
          last.inputTokens += leg.inputTokens
          last.outputTokens += leg.outputTokens
          last.cacheReadTokens += leg.cacheReadTokens
          last.cacheWriteTokens += leg.cacheWriteTokens
          last.reasoningTokens += leg.reasoningTokens
          last.compactedAtMs = Math.max(last.compactedAtMs, leg.compactedAtMs)
        } else {
          coalesced.push({ ...leg })
        }
      }

      const orderedRows = [...rows].sort((left, right) => left.timestampMs - right.timestampMs)
      let rowIndex = 0
      let previousLegMs = Number.NEGATIVE_INFINITY
      for (const leg of coalesced) {
        const intervalStart = Math.max(previousLegMs, leg.compactedAtMs)
        let coveredInput = 0
        let coveredOutput = 0
        let coveredCacheRead = 0
        let coveredCacheWrite = 0
        let coveredReasoning = 0
        while (rowIndex < orderedRows.length) {
          const row = orderedRows[rowIndex]
          if (!row || row.timestampMs > leg.timestampMs) break
          // A labelled compaction row is the summarization request itself. It
          // commits just BEFORE the compaction stamp, so the anchor would push
          // it outside the interval while the post-reset rollup still counts it,
          // serving it twice; the label lets it be subtracted exactly.
          if (row.timestampMs > intervalStart || (row.isCompaction && row.timestampMs > previousLegMs)) {
            coveredInput += row.inputTokens
            // A row whose output was handed to its own call has that output
            // served already, so it cancels the leg's copy; a row that kept
            // output on itself cancels with what it served. A row that served 0
            // and handed over nothing never reported it — the leg's copy is the
            // only one, so it must not be cancelled.
            coveredOutput += row.outputServedByAlias ? row.rawOutputTokens : row.outputTokens
            coveredCacheRead += row.cacheReadTokens
            coveredCacheWrite += row.cacheWriteTokens
            coveredReasoning += row.reasoningTokens
          }
          rowIndex++
        }
        previousLegMs = leg.timestampMs

        const inputTokens = Math.max(0, leg.inputTokens - coveredInput)
        const outputTokens = Math.max(0, leg.outputTokens - coveredOutput)
        const cacheReadTokens = Math.max(0, leg.cacheReadTokens - coveredCacheRead)
        const cacheWriteTokens = Math.max(0, leg.cacheWriteTokens - coveredCacheWrite)
        const reasoningTokens = Math.max(0, leg.reasoningTokens - coveredReasoning)
        if (
          inputTokens === 0 &&
          outputTokens === 0 &&
          cacheReadTokens === 0 &&
          cacheWriteTokens === 0 &&
          reasoningTokens === 0
        )
          continue
        state.candidates.push({
          kind: 'rollup',
          value: {
            model,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            reasoningTokens,
            // A residual is a SUBSET of a leg; only a leg served whole keeps
            // GitHub's exact figure.
            nanoAiu: undefined,
            timestamp: leg.timestamp,
            deduplicationKey: residualKey(model, leg),
          },
        })
      }
    }
  }

  function servedLeg(leg: ShutdownLeg): RollupCall {
    return {
      model: leg.model,
      inputTokens: leg.inputTokens,
      outputTokens: leg.outputTokens,
      cacheReadTokens: leg.cacheReadTokens,
      cacheWriteTokens: leg.cacheWriteTokens,
      reasoningTokens: leg.reasoningTokens,
      nanoAiu: leg.nanoAiu,
      timestamp: leg.timestamp,
      deduplicationKey: shutdownKey(leg.model, leg.legIndex),
    }
  }

  /**
   * Give a withheld store row's output the only owner it can still have.
   *
   * A row of a session that HAS a local `events.jsonl` is emitted with output 0,
   * because the per-turn call is the better owner: it carries the request's
   * tools, skills and prompt too, so the ledger can attribute that cost to them.
   * A CLI build that writes per-turn output nowhere (CLI 1.0.8x / the VS Code
   * agent host, whose every `assistant.message` is a request with no tokens)
   * leaves that hand-off with nobody to take it — and so does an ACP host, whose
   * process is killed on IDE exit, so no `session.shutdown` ever carries it
   * either. Those rows serve the output as their own call instead: stable key
   * (`copilot:<session>:store-output:<row>`), the row's input and cache stay on
   * the row, and the rollup subtracts it as covered, so a session that DOES shut
   * down is never billed twice for it.
   */
  function appendStoreOutputCandidates(state: FoldState): void {
    if (!localSessionIds.has(sessionId)) return
    const perTurnOutputModels = new Set<string>()
    for (const candidate of state.candidates) {
      if (candidate.kind === 'assistant' && candidate.model && candidate.outputTokens > 0) {
        perTurnOutputModels.add(candidate.model)
      }
    }
    for (const [key, rows] of storeRows) {
      const separator = key.indexOf('\n')
      if (separator < 0 || key.slice(0, separator) !== sessionId) continue
      const model = key.slice(separator + 1)
      if (perTurnOutputModels.has(model)) continue
      for (const row of rows) {
        if (row.outputTokens > 0 || row.rawOutputTokens <= 0) continue
        row.outputServedByAlias = true
        state.candidates.push({
          kind: 'store-output',
          deduplicationKey: 'copilot:' + sessionId + ':store-output:' + row.rowId + ':' + row.contentHash,
          model,
          outputTokens: row.rawOutputTokens,
          timestamp: row.timestamp,
        })
      }
    }
  }

  function foldEvent(event: CopilotJsonlEvent, state: FoldState): void {
    const timestampResult = decodeCopilotString(event.timestamp)
    const timestamp = Result.isSuccess(timestampResult) ? timestampResult.success : ''
    if (timestamp) state.lastEventTimestamp = timestamp
    const data = event.data

    if (event.type === 'session.start') {
      if (!isTranscript) updateModel(data['selectedModel'], state)
      return
    }
    if (event.type === 'session.model_change') {
      updateModel(data['newModel'], state)
      return
    }
    if (event.type === 'subagent.selected') {
      const rawAgent = data['agentName']
      const agent = decodeCopilotString(rawAgent)
      state.currentSubagentType = Result.isSuccess(agent) ? agent.success : undefined
      state.currentSubagentInvalid = Boolean(rawAgent) && Result.isFailure(agent)
      return
    }
    if (event.type === 'user.message') {
      const rawMessage = data['content']
      const message = decodeCopilotString(rawMessage)
      state.pendingUserMessage = Result.isSuccess(message) ? message.success : ''
      state.pendingUserMessageInvalid = rawMessage !== undefined && rawMessage !== null && Result.isFailure(message)
      state.userMessageVersion++
      return
    }
    // An in-session compaction RESETS the CLI's rollup counters, so a leg that
    // contains one describes only its post-compaction requests. Recognized here,
    // stamped onto the leg, and used to start that leg's store-row interval at
    // the compaction instead of at the previous leg — the difference between
    // subtracting the requests the rollup covers and subtracting the whole
    // pre-compaction conversation from it.
    // `compaction_start` is recognized and carries nothing we need: only a
    // COMPLETE with `success: true` reset anything.
    if (event.type === 'session.compaction_complete') {
      const ms = Date.parse(timestamp)
      if (data['success'] === true && Number.isFinite(ms)) state.lastCompactionMs = ms
      return
    }
    if (event.type === 'session.compaction_start') return
    if (event.type === 'session.shutdown') {
      if (!isTranscript) foldShutdown(data, timestamp, state)
      return
    }
    if (event.type !== 'assistant.message') return

    const toolFacts = extractCopilotJsonlToolFacts(data['toolRequests'])
    state.openaiToolIds += toolFacts.openaiToolIds
    state.anthropicToolIds += toolFacts.anthropicToolIds

    let selectedModelInvalid = false
    const rawModel = data['model']
    if (rawModel) {
      const modelResult = decodeCopilotString(rawModel)
      if (Result.isSuccess(modelResult)) updateModel(modelResult.success, state)
      else selectedModelInvalid = true
    }

    const modelInvalid = selectedModelInvalid || state.modelInvalid
    const model = modelInvalid ? undefined : state.model
    const transcriptFallback = isTranscript && !modelInvalid && !model
    if (!model && !modelInvalid && !transcriptFallback) return

    const rawOutput = data['outputTokens']
    const hasOutputTokenCount = rawOutput !== undefined
    const outputResult = rawOutput === undefined ? Result.succeed(0) : decodeCopilotFinite(rawOutput)
    // Missing counters still identify model activity; explicit zero does not.
    if (
      !isTranscript &&
      !modelInvalid &&
      hasOutputTokenCount &&
      Result.isSuccess(outputResult) &&
      outputResult.success === 0
    )
      return

    if (model && Result.isSuccess(outputResult) && outputResult.success > 0) state.legHasPerTurnOutput = true

    state.candidates.push({
      kind: 'assistant',
      deduplicationKey: 'copilot:' + sessionId + ':' + String(data['messageId']),
      model,
      modelInvalid,
      transcriptFallback,
      outputTokens: Result.isSuccess(outputResult) ? outputResult.success : 0,
      tokensInvalid: Result.isFailure(outputResult),
      tools: toolFacts.tools,
      bashCommands: toolFacts.bashCommands,
      skills: toolFacts.skills,
      subagentType: state.currentSubagentType,
      subagentInvalid: state.currentSubagentInvalid,
      timestamp,
      timestampInvalid: event.timestamp !== undefined && event.timestamp !== null && Result.isFailure(timestampResult),
      userMessage: state.pendingUserMessage,
      userMessageInvalid: state.pendingUserMessageInvalid,
      userMessageVersion: state.userMessageVersion,
    })
  }

  function updateModel(raw: unknown, state: FoldState): void {
    if (raw === undefined || raw === null) return
    const result = decodeCopilotString(raw)
    if (Result.isSuccess(result)) {
      state.model = result.success
      state.modelInvalid = false
    } else {
      state.model = undefined
      state.modelInvalid = true
    }
  }

  /**
   * Fold one `session.shutdown` leg into the DELTA it contributes.
   *
   * A resumed session appends one rollup per leg, each carrying CUMULATIVE
   * counters: leg 3 repeats legs 1 and 2. Serving a leg whole would need the
   * cache to update a call in place, and the cache is append-only by dedup key,
   * so each leg serves as `cumulative - previous cumulative` under its own key.
   * A total BELOW its predecessor is a fresh accounting epoch — an older
   * per-leg CLI, or the counter reset an in-session compaction causes — and is
   * taken at face value instead of being clamped to nothing, so that usage is
   * never dropped. `inputTokens` is the monotonic sentinel: it is
   * cache-inclusive, so any usage at all grows it.
   */
  function foldShutdown(data: Record<string, unknown>, timestamp: string, state: FoldState): void {
    const metrics = decodeCopilotRecord(data['modelMetrics'])
    if (Result.isFailure(metrics)) return
    const shutdownTimestamp = timestamp || timestampToISO(data['sessionStartTime']) || state.lastEventTimestamp
    const shutdownMs = Date.parse(shutdownTimestamp)
    // A stamp nobody can parse is placed at +Infinity on purpose: every leg
    // then coalesces into ONE residual that subtracts every row of the pair,
    // which can only under-report. Problems with no local fix must not invent
    // spend.
    const timestampMs = Number.isFinite(shutdownMs) ? shutdownMs : Number.POSITIVE_INFINITY
    for (const [model, rawMetrics] of Object.entries(metrics.success)) {
      if (!model) continue
      if (!state.modelOrder.includes(model)) state.modelOrder.push(model)
      const modelMetrics = decodeCopilotRecord(rawMetrics)
      if (Result.isFailure(modelMetrics)) continue
      const usage = decodeCopilotRecord(modelMetrics.success['usage'])
      if (Result.isFailure(usage)) continue

      const legIndex = (state.legCounts.get(model) ?? 0) + 1
      state.legCounts.set(model, legIndex)

      let invalid = false
      const counters = new Map<string, number>()
      for (const key of [
        'inputTokens',
        'outputTokens',
        'cacheReadTokens',
        'cacheWriteTokens',
        'reasoningTokens',
      ] as const) {
        const raw = usage.success[key]
        if (raw === undefined) {
          counters.set(key, 0)
          continue
        }
        const result = decodeCopilotFinite(raw)
        if (Result.isFailure(result)) invalid = true
        else counters.set(key, Math.max(0, result.success))
      }
      if (invalid) {
        state.invalidRollups.add(model)
        continue
      }
      if (state.invalidRollups.has(model)) continue

      const billRaw = modelMetrics.success['totalNanoAiu']
      const bill = typeof billRaw === 'number' && Number.isFinite(billRaw) && billRaw >= 0 ? billRaw : undefined
      const cumulative: CumulativeUsage = {
        inputTokens: counters.get('inputTokens') ?? 0,
        outputTokens: counters.get('outputTokens') ?? 0,
        cacheReadTokens: counters.get('cacheReadTokens') ?? 0,
        cacheWriteTokens: counters.get('cacheWriteTokens') ?? 0,
        reasoningTokens: counters.get('reasoningTokens') ?? 0,
        nanoAiu: bill ?? 0,
      }
      const prevRaw = state.prevShutdown.get(model)
      state.prevShutdown.set(model, cumulative)
      const prev = prevRaw && cumulative.inputTokens < prevRaw.inputTokens ? undefined : prevRaw
      const delta = (key: keyof CumulativeUsage) => Math.max(0, cumulative[key] - (prev?.[key] ?? 0))

      const cacheReadTokens = delta('cacheReadTokens')
      const cacheWriteTokens = delta('cacheWriteTokens')
      const reasoningTokens = delta('reasoningTokens')
      const inputTokens = Math.max(0, delta('inputTokens') - cacheReadTokens - cacheWriteTokens)
      // Output is only the rollup's to report when NO per-turn event in this leg
      // carried it (CLI 1.0.8x / the VS Code agent host).
      const outputTokens = state.legHasPerTurnOutput ? 0 : delta('outputTokens')
      // The bill is a running total too, and it does NOT reset at compaction, so
      // its delta is taken against the raw predecessor even when the token
      // counters reset. A figure that went backwards is a restarted bill, and 0
      // then simply reports nothing for this leg.
      const nanoAiu =
        bill === undefined ? undefined : Math.max(0, bill - (prevRaw && bill >= prevRaw.nanoAiu ? prevRaw.nanoAiu : 0))

      if (
        inputTokens === 0 &&
        outputTokens === 0 &&
        cacheReadTokens === 0 &&
        cacheWriteTokens === 0 &&
        reasoningTokens === 0 &&
        nanoAiu === undefined
      )
        continue

      state.legs.push({
        model,
        legIndex,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        reasoningTokens,
        nanoAiu: nanoAiu === 0 ? undefined : nanoAiu,
        timestamp: shutdownTimestamp,
        timestampMs,
        compactedAtMs: state.lastCompactionMs,
      })
    }
    state.legHasPerTurnOutput = false
  }

  return copilotParser(parseStream)
}
function createChatSessionParser(
  source: SessionSource,
  seenKeys: Set<string>,
  storeSessionIds: ReadonlySet<string>,
  agentHostUsageSessions: ReadonlySet<string>,
  context: CopilotParserContext,
): SessionParser {
  const parseStream: NonNullable<SessionParser['parseStream']> = onUnparsedCall =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* checkScanAbort(context.signal)
        let root: unknown = createReplayObject()
        // VS Code before 1.109 saved a chat session as ONE flat JSON document;
        // newer versions save the same session as a delta journal. VS Code keeps
        // the flat file when it migrates, so both shapes are read and dedupe on the
        // same `copilot-chatsession:` key.
        if (source.path.endsWith('.json')) {
          const flattened = yield* Effect.result(readTextEffect(source.path, 'utf8', context.signal))
          if (Result.isFailure(flattened) || flattened.success === null) return Stream.empty
          const decodedDocument = decodeCopilotJson(flattened.success)
          if (Result.isFailure(decodedDocument)) return Stream.empty
          root = decodedDocument.success
        } else {
          const readResult = yield* Effect.result(
            Stream.runForEach(
              readSessionLinesStream(source.path, undefined, {
                maxBytes: MAX_SESSION_FILE_BYTES,
                readFailure: 'fail',
                ...(context.signal ? { signal: context.signal } : {}),
              }),
              line =>
                Effect.sync(() => {
                  root = replayChatSessionJournalLine(root, typeof line === 'string' ? line : line.toString('utf8'))
                }),
            ),
          )
          if (Result.isFailure(readResult)) return Stream.empty
        }
        yield* checkScanAbort(context.signal)
        const decodedRoot = decodeCopilotRecord(root)
        if (Result.isFailure(decodedRoot)) return Stream.empty
        const session = decodedRoot.success
        const sessionId = readString(session['sessionId']) || basename(source.path).replace(/\.jsonl?$/, '')
        // The agent host records one session under this same id on its own side
        // too — a `session-state` journal call with tokens, or `session-store.db`
        // rows. That side is the billed record, so this journal is left out. A
        // journal of a session with no usage yet keeps serving.
        if (storeSessionIds.has(sessionId) || agentHostUsageSessions.has(sessionId)) return Stream.empty
        const sessionCreatedAt = timestampToISO(session['creationDate'])
        const decodedRequests = decodeCopilotArray(session['requests'])
        if (Result.isFailure(decodedRequests)) return Stream.empty
        const inferredSessionModel = inferChatSessionModel(session, decodedRequests.success)

        return Stream.fromIterable(decodedRequests.success).pipe(
          Stream.mapEffect((rawReq, index) =>
            Effect.gen(function* () {
              yield* checkScanAbort(context.signal)
              const decodedRequest = decodeCopilotRecord(rawReq)
              if (Result.isFailure(decodedRequest)) return Result.fail(undefined)
              const request = decodedRequest.success
              const decodedResult = decodeCopilotRecord(request['result'])
              const decodedMetadata = Result.isSuccess(decodedResult)
                ? decodeCopilotRecord(decodedResult.success['metadata'])
                : Result.fail(undefined)
              const metadata = Result.isSuccess(decodedMetadata) ? decodedMetadata.success : createReplayObject()

              const requestId = readString(request['requestId']) || `request-${index}`
              const dedupKey = `copilot-chatsession:${sessionId}:${requestId}`
              if (seenKeys.has(dedupKey)) return Result.fail(undefined)
              seenKeys.add(dedupKey)

              const resolvedModel = metadata['resolvedModel']
              const modelId = request['modelId']
              const selectedModel = typeof resolvedModel === 'string' && resolvedModel ? resolvedModel : modelId
              if (selectedModel !== undefined && Result.isFailure(decodeCopilotString(selectedModel))) {
                if (onUnparsedCall) yield* onUnparsedCall
                return Result.fail(undefined)
              }
              const model = modelFromChatSessionRequest(request, metadata, inferredSessionModel)
              const inputResult =
                metadata['promptTokens'] === undefined
                  ? Result.succeed(0)
                  : decodeCopilotFinite(metadata['promptTokens'])
              const metadataOutputResult =
                metadata['outputTokens'] === undefined
                  ? Result.succeed(0)
                  : decodeCopilotFinite(metadata['outputTokens'])
              if (Result.isFailure(inputResult) || Result.isFailure(metadataOutputResult)) {
                if (onUnparsedCall) yield* onUnparsedCall
                return Result.fail(undefined)
              }

              // An agent-mode request makes one model call per tool round, and
              // `result.metadata.promptTokens`/`outputTokens` describe only the LAST
              // of them. `modelTotals` sums every round per model (Copilot Chat 0.69
              // on), and its `inputTokens` already counts the cached part, so it is
              // read first and the remainder served as uncached input.
              const totals = chatSessionModelTotals(request['modelTotals'])
              // `copilotCredits` is GitHub's billed `total_nano_aiu / 1e9` for the
              // WHOLE request, subagents included — the only exact price a saved
              // request carries.
              const nanoAiu = chatSessionNanoAiu(request['copilotCredits'])

              const decodedUsage = Result.isSuccess(decodedResult)
                ? decodeCopilotRecord(decodedResult.success['usage'])
                : Result.fail(undefined)
              const usage = Result.isSuccess(decodedUsage) ? decodedUsage.success : undefined
              const resultRecord = Result.isSuccess(decodedResult) ? decodedResult.success : undefined

              // First defined counter wins; a malformed one is rejected and tallied
              // rather than silently priced as 0, the rule every other field here
              // follows. A zero falls through to the next candidate, so an explicit
              // 0 in metadata still lets the request's own total apply.
              const counterFrom = (candidates: readonly unknown[]): { value: number; invalid: boolean } => {
                for (const candidate of candidates) {
                  if (candidate === undefined || candidate === null) continue
                  const decoded = decodeCopilotFinite(candidate)
                  if (Result.isFailure(decoded)) return { value: 0, invalid: true }
                  if (decoded.success > 0) return { value: Math.max(0, decoded.success), invalid: false }
                }
                return { value: 0, invalid: false }
              }

              const prompt = counterFrom([
                metadata['promptTokens'],
                resultRecord?.['promptTokens'],
                request['promptTokens'],
                usage?.['promptTokens'],
                usage?.['prompt_tokens'],
              ])
              const completion = counterFrom([
                metadata['outputTokens'],
                request['completionTokens'],
                resultRecord?.['outputTokens'],
                request['outputTokens'],
                usage?.['completionTokens'],
                usage?.['completion_tokens'],
              ])
              const cacheRead = counterFrom([
                metadata['cacheReadTokens'],
                metadata['cachedTokens'],
                resultRecord?.['cacheReadTokens'],
                resultRecord?.['cachedTokens'],
                usage?.['cacheReadTokens'],
                usage?.['cache_read_tokens'],
                usage?.['cachedTokens'],
                usage?.['cached_tokens'],
              ])
              const cacheCreation = counterFrom([
                metadata['cacheCreationTokens'],
                metadata['cacheWriteTokens'],
                resultRecord?.['cacheCreationTokens'],
                resultRecord?.['cacheWriteTokens'],
                usage?.['cacheCreationTokens'],
                usage?.['cache_creation_tokens'],
                usage?.['cacheWriteTokens'],
                usage?.['cache_write_tokens'],
              ])
              if (prompt.invalid || completion.invalid || cacheRead.invalid || cacheCreation.invalid) {
                if (onUnparsedCall) yield* onUnparsedCall
                return Result.fail(undefined)
              }

              const inputTokens = totals ? totals.inputTokens : prompt.value
              const outputTokens = totals ? totals.outputTokens : completion.value
              const cacheReadTokens = totals ? totals.cacheReadTokens : cacheRead.value
              const cacheCreationTokens = totals ? 0 : cacheCreation.value
              if (
                inputTokens === 0 &&
                outputTokens === 0 &&
                cacheReadTokens === 0 &&
                cacheCreationTokens === 0 &&
                nanoAiu === undefined
              )
                return Result.fail(undefined)

              // The billed figure, when the request carries one, is the cost: the
              // last round's prompt cannot price a multi-round request. Otherwise
              // the recorded tokens are priced as before.
              const costUSD =
                nanoAiu !== undefined
                  ? nanoAiuToUsd(nanoAiu)
                  : context.pricing.calculateCost(
                      model,
                      inputTokens,
                      outputTokens,
                      cacheCreationTokens,
                      cacheReadTokens,
                      0,
                    )
              const timestamp = timestampToISO(request['timestamp']) || sessionCreatedAt
              return Result.succeed({
                provider: 'copilot' as const,
                sessionId,
                project: source.project,
                model,
                inputTokens,
                outputTokens,
                cacheCreationInputTokens: cacheCreationTokens,
                cacheReadInputTokens: cacheReadTokens,
                cachedInputTokens: 0,
                reasoningTokens: 0,
                webSearchRequests: 0,
                costUSD,
                tools: extractChatSessionTools(metadata),
                bashCommands: [],
                timestamp,
                speed: 'standard' as const,
                deduplicationKey: dedupKey,
                userMessage: extractChatSessionUserMessage(request),
                ...(source.workingDirectory
                  ? { projectPath: source.workingDirectory, workingDirectory: source.workingDirectory }
                  : {}),
              })
            }),
          ),
          Stream.filterMap(result => result),
        )
      }),
    )

  return copilotParser(parseStream)
}

// ---------------------------------------------------------------------------
// session-store.db parser — the Copilot CLI's per-request usage ledger
// ---------------------------------------------------------------------------
//
// The CLI writes one `assistant_usage_events` row per API REQUEST. Between the
// store and events.jsonl the three sources divide the work like this:
//
//   input / cache-read / cache-write   store rows are authoritative (per
//                                     request); the events.jsonl
//                                     `session.shutdown` rollup reports the
//                                     same tokens lumped per model.
//   output                             events.jsonl `assistant.message`
//                                     owns it, per turn — except where the
//                                     session has no local journal at all (the
//                                     row keeps it) or the journal's messages
//                                     carry no `outputTokens` (the
//                                     `session.shutdown` rollup carries the
//                                     store's per-request output instead).
//   compaction output                  the store row is the ONLY copy — a
//                                     compaction request produces no
//                                     assistant message to own it.
//
// What the rollup reports BEYOND the rows is served as one residual call at the
// rollup's own (stable) dedup key, so a session whose rows are pruned or whose
// crash skipped the store write never loses the tokens the CLI did record.
//
// The dedup key namespace `copilot-store:` is distinct from every other key
// this file mints (`copilot:<session>:shutdown:<model>`,
// `copilot:<session>:<messageId>`, `copilot-chatsession:…`, `copilot:jb:…`,
// `copilot-otel:<spanId>`), so a store row can never be mistaken for one of
// them by the shared `seenKeys` set.

/**
 * The content discriminator folded into a store row's dedup key.
 *
 * `id` alone is NOT a safe identity: it is AUTOINCREMENT, so it is stable
 * within one database lifetime but a recreated database at the same path
 * restarts the sequence. A bare `copilot-store:<session>:<id>` key would then
 * let the durable cache treat a genuinely different request as already cached
 * and silently swallow it forever. Hashing the row's own model and token
 * counts makes a re-created database produce a DIFFERENT key for a different
 * row, while a byte-identical re-insert (a backup restore, `VACUUM INTO`)
 * still collapses to the same key — which is the point: that IS the same row.
 */
function sessionStoreContentHash(row: {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  initiator: string
}): string {
  const material = [
    row.model,
    row.inputTokens,
    row.outputTokens,
    row.cacheReadTokens,
    row.cacheWriteTokens,
    row.reasoningTokens,
    row.initiator,
  ].join('|')
  return createHash('sha256').update(material).digest('hex').slice(0, 12)
}

/**
 * Resolve a store row's project label.
 *
 * One database spans every project, so attribution has to come from the
 * `sessions` row: `repository` is the plugin's own `owner/name` (the analogue
 * of the OTel source's `github.copilot.git.repository`), and `cwd` is the
 * checkout it ran in. Precedence mirrors the JetBrains parser's: the store's
 * own recorded label wins, then the workspace basename, then one honest bucket
 * — never a chat-thread title, which would pollute By-Project.
 */
/**
 * The last segment of a project path, whichever separator style it uses.
 *
 * A Copilot store is written by whichever machine ran the CLI, so a `cwd` or
 * `repository` can arrive carrying the other platform's separators — a
 * Windows path read on a POSIX host, or a synced database read on Windows.
 * The platform's own `basename` is correct only for its own style and returns
 * the whole string for the other, which files a session under a project
 * literally named `C:\work\no-repo`.
 *
 * Pure string handling on purpose: it calls no `path` helper, so the result
 * cannot depend on the host platform. The `.git` suffix is stripped by the
 * caller before the segment is taken, as before.
 */
function lastPathSegment(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed
}

function resolveStoreProject(cwd: string | null, repository: string | null): string {
  const repo = readString(repository)
    .trim()
    .replace(/\.git$/, '')
  if (repo) {
    const name = lastPathSegment(repo)
    if (name) return name
  }
  const dir = readString(cwd).trim()
  if (dir) {
    const name = lastPathSegment(dir)
    if (name) return name
  }
  return 'copilot-cli'
}

/**
 * Parse `session-store.db` into one `ParsedProviderCall` per API request.
 *
 * `storeRows` is the provider-lifetime record of what this store has described,
 * one entry per row per `${sessionId}\n${model}`, and `storeSessionIds` the
 * sessions it bills. The `session.shutdown` handler subtracts the rows of its
 * interval from each leg (see the residual in createJsonlParser) and serves a
 * withheld row's output when the journal recorded none; the chat-session parser
 * drops a journal whose session already has billed usage. The store source is
 * discovered FIRST so both are complete before any other source is parsed.
 *
 * A missing / empty / corrupt / locked database yields nothing and throws
 * nothing: the CLI writes this file live (with `-wal` / `-shm` siblings), so a
 * transient lock is routine and must never abort a scan. Failures are reported
 * through the provider's existing problem-reporting path and the parse returns
 * empty, exactly as a table-less database does.
 */

/**
 * The columns every store schema this parser must accept can serve.
 *
 * Text is projected `CAST(... AS BLOB)` + a `typeof(...)` companion so the
 * decoder can tell a NULL from text and never has to guess a driver's encoding.
 */
const SESSION_STORE_USAGE_COLUMNS = `u.id,
  CASE WHEN typeof(u.session_id) = 'text' THEN CAST(u.session_id AS BLOB) ELSE NULL END AS session_id,
  typeof(u.session_id) AS session_id_type,
  CASE WHEN typeof(u.model) = 'text' THEN CAST(u.model AS BLOB) ELSE NULL END AS model,
  typeof(u.model) AS model_type,
  u.input_tokens, u.output_tokens,
  u.cache_read_tokens, u.cache_write_tokens, u.reasoning_tokens,
  CASE WHEN typeof(u.initiator) = 'text' THEN CAST(u.initiator AS BLOB) ELSE NULL END AS initiator,
  typeof(u.initiator) AS initiator_type,
  CASE WHEN typeof(u.created_at) = 'text' THEN CAST(u.created_at AS BLOB) ELSE NULL END AS created_at,
  typeof(u.created_at) AS created_at_type,
  CASE WHEN typeof(s.cwd) = 'text' THEN CAST(s.cwd AS BLOB) ELSE NULL END AS cwd,
  typeof(s.cwd) AS cwd_type,
  CASE WHEN typeof(s.repository) = 'text' THEN CAST(s.repository AS BLOB) ELSE NULL END AS repository,
  typeof(s.repository) AS repository_type`
const SESSION_STORE_USAGE_FROM = `
  FROM assistant_usage_events u
  LEFT JOIN sessions s ON s.id = u.session_id
  ORDER BY u.id ASC`

/**
 * Read the store richest-first, so a CLI whose schema predates the billing
 * columns (`total_nano_aiu`, which only newer builds write) still parses — its
 * rows simply price from their own tokens, exactly as before this column was
 * read at all. Absence is reported through `no such column`, which is the one
 * failure this ladder retries; anything else is the caller's to report.
 */
const SESSION_STORE_USAGE_SELECTS = [
  `SELECT ${SESSION_STORE_USAGE_COLUMNS}, u.total_nano_aiu${SESSION_STORE_USAGE_FROM}`,
  `SELECT ${SESSION_STORE_USAGE_COLUMNS}${SESSION_STORE_USAGE_FROM}`,
]

function querySessionStoreRows(db: SqliteDatabase): SessionStoreUsageRow[] {
  let lastError: unknown
  for (const sql of SESSION_STORE_USAGE_SELECTS) {
    try {
      return db.query<SessionStoreUsageRow>(sql)
    } catch (cause) {
      lastError = cause
    }
  }
  throw lastError
}

function createSessionStoreParser(
  source: SessionStoreSource,
  seenKeys: Set<string>,
  storeRows: Map<string, StoreRowUsage[]>,
  storeSessionIds: Set<string>,
  localSessionIds: ReadonlySet<string>,
  context: CopilotParserContext,
): SessionParser {
  const parseStream: NonNullable<SessionParser['parseStream']> = onUnparsedCall =>
    Stream.scoped(
      Stream.unwrap(
        Effect.gen(function* () {
          yield* checkScanAbort(context.signal)
          const opened = yield* Effect.acquireRelease(
            openCopilotDatabase(source.path).pipe(
              Effect.catch(error => {
                reportProviderIssue('copilot', fileErrorCode(error.cause, 'session-store-unreadable'), source.path)
                return Effect.succeed(null)
              }),
            ),
            owned => (owned ? closeCopilotDatabase(owned).pipe(Effect.orDie) : Effect.void),
          )
          if (!opened) return Stream.empty
          const sourceRows = new Map<string, StoreRowUsage[]>()
          const rows = yield* Effect.try({
            try: () => querySessionStoreRows(opened.db),
            catch: cause => copilotDatabaseError('read', cause),
          }).pipe(
            Effect.catch(error => {
              if (isScanAbortedError(error.cause)) return Effect.fail(error)
              reportProviderIssue('copilot', fileErrorCode(error.cause, 'session-store-unreadable'), source.path)
              return Effect.succeed(null)
            }),
          )
          if (!rows) return Stream.fromEffectDrain(closeCopilotDatabase(opened))

          const calls = Stream.fromIterable(rows).pipe(
            Stream.rechunk(1),
            Stream.mapEffect(candidate =>
              Effect.gen(function* () {
                yield* checkScanAbort(context.signal)
                const decodedRow = decodeSessionStoreUsageRow(candidate)
                if (Result.isFailure(decodedRow)) {
                  if (onUnparsedCall) yield* onUnparsedCall
                  return Result.fail(undefined)
                }
                const row = decodedRow.success
                const sessionId = blobToText(row.session_id)
                if (!sessionId) return Result.fail(undefined)

                // A hand-built store can carry an empty model. Never drop a billable
                // row for an unnameable model: 'unknown' prices at $0 and surfaces
                // through the existing unpriced-model signal, which is the honest
                // outcome — silently discarding the row would hide real spend.
                const model = blobToText(row.model).trim() || 'unknown'
                const initiator = blobToText(row.initiator).trim()

                const cacheReadTokens = numberOrZero(row.cache_read_tokens)
                const cacheWriteTokens = numberOrZero(row.cache_write_tokens)
                const reasoningTokens = numberOrZero(row.reasoning_tokens)
                const rawInputTokens = numberOrZero(row.input_tokens)
                const rawOutputTokens = numberOrZero(row.output_tokens)

                // `input_tokens` is cache-INCLUSIVE (uncached input + cache_read +
                // cache_write) — the same convention the events.jsonl
                // `session.shutdown` rollup uses. calculateCost wants the uncached
                // input alone with the cache components billed separately, so
                // subtract them. Clamped at 0 for the same reason as there: a future
                // schema must not make a negative uncached input.
                const inputTokens = Math.max(0, rawInputTokens - cacheReadTokens - cacheWriteTokens)

                // Nothing billable in this row (a failed / filtered request the CLI
                // still logged). Skipping avoids an empty $0 row in every view.
                if (inputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0 && rawOutputTokens === 0)
                  return Result.fail(undefined)

                // This (session, model) is now described by the store, so the
                // events.jsonl rollup for it must stand down. See createJsonlParser
                // for what that costs.
                const coveredKey = `${sessionId}\n${model}`

                // OUTPUT OWNERSHIP — the one place this source could double-count.
                //
                // A request's output has two possible owners: the per-turn
                // `assistant.message` event in events.jsonl (parsed from a DIFFERENT
                // source later in the same pass) and this row. `seenKeys` cannot
                // arbitrate (the two carry different dedup keys, and claiming a
                // shared one would drop the per-turn row together with its tools /
                // bashCommands / userMessage — strictly worse than a counted token),
                // and this architecture has no serve-time cross-source pass.
                //
                // So ownership follows whether a LOCAL per-turn journal exists for
                // the session at all — `localSessionIds`, filled by discovery, which
                // completes before the first parser runs:
                //
                //   - `session-state/<id>/events.jsonl` present: its per-turn events
                //     own output and every non-compaction row yields 0. That is what
                //     stops a normal CLI session from billing its output twice.
                //   - No local journal: nothing will ever report that output. These
                //     are the sessions that are not local to this machine — an ACP
                //     host (JetBrains AI Chat, `copilot --acp`), the GitHub desktop
                //     app, rows synced from another checkout, or a session-state dir
                //     already pruned — and their row keeps `output_tokens`, the only
                //     copy that exists anywhere.
                //
                // A compaction row always keeps its output: it produces no
                // `assistant.message` of its own, local journal or not.
                //
                // COST OF THIS CHOICE: a LOCAL session's rows yield no output, so a
                // journal whose per-turn events carry no `outputTokens` at all (the
                // CLI 1.0.8x / VS Code agent-host shape) hands nothing over. The
                // journal parser closes that: when there is no per-turn output for
                // the model it serves each such row's output as its own call (see
                // appendStoreOutputCandidates). A session with neither a shutdown nor
                // a journal parser that ever reads the file keeps its input/cache
                // from the rows and loses only the output.
                const hasLocalJournal = localSessionIds.has(sessionId)
                const outputTokens = initiator === 'compaction' || !hasLocalJournal ? rawOutputTokens : 0

                // `copilot` is in OUTPUT_INCLUSIVE_REASONING_PROVIDERS, so
                // reasoning is already inside the store's `output_tokens` and must
                // NOT be added again. billableOutputTokens is the single place that
                // answers that question; the arithmetic is never reimplemented here.
                // GitHub's own figure for this request, when the schema carries
                // it: an exact bill beats any token arithmetic, because
                // `total_nano_aiu` already covers subagent requests the store
                // never wrote rows for. Absent on older CLIs, which price from
                // their tokens exactly as before.
                const nanoAiu =
                  typeof row.total_nano_aiu === 'number' &&
                  Number.isFinite(row.total_nano_aiu) &&
                  row.total_nano_aiu >= 0
                    ? row.total_nano_aiu
                    : undefined
                const costUSD =
                  nanoAiu !== undefined
                    ? nanoAiuToUsd(nanoAiu)
                    : yield* Effect.try({
                        try: () =>
                          context.pricing.calculateCost(
                            model,
                            inputTokens,
                            billableOutputTokens('copilot', outputTokens, reasoningTokens),
                            cacheWriteTokens,
                            cacheReadTokens,
                            0,
                          ),
                        catch: cause => (cause instanceof Error ? cause : new Error(String(cause), { cause })),
                      })

                const rowId = String(row.id)
                const contentHash = sessionStoreContentHash({
                  model,
                  inputTokens: rawInputTokens,
                  outputTokens: rawOutputTokens,
                  cacheReadTokens,
                  cacheWriteTokens,
                  reasoningTokens,
                  initiator,
                })
                const dedupKey = `copilot-store:${sessionId}:${rowId}:${contentHash}`

                const cwd = blobToText(row.cwd).trim() || null
                // The row's own `created_at`, normalized through the same helper the
                // JSONL / chatSessions paths use, so a row can never be dropped by
                // the period filter on a formatting difference. A row with no usable
                // timestamp falls back to the session-state file's mtime (the same
                // fallback the JetBrains parser uses) rather than being dropped.
                const timestamp = timestampToISO(blobToText(row.created_at)) || source.mtime
                const timestampMs = Date.parse(timestamp)

                // Record what the row describes BEFORE the dedupe return: a row the
                // pipeline already holds still describes its tokens, and the journal
                // subtracts these records from its rollup legs either way.
                const rowList = sourceRows.get(coveredKey) ?? []
                rowList.push({
                  rowId,
                  contentHash,
                  timestamp,
                  timestampMs: Number.isFinite(timestampMs) ? timestampMs : Number.POSITIVE_INFINITY,
                  inputTokens,
                  outputTokens,
                  rawOutputTokens,
                  cacheReadTokens,
                  cacheWriteTokens,
                  reasoningTokens,
                  isCompaction: initiator === 'compaction',
                  outputServedByAlias: false,
                })
                sourceRows.set(coveredKey, rowList)
                storeSessionIds.add(sessionId)
                if (seenKeys.has(dedupKey)) return Result.fail(undefined)
                seenKeys.add(dedupKey)

                return Result.succeed({
                  provider: 'copilot',
                  sessionId,
                  project: resolveStoreProject(cwd, blobToText(row.repository) || null),
                  model,
                  inputTokens,
                  outputTokens,
                  cacheCreationInputTokens: cacheWriteTokens,
                  cacheReadInputTokens: cacheReadTokens,
                  cachedInputTokens: 0,
                  reasoningTokens,
                  webSearchRequests: 0,
                  costUSD,
                  // These are real counts the CLI wrote per request, not estimates
                  // from characters — the same contract the shutdown rollup sets.
                  costIsEstimated: false,
                  tools: [],
                  bashCommands: [],
                  timestamp,
                  speed: 'standard' as const,
                  deduplicationKey: dedupKey,
                  userMessage: '',
                  ...(cwd ? { projectPath: cwd, workingDirectory: cwd } : {}),
                })
              }),
            ),
            Stream.filterMap(value => value),
          )
          const finish = Stream.fromEffect(
            Effect.gen(function* () {
              yield* checkScanAbort(context.signal)
              yield* closeCopilotDatabase(opened)
              for (const [key, rows] of sourceRows) storeRows.set(key, rows)
            }),
          ).pipe(Stream.drain)
          return Stream.concat(calls, finish)
        }),
      ),
    )
  return copilotParser(parseStream)
}

// ---------------------------------------------------------------------------
// JetBrains parser (Nitrite .db from ~/.config/github-copilot)
// ---------------------------------------------------------------------------
//
// The JetBrains Copilot plugin stores each chat/agent session in a Nitrite
// (H2 MVStore) .db of Java-serialized documents. There is NO token accounting
// anywhere in the store, so we estimate output tokens from the assistant reply
// text (the same char-count approach the pipeline already uses for Cursor and
// legacy Copilot JSONL). Cost is therefore marked costIsEstimated.
//
// The model (e.g. "claude-opus-4.5", "gpt-4.1") is not always tagged on each
// turn, so we recover it by scanning the raw buffer for a known model token.

// Known JetBrains Copilot model tokens, longest-first so we match the most
// specific name (e.g. "gpt-4.1-mini" before "gpt-4.1").
const JETBRAINS_MODEL_TOKENS = [
  'claude-opus-4.5',
  'claude-opus-4.1',
  'claude-opus-4',
  'claude-sonnet-4.5',
  'claude-sonnet-4',
  'gpt-5.3-codex',
  'gpt-5.3',
  'gpt-5.2',
  'gpt-5.1',
  'gpt-5-mini',
  'gpt-5',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-4.1',
  'gpt-4o-mini',
  'gpt-4o',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
  'o3-mini',
  'o4-mini',
  'o3',
]

/**
 * Normalise a raw JetBrains model token to the canonical model id.
 * Claude names use dots on disk (claude-opus-4.5) but dashes in the pricing
 * tables (claude-opus-4-5); GPT/Gemini names are kept verbatim.
 */
function normalizeJetBrainsModelName(raw: string): string {
  const t = raw.trim()
  if (!t) return ''
  if (t.startsWith('claude-')) return t.replace(/\./g, '-')
  return t
}

/** Match a known model token at an alnum boundary anywhere in a string. */
function findJetBrainsModelToken(s: string): string {
  for (const token of JETBRAINS_MODEL_TOKENS) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // "o3" etc. must not match inside words like "iso3166".
    if (new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`).test(s)) {
      return normalizeJetBrainsModelName(token)
    }
  }
  return ''
}

/** Recover a model from a raw buffer by scanning for a known token. */
function inferJetBrainsModel(raw: string): string {
  return findJetBrainsModelToken(raw)
}

/**
 * Infer the project (repository name) from the file:// URIs a chat referenced.
 *
 * The JetBrains store has no workspace/cwd record, and there is no reliable
 * marker inside a path for where the repo root sits (users nest repos under
 * arbitrary container dirs). So for each referenced file we walk UP the real
 * filesystem to the nearest ancestor containing a `.git` entry and use that
 * directory's basename — the true repo root. This is the one approach that
 * yields a clean, consistent name (e.g. `my-service`) instead of a deep subdir
 * or an inconsistent prose-scraped guess.
 *
 * Returns undefined when the chat referenced no files or none resolve to a repo
 * that still exists on disk (caller then falls back to a generic bucket).
 */
function inferJetBrainsProject(raw: string): string | undefined {
  // Capture referenced absolute paths (original case — we hit the real FS).
  const re = /file:\/\/(\/[^"\\]+?)(?:\\|")/g
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    // Decode %20 etc. and strip a trailing .rej/.orig suffix noise; keep the dir.
    let p = m[1]
    try {
      p = decodeURIComponent(p)
    } catch {
      /* leave as-is */
    }
    const dir = p.slice(0, p.lastIndexOf('/'))
    if (dir.startsWith('/')) seen.add(dir)
  }
  if (seen.size === 0) return undefined

  for (const dir of seen) {
    const repo = findGitRepoRoot(dir)
    if (repo) return repo
  }
  return undefined
}

/** Walk up from `dir` to the nearest ancestor containing `.git`; return its basename. */
function findGitRepoRoot(dir: string): string | undefined {
  let cur = dir
  // Bound the walk to avoid pathological loops; repos are never this deep.
  for (let i = 0; i < 40 && cur && cur !== '/'; i++) {
    if (existsSync(join(cur, '.git'))) {
      const name = basename(cur)
      return name || undefined
    }
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return undefined
}

/**
 * Recover the plugin-recorded project label from a Nitrite .db.
 *
 * JetBrains Copilot 1.12+ serialises a `projectName` field on the session doc
 * (e.g. `my-service`, `watchtower`). It is the plugin's OWN authoritative
 * label — the JetBrains analogue of the OTel source's
 * `github.copilot.git.repository` — so it is preferred over the file-path
 * git-walk heuristic when present.
 *
 * The field is a Java-serialized string: the key bytes `projectName` are
 * followed immediately by TC_STRING framing `0x74 <u16 big-endian length>
 * <UTF-8 bytes>`. We read exactly `length` bytes (so an embedded newline or
 * quote can't truncate it) and accept the first occurrence whose value is a
 * plausible short, printable repo name. Older plugins that don't write the
 * field simply yield undefined (callers fall back to the git-walk).
 *
 * Note: the field lives on the session doc, which the plugin writes into the
 * `chat-sessions` / `chat-edit-sessions` stores — often NOT the
 * `chat-agent-sessions` store where the billable turns live. Discovery joins
 * the two by store id; see resolveJetBrainsProjectNames.
 */
function extractJetBrainsProjectName(raw: string): string | undefined {
  const re = /projectName\x74([\x00-\xff])([\x00-\xff])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    const len = (m[1]!.charCodeAt(0) << 8) | m[2]!.charCodeAt(0)
    // Repo names are short; a huge length means we matched a schema/key
    // occurrence rather than a value-bearing one — skip it.
    if (len < 1 || len > 128) continue
    const start = m.index + m[0].length
    // The .db is read as latin1, so re-interpret the length-delimited bytes as
    // UTF-8 (repo names can contain non-ASCII). Reject only if the decoded value
    // holds control chars — a sign we matched a non-value occurrence, not a name.
    const val = Buffer.from(raw.slice(start, start + len), 'latin1').toString('utf8')
    // eslint-disable-next-line no-control-regex
    if (val.length > 0 && !/[\x00-\x1f]/.test(val)) return val
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Nitrite .db (H2 MVStore) extraction
// ---------------------------------------------------------------------------
//
// JetBrains Copilot sessions store their conversation in the Nitrite .db
// (copilot-*-nitrite.db). One .db holds many conversations. Assistant replies
// are stored as a distinct blob shape:
//
//   {"__first__":{"type":"Subgraph","value":"..."}, ...}
//
// which is more deeply escaped than the user-message value-maps. The reply text
// is recovered by progressive unescaping and collecting "text":"..." fields.
// Failed turns ("Sorry, an error occurred …") carry an error status and no reply
// text — they are detected and billed as $0.

// One assistant turn recovered from a .db.
type JBDbTurn = {
  replyText: string
  model: string
  errored: boolean
  // The owning conversation (chat tab): its internal GUID and title. One .db
  // holds many conversations; turns are grouped back to their tab by this id.
  conversationId: string
  conversationTitle: string
  // The file path this conversation referenced (home-relative common dir), or
  // '' if the chat touched no files. Used as the project label.
  conversationProject: string
}

// A conversation (chat tab) recovered from a .db: internal GUID → title.
type JBConversation = { id: string; title: string }

/**
 * Recover the conversation (chat-tab) records from a raw .db buffer. Each is
 * stored as `$<GUID> … name … value <title> … source copilot`. Returns the
 * GUID→title map so turns can be grouped back to the tab the user sees.
 */
function extractJetBrainsConversations(raw: string): JBConversation[] {
  // A conversation's title EVOLVES as the user chats: it starts as "New Agent
  // Session", may pass through an auto-generated name, and ends at the final
  // title shown in the UI. The same `$<GUID> … name … value <title> … source`
  // record is rewritten each time, so we collect every occurrence per GUID and
  // keep the LAST meaningful (non-default) one.
  const DEFAULT_TITLES = new Set(['New Agent Session', 'New Session', 'New Chat'])
  const byId = new Map<string, string>()
  const re = /\$([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[\s\S]{0,8}name/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    const id = m[1]
    const window = raw.slice(m.index, m.index + 400)
    // The title is the Java-UTF string between the `value` marker and `source`.
    const tm = window.match(/value.{1,6}?([\x20-\x7e]{3,80}?)t\x00\x06source/)
    if (!tm) continue
    const title = Buffer.from(tm[1].replace(/^[^A-Za-z0-9]*/, ''), 'latin1')
      .toString('utf8')
      .trim()
    if (!title) continue
    // Keep the latest non-default title; only fall back to a default if no
    // meaningful title has been seen for this conversation yet.
    const existing = byId.get(id)
    if (existing && !DEFAULT_TITLES.has(existing) && DEFAULT_TITLES.has(title)) continue
    byId.set(id, title)
  }
  return [...byId.entries()].map(([id, title]) => ({ id, title }))
}

/** Brace-match a JSON object starting at `start`, tolerating escaped quotes. */
function matchJsonObject(raw: string, start: number): { chunk: string; end: number } {
  let depth = 0
  let inStr = false
  let esc = false
  let i = start
  for (; i < raw.length; i++) {
    const c = raw[i]
    if (esc) {
      esc = false
      continue
    }
    if (c === '\\') {
      esc = true
      continue
    }
    if (c === '"') {
      inStr = !inStr
      continue
    }
    if (inStr) continue
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        i++
        break
      }
    }
  }
  return { chunk: raw.slice(start, i), end: i }
}

/**
 * Recover the assistant reply text from a `__first__`/Subgraph response blob.
 *
 * JetBrains Copilot has two turn shapes, both handled here:
 *
 *  - **Ask mode:** the reply is a `Markdown` record whose `data` is an escaped
 *    JSON document `{"text":"…","annotations":…}`.
 *  - **Agent mode** (e.g. PyCharm agent sessions): the reply is the `reply`
 *    field of an `AgentRound` record `{"roundId":N,"reply":"…","toolCalls":[…]}`.
 *    In agent mode the `Markdown` records hold the USER's prompts, not the
 *    reply, so we must NOT read them — the assistant output is the AgentRound
 *    reply.
 *
 * Both are read STRUCTURALLY rather than by fully unescaping the blob (which
 * would strip the reply's own quotes and make regex extraction ambiguous): we
 * locate each `data`/`reply` value, read it as a properly-delimited JSON-string
 * literal (honouring escaping), unescape one level, and `JSON.parse` to reach
 * the text. We unescape the blob one level at a time and extract at the first
 * depth that yields text, never accumulating across depths (which would union a
 * quote-truncated half-unescaped capture with the full one and garble the
 * reply, inflating the token/cost estimate).
 *
 * Steps/error/progress-only blobs (no Markdown text and no AgentRound reply)
 * yield '' and are billed as $0 upstream.
 */
function extractResponseText(blob: string): string {
  let s = blob
  for (let depth = 0; depth < 8; depth++) {
    // Decide the mode by the PRESENCE of an AgentRound record, not by whether it
    // yielded a reply. In agent mode the Markdown record holds the USER prompt,
    // so an agent blob whose reply is empty (a failed turn, or a pure tool-call
    // round) must NOT fall back to Markdown — that would bill the user's prompt
    // as the assistant's output. Ask-mode blobs have no AgentRound record and
    // use Markdown. (Verified across every observed store: the two reply shapes
    // never coexist in one blob, so this mode split is unambiguous.)
    const isAgentMode = /"type":"AgentRound"/.test(s)
    if (isAgentMode || /"type":"Markdown"/.test(s)) {
      const decoded = isAgentMode ? extractAgentRoundReplies(s) : extractMarkdownTexts(s)
      // The .db is read as latin1 (byte-stable), so multibyte UTF-8 characters
      // are split into separate code units. Re-interpret as UTF-8 so the char
      // count (→ token estimate) reflects real content length, not byte count.
      // decoded may be empty (failed/tool-only agent turn) → '' (billed $0).
      return Buffer.from(decoded.join('\n').trim(), 'latin1').toString('utf8')
    }
    // Not yet at the depth where record markers appear bare — unescape one level
    // in a single left-to-right pass so `\\` and `\"` resolve together (a
    // two-pass replace would turn `\\"` into `\"` not `\\` + `"`).
    const next = s.replace(/\\([\\"])/g, '$1')
    if (next === s) break
    s = next
  }
  return ''
}

/**
 * Collect the `text` of every `Markdown` record in `s`, treating each record's
 * `data` value as a one-level-escaped JSON string parsed structurally (so the
 * reply's own quotes never truncate it). Returns [] if `s` is not yet at the
 * right unescape depth (no bare `"type":"Markdown"` with a parseable `data`).
 * Scoping to Markdown skips `Error` (`message`) and `Steps` records — not
 * billable output. Revisions repeat a reply, so identical texts are de-duped.
 */
function extractMarkdownTexts(s: string): string[] {
  return extractRecordStrings(s, '"type":"Markdown"', '"data":"', 'text')
}

/**
 * Collect the non-empty `reply` of every `AgentRound` record (agent mode). A
 * single blob can hold several rounds (a multi-turn agent session); each round's
 * `reply` is the assistant's text for that step (empty on pure tool-call rounds).
 * Deduped in order.
 */
function extractAgentRoundReplies(s: string): string[] {
  return extractRecordStrings(s, '"type":"AgentRound"', '"data":"', 'reply')
}

/**
 * Shared structural reader: for every `<marker>` in `s`, find the following
 * `<dataKey>` string literal (a one-level-escaped JSON document), parse it, and
 * collect `doc[field]` when it is a non-empty string. Reading the value as a
 * delimited literal — not a greedy regex — means the payload's own quotes never
 * truncate it. Returns [] when `s` is not yet at the depth where the marker
 * appears bare with a parseable payload. De-dupes in order (the store keeps
 * byte-copies/revisions of each reply).
 */
function extractRecordStrings(s: string, marker: string, dataKey: string, field: string): string[] {
  const texts: string[] = []
  const seen = new Set<string>()
  const re = new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    const dk = s.indexOf(dataKey, m.index)
    if (dk === -1 || dk - m.index > 200) continue
    // The value runs from after `<dataKey>` to the first UNescaped quote (an odd
    // run of preceding backslashes escapes it).
    const start = dk + dataKey.length
    let i = start
    for (; i < s.length; i++) {
      if (s[i] !== '"') continue
      let bs = 0
      for (let j = i - 1; j >= start && s[j] === '\\'; j--) bs++
      if (bs % 2 === 0) break
    }
    const literal = s.slice(start, i)
    try {
      // Wrapping in quotes + parsing unescapes exactly one level → the inner
      // JSON document as a string; parsing THAT reaches { <field>, … }.
      const doc = JSON.parse(JSON.parse('"' + literal + '"') as string) as Record<string, unknown>
      const text = typeof doc[field] === 'string' ? (doc[field] as string) : ''
      if (text && !seen.has(text)) {
        seen.add(text)
        texts.push(text)
      }
    } catch {
      // Not the right depth (or not a matching record) — skip.
    }
  }
  return texts
}

/**
 * Extract assistant turns from a raw (latin1) Nitrite .db buffer. Each turn is
 * one `{"__first__":{"type":"Subgraph"…}` blob; the per-turn model is recovered
 * from inside the blob when present, else the whole-store default. Each turn is
 * grouped back to its owning conversation (chat tab) by the nearest preceding
 * conversation GUID. Duplicate byte-copies of the same reply (the store keeps
 * several) are de-duplicated by content, per conversation.
 */
function extractJetBrainsDbTurns(raw: string): JBDbTurn[] {
  const conversations = extractJetBrainsConversations(raw)
  // Precompute the byte offset of each conversation GUID's full form so a turn
  // can be attributed to the conversation whose id most recently precedes it.
  const convById = new Map(conversations.map(c => [c.id, c]))

  const turns: JBDbTurn[] = []
  const seenReplies = new Set<string>() // keyed by `${conversationId}::${reply}`
  const re = /\{"__first__":\{"type":"Subgraph"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    const { chunk, end } = matchJsonObject(raw, m.index)
    re.lastIndex = end

    // Attribute this turn to the conversation whose GUID last appears before it.
    let conversationId = ''
    let conversationTitle = ''
    let bestPos = -1
    for (const c of convById.values()) {
      const p = raw.lastIndexOf(c.id, m.index)
      if (p > bestPos) {
        bestPos = p
        conversationId = c.id
        conversationTitle = c.title
      }
    }

    const replyText = extractResponseText(chunk)
    // The files this turn referenced (home-relative common dir) → project label.
    const conversationProject = inferJetBrainsProject(chunk) ?? ''
    // A per-turn model token sometimes appears inside the blob.
    const model = findJetBrainsModelToken(chunk)
    // A failed turn carries an error status / phrase AND produces no reply text.
    // Requiring empty text avoids misclassifying a genuine reply that merely
    // *discusses* an error (e.g. explaining a stack trace) as a failed turn.
    const hasErrorMarker = /error occurred|"isError":true|\\+"status\\+":\\+"(?:error|failed)\\+"/i.test(chunk)
    if (hasErrorMarker && !replyText) {
      turns.push({ replyText: '', model, errored: true, conversationId, conversationTitle, conversationProject })
      continue
    }
    if (!replyText) continue // Steps/progress-only blob — no billable output
    const dedupeKey = `${conversationId}::${replyText}`
    if (seenReplies.has(dedupeKey)) continue
    seenReplies.add(dedupeKey)
    turns.push({ replyText, model, errored: false, conversationId, conversationTitle, conversationProject })
  }

  // ---------------------------------------------------------------------------
  // Fallback: old JetBrains Copilot plugin format (≤1.5.x, e.g. 1.5.59-243)
  // ---------------------------------------------------------------------------
  // In this format ALL session turns are stored inside ONE large outer Nitrite
  // document — a binary-framed JSON object with UUID-keyed Value entries — rather
  // than the per-turn {"__first__":{"type":"Subgraph",...}} blobs used by newer
  // plugins (≥1.12.x). The AgentRound entries sit one escaping level deeper
  // inside the outer document's string values, so `extractResponseText`'s
  // depth-unescape loop handles extraction correctly once we feed it the right
  // chunk. MVStore keeps two identical copies of the collection; `seenReplies`
  // deduplicates them automatically.
  //
  // Detection heuristic: the __first__/Subgraph path produced no turns AND the
  // raw file contains bare 'AgentRound' text (meaning old-format data is present).
  if (turns.length === 0 && raw.includes('AgentRound')) {
    // The outer Nitrite document is preceded by a single binary framing byte
    // (0x81 in practice, but any non-printable/non-ASCII byte in MVStore).
    // It starts with a UUID-keyed Value entry: {"<uuid>":{"type":"Value",...}}.
    // Hex is matched case-insensitively — an uppercase UUID must not cause the
    // whole session to fall through to $0 (the exact bug this path fixes).
    const outerDocRe =
      /[\x00-\x1f\x7f-\xff]\{"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}":\{"type":"Value"/g
    let dm: RegExpExecArray | null
    while ((dm = outerDocRe.exec(raw))) {
      // Skip the leading binary byte; matchJsonObject starts at the '{'.
      const docStart = dm.index + 1
      const { chunk, end } = matchJsonObject(raw, docStart)
      outerDocRe.lastIndex = end

      // Skip documents that contain no AgentRound data (e.g. empty sessions).
      if (!chunk.includes('AgentRound')) continue

      // Attribute to the conversation whose GUID most recently precedes this doc.
      let conversationId = ''
      let conversationTitle = ''
      let bestPos = -1
      for (const c of convById.values()) {
        const p = raw.lastIndexOf(c.id, docStart)
        if (p > bestPos) {
          bestPos = p
          conversationId = c.id
          conversationTitle = c.title
        }
      }

      // extractResponseText handles the depth-1 unescape needed to surface the
      // AgentRound records, then calls extractAgentRoundReplies for each turn.
      // Because the outer document holds ALL turns in one blob we get back a
      // single joined string; split it on the '\n' join to yield per-turn texts.
      const allReplies = extractResponseText(chunk)
      if (!allReplies) continue

      const conversationProject = inferJetBrainsProject(chunk) ?? ''
      const storeModel = findJetBrainsModelToken(chunk)

      // extractResponseText joins multiple replies with '\n'. Since individual
      // replies can themselves span multiple lines we cannot cleanly split here —
      // instead we emit one ParsedProviderCall per outer document (one session).
      const dedupeKey = `${conversationId}::${allReplies}`
      if (seenReplies.has(dedupeKey)) continue
      seenReplies.add(dedupeKey)

      turns.push({
        replyText: allReplies,
        model: storeModel,
        errored: false,
        conversationId,
        conversationTitle,
        conversationProject,
      })
    }
  }

  // A project derived from ANY turn of a conversation applies to all its turns
  // (the files are usually referenced in the first substantive turn only).
  const projByConv = new Map<string, string>()
  for (const t of turns) {
    if (t.conversationProject && !projByConv.has(t.conversationId)) {
      projByConv.set(t.conversationId, t.conversationProject)
    }
  }
  for (const t of turns) {
    if (!t.conversationProject) t.conversationProject = projByConv.get(t.conversationId) ?? ''
  }

  return turns
}

// ---------------------------------------------------------------------------
// JetBrains parser: one ParsedProviderCall per assistant turn in the .db
// ---------------------------------------------------------------------------

function createJetBrainsParser(
  source: JetBrainsSessionSource,
  seenKeys: Set<string>,
  context: CopilotParserContext,
): SessionParser {
  const parseStream: NonNullable<SessionParser['parseStream']> = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* checkScanAbort(context.signal)
        if (!source.dbPath) return Stream.empty
        const read = yield* Effect.result(readSessionFileEffect(source.dbPath, 'latin1', { signal: context.signal }))
        if (Result.isFailure(read)) {
          if (isScanAbortedError(read.failure)) return yield* Effect.fail(read.failure)
          return Stream.empty
        }
        const dbRaw = read.success
        if (!dbRaw) return Stream.empty

        const sessionId = source.sessionId
        const storeModel = inferJetBrainsModel(dbRaw)
        const turns = extractJetBrainsDbTurns(dbRaw)
        const perContentIndex = new Map<string, number>()
        return Stream.fromIterable(turns).pipe(
          Stream.mapEffect(turn =>
            Effect.gen(function* () {
              yield* checkScanAbort(context.signal)
              const convId = turn.conversationId || sessionId
              const contentHash = createHash('sha256').update(turn.replyText).digest('hex').slice(0, 12)
              const contentKey = `${convId}:${contentHash}`
              const nth = (perContentIndex.get(contentKey) ?? 0) + 1
              perContentIndex.set(contentKey, nth)
              const dedupKey = `copilot:jb:${convId}:${contentHash}:${nth}`
              if (seenKeys.has(dedupKey)) return Result.fail(undefined)
              seenKeys.add(dedupKey)

              const model = turn.model || storeModel || 'copilot-anthropic-auto'
              const outputTokens = turn.errored ? 0 : estimateTokens(turn.replyText)
              const costUSD = outputTokens > 0 ? context.pricing.calculateCost(model, 0, outputTokens, 0, 0, 0) : 0
              const project = source.projectName || turn.conversationProject || 'copilot-jetbrains'
              return Result.succeed({
                provider: 'copilot' as const,
                sessionId: convId,
                project,
                model,
                inputTokens: 0,
                outputTokens,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: 0,
                cachedInputTokens: 0,
                reasoningTokens: 0,
                webSearchRequests: 0,
                costUSD,
                costIsEstimated: true,
                tools: [],
                bashCommands: [],
                timestamp: source.mtime,
                speed: 'standard' as const,
                deduplicationKey: dedupKey,
                userMessage: turn.conversationTitle,
              })
            }),
          ),
          Stream.filterMap(result => result),
        )
      }),
    )

  return copilotParser(parseStream)
}

// ---------------------------------------------------------------------------
// OTel SQLite parser — reads agent-traces.db for FULL token data
// ---------------------------------------------------------------------------

function createOtelParser(source: SessionSource, seenKeys: Set<string>, context: CopilotParserContext): SessionParser {
  const malformed = (onUnparsedCall?: Effect.Effect<void>) => onUnparsedCall ?? Effect.void
  const reportInvalid = (onUnparsedCall?: Effect.Effect<void>) =>
    Effect.as(malformed(onUnparsedCall), Result.fail(undefined))
  const query = <A extends Record<string, unknown>>(db: SqliteDatabase, sql: string, params?: unknown[]) =>
    Effect.try({ try: () => db.query<A>(sql, params), catch: cause => copilotDatabaseError('read', cause) })

  const parseStream: NonNullable<SessionParser['parseStream']> = onUnparsedCall =>
    Stream.scoped(
      Stream.unwrap(
        Effect.gen(function* () {
          yield* checkScanAbort(context.signal)
          const owned = yield* Effect.acquireRelease(openCopilotDatabase(source.path), db =>
            closeCopilotDatabase(db).pipe(Effect.orDie),
          )
          const db = owned.db
          const conversationRows = yield* query(
            db,
            `SELECT DISTINCT
        CASE WHEN typeof(sa_conv.value) = 'text' THEN CAST(sa_conv.value AS BLOB) ELSE NULL END AS conversation_id,
        typeof(sa_conv.value) AS conversation_id_type,
        CASE
          WHEN sa_repo.value IS NULL THEN CAST('copilot-chat' AS BLOB)
          WHEN typeof(sa_repo.value) = 'text' THEN CAST(sa_repo.value AS BLOB)
          ELSE NULL
        END AS project,
        CASE WHEN sa_repo.value IS NULL THEN 'text' ELSE typeof(sa_repo.value) END AS project_type,
        MIN(s.start_time_ms) AS min_start
      FROM spans s
      LEFT JOIN span_attributes sa_conv
        ON s.span_id = sa_conv.span_id AND sa_conv.key = 'gen_ai.conversation.id'
      LEFT JOIN span_attributes sa_repo
        ON s.span_id = sa_repo.span_id AND sa_repo.key = 'github.copilot.git.repository'
      WHERE sa_conv.value IS NOT NULL
      GROUP BY sa_conv.value
      ORDER BY min_start DESC`,
          )

          const conversations = Stream.fromIterable(conversationRows).pipe(
            Stream.flatMap(candidate => {
              const decoded = decodeOtelConversationRow(candidate)
              if (Result.isFailure(decoded)) return Stream.fromEffect(reportInvalid(onUnparsedCall)).pipe(Stream.drain)
              const convRow = decoded.success
              const conversationId = blobToText(convRow.conversation_id)
              let project = blobToText(convRow.project)
              if (project.includes('/')) project = basename(project.replace(/\.git$/, ''))

              const conversationCalls = Effect.gen(function* () {
                yield* checkScanAbort(context.signal)
                const rawSpanIds = yield* query(
                  db,
                  `SELECT DISTINCT
              CASE WHEN typeof(s.span_id) = 'text' THEN CAST(s.span_id AS BLOB) ELSE NULL END AS span_id,
              typeof(s.span_id) AS span_id_type,
              CASE WHEN typeof(s.trace_id) = 'text' THEN CAST(s.trace_id AS BLOB) ELSE NULL END AS trace_id,
              typeof(s.trace_id) AS trace_id_type
              FROM spans s
              INNER JOIN span_attributes sa
                ON s.span_id = sa.span_id AND sa.key = 'gen_ai.conversation.id' AND sa.value = ?
              ORDER BY s.start_time_ms ASC`,
                  [conversationId],
                )
                const spanIds: Array<{ span_id: string; trace_id: string }> = []
                for (const raw of rawSpanIds) {
                  const parsed = decodeOtelSpanIdRow(raw)
                  if (Result.isSuccess(parsed)) {
                    spanIds.push({
                      span_id: blobToText(parsed.success.span_id),
                      trace_id: blobToText(parsed.success.trace_id),
                    })
                  } else if (onUnparsedCall) yield* onUnparsedCall
                }
                const traceIds = [...new Set(spanIds.map(row => row.trace_id))]
                if (traceIds.length === 0) return Stream.empty
                const placeholders = traceIds.map(() => '?').join(',')
                const rawSpans = yield* query(
                  db,
                  `SELECT
               CASE WHEN typeof(span_id) = 'text' THEN CAST(span_id AS BLOB) ELSE NULL END AS span_id,
               typeof(span_id) AS span_id_type,
               CASE WHEN typeof(trace_id) = 'text' THEN CAST(trace_id AS BLOB) ELSE NULL END AS trace_id,
               typeof(trace_id) AS trace_id_type,
               CASE WHEN typeof(operation_name) = 'text' THEN CAST(operation_name AS BLOB) ELSE NULL END AS operation_name,
               typeof(operation_name) AS operation_name_type,
               start_time_ms,
               CASE WHEN typeof(response_model) = 'text' THEN CAST(response_model AS BLOB) ELSE NULL END AS response_model,
               typeof(response_model) AS response_model_type
               FROM spans WHERE trace_id IN (${placeholders})`,
                  traceIds,
                )
                const spans: Array<{
                  span_id: string
                  trace_id: string
                  operation_name: string | null
                  start_time_ms: number
                  response_model: string | null
                }> = []
                for (const raw of rawSpans) {
                  const parsed = decodeOtelTraceSpanRow(raw)
                  if (Result.isSuccess(parsed)) {
                    spans.push({
                      span_id: blobToText(parsed.success.span_id),
                      trace_id: blobToText(parsed.success.trace_id),
                      operation_name: blobToText(parsed.success.operation_name),
                      start_time_ms: parsed.success.start_time_ms,
                      response_model: blobToText(parsed.success.response_model),
                    })
                  } else if (onUnparsedCall) yield* onUnparsedCall
                }
                const toolSpans = spans.filter(
                  span => span.operation_name === 'execute_tool' || span.operation_name === 'invoke_agent',
                )
                const toolMetadata = yield* Stream.fromIterable(toolSpans).pipe(
                  Stream.mapEffect(span =>
                    loadSpanAttributesFromTable(db, span.span_id, context.signal, onUnparsedCall),
                  ),
                  Stream.runCollect,
                )
                const toolsByTrace = new Map<string, string[]>()
                const bashByTrace = new Map<string, string[]>()
                const subagentsByTrace = new Map<string, string[]>()
                for (const [index, span] of toolSpans.entries()) {
                  const attrs = toolMetadata[index]
                  if (!attrs) continue
                  if (span.operation_name === 'execute_tool') {
                    const rawToolName = attrs['gen_ai.tool.name'] as string | undefined
                    if (!rawToolName) continue
                    const tools = toolsByTrace.get(span.trace_id) ?? []
                    tools.push(normalizeTool(rawToolName))
                    toolsByTrace.set(span.trace_id, tools)
                    if (BASH_TOOL_NAMES.has(rawToolName)) {
                      const command = parseToolCommand(attrs['gen_ai.tool.call.arguments'])
                      if (command) {
                        const bash = bashByTrace.get(span.trace_id) ?? []
                        bash.push(...extractOtelBashCommands(command))
                        bashByTrace.set(span.trace_id, bash)
                      }
                    }
                  } else {
                    const parentSession = attrs['copilot_chat.parent_chat_session_id']
                    const agentName = attrs['gen_ai.agent.name'] as string | undefined
                    if (parentSession && agentName) {
                      const subs = subagentsByTrace.get(span.trace_id) ?? []
                      subs.push(agentName)
                      subagentsByTrace.set(span.trace_id, subs)
                    }
                  }
                }
                const chatSpans = spans.filter(span => span.operation_name === 'chat')
                return Stream.fromIterable(chatSpans).pipe(
                  Stream.mapEffect(span =>
                    Effect.gen(function* () {
                      yield* checkScanAbort(context.signal)
                      const attrs = yield* loadSpanAttributesFromTable(db, span.span_id, context.signal, onUnparsedCall)
                      const rawModel =
                        (attrs['gen_ai.response.model'] as string | undefined) ??
                        (attrs['gen_ai.request.model'] as string | undefined) ??
                        span.response_model ??
                        'unknown'
                      const inputTokens = Number(attrs['gen_ai.usage.input_tokens'] ?? 0)
                      const outputTokens = Number(attrs['gen_ai.usage.output_tokens'] ?? 0)
                      const cacheReadTokens = Number(attrs['gen_ai.usage.cache_read.input_tokens'] ?? 0)
                      const cacheCreationTokens = Number(attrs['gen_ai.usage.cache_creation.input_tokens'] ?? 0)
                      if (inputTokens === 0 && outputTokens === 0) return Result.fail(undefined)
                      const dedupKey = `copilot-otel:${span.span_id}`
                      if (seenKeys.has(dedupKey)) return Result.fail(undefined)
                      seenKeys.add(dedupKey)
                      const turnId = attrs['github.copilot.chat.turn.id'] as string | undefined
                      if (turnId) seenKeys.add(`copilot:${conversationId}:${turnId}`)
                      // An absent or blank model keeps the established `unknown`
                      // pricing fallback. A selected attribute with a non-string
                      // value is malformed: retain seen admission, tally it, then
                      // omit it before pricing instead of charging it as unknown.
                      if (typeof rawModel !== 'string') {
                        if (onUnparsedCall) yield* onUnparsedCall
                        return Result.fail(undefined)
                      }
                      const model = rawModel.trim() ? rawModel : 'unknown'
                      const usageResult = decodeOtelCallUsage({
                        model,
                        inputTokens,
                        outputTokens,
                        cacheReadTokens,
                        cacheCreationTokens,
                      })
                      if (Result.isFailure(usageResult)) {
                        if (onUnparsedCall) yield* onUnparsedCall
                        return Result.fail(undefined)
                      }
                      const usage = usageResult.success
                      const costUSD = yield* Effect.try({
                        try: () =>
                          context.pricing.calculateCost(
                            usage.model,
                            usage.inputTokens,
                            usage.outputTokens,
                            usage.cacheCreationTokens,
                            usage.cacheReadTokens,
                            0,
                          ),
                        catch: cause => (cause instanceof Error ? cause : new Error(String(cause), { cause })),
                      })
                      return Result.succeed({
                        provider: 'copilot' as const,
                        sessionId: conversationId,
                        project,
                        model: usage.model,
                        inputTokens: usage.inputTokens,
                        outputTokens: usage.outputTokens,
                        cacheCreationInputTokens: usage.cacheCreationTokens,
                        cacheReadInputTokens: usage.cacheReadTokens,
                        cachedInputTokens: 0,
                        reasoningTokens: 0,
                        webSearchRequests: 0,
                        costUSD,
                        tools: toolsByTrace.get(span.trace_id) ?? [],
                        bashCommands: bashByTrace.get(span.trace_id) ?? [],
                        subagentTypes: subagentsByTrace.get(span.trace_id)?.length
                          ? subagentsByTrace.get(span.trace_id)
                          : undefined,
                        timestamp: epochToISO(span.start_time_ms),
                        speed: 'standard' as const,
                        deduplicationKey: dedupKey,
                        userMessage: '',
                      })
                    }),
                  ),
                  Stream.filterMap(value => value),
                )
              })
              return Stream.unwrap(conversationCalls)
            }),
          )
          const finish = Effect.gen(function* () {
            yield* checkScanAbort(context.signal)
            yield* closeCopilotDatabase(owned)
          })
          return Stream.concat(conversations, Stream.fromEffectDrain(finish))
        }),
      ),
    )
  return copilotParser(parseStream)
}

// ---------------------------------------------------------------------------
// Extended SessionSource for OTel sessions
// ---------------------------------------------------------------------------

interface OTelSessionSource extends SessionSource {
  conversationId?: string
  sourceType: 'otel'
}

interface JsonlSessionSource extends SessionSource {
  sourceType: 'jsonl'
  // Which of the two on-disk JSONL layouts this is, decided at DISCOVERY from
  // where the file was found - never from its contents. The Copilot CLI writes
  // `session-state/<sessionId>/events.jsonl`; a VS Code transcript is
  // `.../transcripts/<sessionId>.jsonl`. Both carry the SAME
  // `session.start.producer` of `copilot-agent`, so sniffing the producer
  // calls every CLI session a transcript - and a transcript is exactly the
  // shape that must NOT be trusted for the `session.shutdown` input/cache
  // rollup. The consequence is silent and total: a CLI session contributes its
  // per-turn output and nothing else, so all of its input and cache tokens go
  // unrecorded.
  sessionKind: 'cli' | 'transcript'
}

interface ChatSessionSource extends SessionSource {
  sourceType: 'chatsession'
}

interface JetBrainsSessionSource extends SessionSource {
  sourceType: 'jetbrains'
  // Fallback conversation id for turns whose own GUID can't be recovered (the
  // on-disk store dir name). Normally each turn is grouped by its own tab GUID.
  sessionId: string
  // On-disk store directory name — the join key for the projectName lookup
  // across sibling kind dirs (chat-sessions / chat-edit-sessions).
  storeId: string
  // Nitrite .db (copilot-*-nitrite.db) — the store's session content.
  dbPath: string
  // File mtime (ISO). The store has no reliable per-turn timestamp, so this
  // places every turn on a day — without it, calls fall outside date ranges.
  mtime: string
  // Plugin-recorded project label (JetBrains Copilot 1.12+), resolved across
  // all kind dirs by store id. The billable turns live in chat-agent-sessions,
  // but the projectName field is usually written only into the sibling
  // chat-sessions / chat-edit-sessions store, so discovery joins them by id.
  // Undefined for older plugins that don't record it.
  projectName?: string
}

/**
 * What the store has described for one `${sessionId}\n${model}` pair, summed
 * over its rows. The rollup parser subtracts this from a `session.shutdown`
 * rollup, which is how a residual (rows pruned, or a crash that skipped the
 * write) reaches the ledger without ever counting a token twice.
 *
 * `inputTokens` is the UNCACHED remainder the rows were emitted with, and
 * `outputTokens` the RAW per-request output the CLI wrote — the value a rollup
 * carries on years when the journal's own messages record none.
 */
type StoreRowUsage = {
  // The row's own id and content hash, so the journal can mint a stable key for
  // the output it hands over instead of inventing a position.
  rowId: string
  contentHash: string
  timestamp: string
  // +Infinity when the row has no usable stamp: an interval subtraction then
  // treats it as covering everything, which can only under-report.
  timestampMs: number
  // The UNCACHED remainder the row was emitted with.
  inputTokens: number
  // What the row actually SERVED — 0 for a session with a local journal, whose
  // per-turn call owns it.
  outputTokens: number
  // What the CLI wrote, kept so the journal can serve it when nothing else does.
  rawOutputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  isCompaction: boolean
  outputServedByAlias: boolean
}

interface SessionStoreSource extends SessionSource {
  sourceType: 'sessionstore'
  // File mtime (ISO). A row whose `created_at` is missing or unparseable falls
  // back to this so the row still lands inside a date range instead of being
  // silently filtered out (the same fallback the JetBrains parser uses).
  mtime: string
}

function isOtelSource(source: SessionSource): source is OTelSessionSource {
  return (source as OTelSessionSource).sourceType === 'otel'
}

function isChatSessionSource(source: SessionSource): source is ChatSessionSource {
  return (source as ChatSessionSource).sourceType === 'chatsession'
}

function isJetBrainsSource(source: SessionSource): source is JetBrainsSessionSource {
  return (source as JetBrainsSessionSource).sourceType === 'jetbrains'
}

function isSessionStoreSource(source: SessionSource): source is SessionStoreSource {
  return (source as SessionStoreSource).sourceType === 'sessionstore'
}

// ---------------------------------------------------------------------------
// Session discovery: JSONL (original)
// ---------------------------------------------------------------------------

class ProviderOperationError extends Schema.TaggedError<ProviderOperationError>()('ProviderOperationError', {
  provider: Schema.Literal('copilot'),
  operation: Schema.Literals(['read', 'readdir', 'stat']),
  path: Schema.String,
  cause: Schema.Defect(),
  message: Schema.String,
}) {}

function discoveryError(
  operation: ProviderOperationError['operation'],
  path: string,
  cause: unknown,
): ProviderOperationError {
  const error = cause instanceof Error ? cause : new Error(String(cause), { cause })
  return new ProviderOperationError({ provider: 'copilot', operation, path, cause: error, message: error.message })
}

function readDirectoryEffect(path: string, signal?: AbortSignal): Effect.Effect<string[], Error> {
  return scanIo(() => readdir(path), signal).pipe(
    Effect.mapError(cause => (isScanAbortedError(cause) ? cause : discoveryError('readdir', path, cause))),
  )
}

function statEffect(path: string, signal?: AbortSignal): Effect.Effect<Awaited<ReturnType<typeof stat>>, Error> {
  return scanIo(() => stat(path), signal).pipe(
    Effect.mapError(cause => (isScanAbortedError(cause) ? cause : discoveryError('stat', path, cause))),
  )
}

function readTextEffect(
  path: string,
  encoding: BufferEncoding,
  signal?: AbortSignal,
): Effect.Effect<string | null, Error> {
  return readSessionFileEffect(path, encoding, { signal })
}

const findExistingFile = Effect.fnUntraced(function* (
  candidates: readonly string[],
  signal?: AbortSignal,
): Effect.fn.Return<string | null, Error> {
  for (const candidate of candidates) {
    yield* checkScanAbort(signal)
    const fileInfo = yield* optionalDiscovery(statEffect(candidate, signal), null)
    if (fileInfo?.isFile()) return candidate
  }
  return null
})

function optionalDiscovery<A>(effect: Effect.Effect<A, Error>, fallback: A): Effect.Effect<A, Error> {
  return effect.pipe(Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(fallback))))
}

const workspaceJsonSchema = Schema.fromJsonString(Schema.Struct({ folder: Schema.optional(Schema.String) }))
const decodeWorkspaceJson = Schema.decodeUnknownResult(workspaceJsonSchema)

const discoverJsonlSessions = Effect.fnUntraced(function* (
  sessionStateDir: string,
  localSessionIds: Set<string>,
  context?: ProviderScanContext,
): Effect.fn.Return<JsonlSessionSource[], Error> {
  const signal = context?.signal
  const sources: JsonlSessionSource[] = []
  const sessionDirs = yield* optionalDiscovery(readDirectoryEffect(sessionStateDir, signal), [])

  for (const sessionId of sessionDirs) {
    yield* checkScanAbort(signal)
    const eventsPath = join(sessionStateDir, sessionId, 'events.jsonl')
    const fileInfo = yield* optionalDiscovery(statEffect(eventsPath, signal), null)
    if (!fileInfo?.isFile()) continue
    // A local per-turn journal exists, so its `assistant.message` events own the
    // session's output — see the OUTPUT OWNERSHIP block in the store parser.
    localSessionIds.add(sessionId)

    let project = sessionId
    let workingDirectory: string | undefined
    const yaml = yield* readTextEffect(join(sessionStateDir, sessionId, 'workspace.yaml'), 'utf8', signal)
    const cwd = parseCwd(yaml ?? '')
    if (cwd) {
      project = basename(cwd)
      workingDirectory = cwd
    }
    sources.push({
      path: eventsPath,
      project,
      provider: 'copilot',
      sourceType: 'jsonl',
      sessionKind: 'cli',
      ...(workingDirectory ? { workingDirectory } : {}),
    })
  }
  return sources
})

// ---------------------------------------------------------------------------
// Session discovery: OTel SQLite
// ---------------------------------------------------------------------------

const discoverOtelSessions = Effect.fnUntraced(function* (
  dbPath: string,
  context?: ProviderScanContext,
): Effect.fn.Return<OTelSessionSource[], Error> {
  // Verify the DB file exists. Return one source per DB file; the parser
  // opens the DB once and iterates all conversations in a single DB open,
  // which is far more efficient than one source (and one DB open) per conversation.
  yield* checkScanAbort(context?.signal)
  const dbInfo = yield* optionalDiscovery(statEffect(dbPath, context?.signal), null)
  if (!dbInfo?.isFile()) return []
  return [{ path: dbPath, project: 'copilot-chat', provider: 'copilot', sourceType: 'otel' }]
})

// ---------------------------------------------------------------------------
// Session discovery: Copilot CLI session-store.db
// ---------------------------------------------------------------------------

/**
 * Discover the CLI's `session-store.db` as ONE source.
 *
 * One file spans every project and every session, so a source per session (as
 * the OTel path could afford, since it queries per conversation) would mean N
 * opens of the same database for no gain. One source, one open, one pass over
 * `assistant_usage_events`.
 *
 * The project label here is a PLACEHOLDER — real attribution comes from each
 * row's `sessions.cwd` / `sessions.repository`, which is the only place the
 * store records it. The placeholder only applies to a row whose session has
 * neither.
 */
const discoverSessionStoreSessions = Effect.fnUntraced(function* (
  dbPath: string,
  context?: ProviderScanContext,
): Effect.fn.Return<SessionStoreSource[], Error> {
  yield* checkScanAbort(context?.signal)
  const dbInfo = yield* optionalDiscovery(statEffect(dbPath, context?.signal), null)
  if (!dbInfo?.isFile()) return []
  return [
    {
      path: dbPath,
      project: 'copilot-cli',
      provider: 'copilot',
      sourceType: 'sessionstore',
      mtime: dbInfo.mtime.toISOString(),
    },
  ]
})

// ---------------------------------------------------------------------------
// Session discovery: JetBrains (IntelliJ IDEA, PyCharm, …)
// ---------------------------------------------------------------------------

// The three JetBrains Copilot session kinds (agent / ask / edit mode). Each
// store directory holds a Nitrite .db with that kind's session content.
const JETBRAINS_SESSION_KINDS = ['chat-agent-sessions', 'chat-sessions', 'chat-edit-sessions']

// Candidate Nitrite .db filenames per kind, plus a generic fallback.
const JETBRAINS_DB_NAMES: Record<string, string> = {
  'chat-agent-sessions': 'copilot-agent-sessions-nitrite.db',
  'chat-sessions': 'copilot-chat-nitrite.db',
  'chat-edit-sessions': 'copilot-edit-sessions-nitrite.db',
}

/** Locate the Nitrite .db in a store dir (known name, else any *-nitrite.db). */
const findNitriteDbPath = Effect.fnUntraced(function* (
  storeDir: string,
  kind: string,
  context?: ProviderScanContext,
): Effect.fn.Return<string | null, Error> {
  const signal = context?.signal
  const known = JETBRAINS_DB_NAMES[kind]
  if (known) {
    const p = join(storeDir, known)
    const fileStat = yield* optionalDiscovery(statEffect(p, signal), null)
    if (fileStat?.isFile()) return p
  }
  const files = yield* optionalDiscovery(readDirectoryEffect(storeDir, signal), [])
  const db = files.find(f => f.endsWith('-nitrite.db'))
  return db ? join(storeDir, db) : null
})

/**
 * Discover JetBrains Copilot sessions under the github-copilot config root.
 *
 * Layout: <root>/<ide>/<kind>/<storeId>/copilot-*-nitrite.db
 *   <ide>  — per-IDE dir (iu, intellij, PyCharm2025.2, …)
 *   <kind> — one of JETBRAINS_SESSION_KINDS
 *
 * Emits one source per store directory that has a Nitrite .db. The store
 * records no token counts, so the parser estimates output tokens from the
 * assistant reply text (see createJetBrainsParser).
 */
const discoverJetBrainsSessions = Effect.fnUntraced(function* (
  root: string,
  context?: ProviderScanContext,
): Effect.fn.Return<JetBrainsSessionSource[], Error> {
  const signal = context?.signal
  const sources: JetBrainsSessionSource[] = []
  const ideDirs = yield* optionalDiscovery(readDirectoryEffect(root, signal), [])

  for (const ide of ideDirs) {
    yield* checkScanAbort(signal)
    for (const kind of JETBRAINS_SESSION_KINDS) {
      const kindDir = join(root, ide, kind)
      const storeDirs = yield* optionalDiscovery(readDirectoryEffect(kindDir, signal), [])

      for (const storeId of storeDirs) {
        yield* checkScanAbort(signal)
        const storeDir = join(kindDir, storeId)
        const dbPath = yield* findNitriteDbPath(storeDir, kind, context)
        if (!dbPath) continue

        const dbStat = yield* optionalDiscovery(statEffect(dbPath, signal), null)
        const mtime = (dbStat?.mtime ?? new Date(0)).toISOString()

        sources.push({
          path: dbPath,
          project: 'copilot-jetbrains',
          provider: 'copilot',
          sourceType: 'jetbrains',
          sessionId: storeId,
          storeId,
          dbPath,
          mtime,
        })
      }
    }
  }

  // Join projectName across kinds by store id. The plugin records the label on
  // the session doc, which usually lands in the chat-sessions/chat-edit-sessions
  // store — NOT the chat-agent-sessions store where the billable turns live.
  // Without this join, every current agent session falls to the generic bucket
  // even though its repo name is sitting one store dir over.
  yield* resolveJetBrainsProjectNames(sources, context)

  return sources
})

/**
 * Populate each source's `projectName` from whichever store dir (of the same
 * store id) actually recorded it. Reads each source's .db once; a store whose
 * own .db lacks the field inherits it from a sibling-kind store with the same
 * id. Best-effort — read/parse failures leave projectName undefined.
 */
const resolveJetBrainsProjectNames = Effect.fnUntraced(function* (
  sources: JetBrainsSessionSource[],
  context?: ProviderScanContext,
): Effect.fn.Return<void, Error> {
  const signal = context?.signal
  const byStore = new Map<string, string>()
  for (const src of sources) {
    yield* checkScanAbort(signal)
    // Already found this store's name via a sibling-kind source — skip the read.
    if (!src.dbPath || byStore.has(src.storeId)) continue
    const raw = yield* readTextEffect(src.dbPath, 'latin1', signal)
    if (!raw) continue
    const name = extractJetBrainsProjectName(raw)
    if (name) byStore.set(src.storeId, name)
  }
  for (const src of sources) {
    yield* checkScanAbort(signal)
    const name = byStore.get(src.storeId)
    if (name) src.projectName = name
  }
})

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

/**
 * Returns the VS Code workspaceStorage directories for all VS Code variants
 * (Code, Code Insiders, VSCodium) on the given platform. Used to discover
 * transcript sessions written by the Copilot Chat extension.
 *
 * Accepts explicit `home` and `os` arguments so callers (and tests) can pass
 * custom values without relying on process-level globals.
 */
export function getVSCodeWorkspaceStorageDirs(home: string, os: string): string[] {
  const j = os === 'win32' ? win32.join : posix.join
  if (os === 'darwin') {
    return [
      j(home, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'),
      j(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'workspaceStorage'),
      j(home, 'Library', 'Application Support', 'VSCodium', 'User', 'workspaceStorage'),
    ]
  }
  if (os === 'linux') {
    return [
      j(home, '.config', 'Code', 'User', 'workspaceStorage'),
      j(home, '.config', 'Code - Insiders', 'User', 'workspaceStorage'),
      j(home, '.config', 'VSCodium', 'User', 'workspaceStorage'),
    ]
  }
  // win32
  return [
    j(home, 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage'),
    j(home, 'AppData', 'Roaming', 'Code - Insiders', 'User', 'workspaceStorage'),
    j(home, 'AppData', 'Roaming', 'VSCodium', 'User', 'workspaceStorage'),
  ]
}

export function getVSCodeGlobalStorageDirs(home: string, os: string): string[] {
  const j = os === 'win32' ? win32.join : posix.join
  if (os === 'darwin') {
    return [
      j(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage'),
      j(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'globalStorage'),
      j(home, 'Library', 'Application Support', 'VSCodium', 'User', 'globalStorage'),
    ]
  }
  if (os === 'linux') {
    return [
      j(home, '.config', 'Code', 'User', 'globalStorage'),
      j(home, '.config', 'Code - Insiders', 'User', 'globalStorage'),
      j(home, '.config', 'VSCodium', 'User', 'globalStorage'),
    ]
  }
  return [
    j(home, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage'),
    j(home, 'AppData', 'Roaming', 'Code - Insiders', 'User', 'globalStorage'),
    j(home, 'AppData', 'Roaming', 'VSCodium', 'User', 'globalStorage'),
  ]
}

/// Decode a VS Code workspace folder URI to a host-local checkout path.
/// Only `file://` URIs map to a real directory; remote flavours
/// (vscode-remote, ssh, wsl) have no host-local path and yield undefined so
/// those sessions keep flowing to the orphan bucket instead of inventing an
/// identity. Mirrors cursor.ts `workspaceFsPath` (kept local to avoid a
/// cross-provider import).
function copilotWorkspaceFsPath(uri: string): string | undefined {
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

const resolveWorkspaceProject = Effect.fnUntraced(function* (
  wsDir: string,
  hashDir: string,
  context?: ProviderScanContext,
): Effect.fn.Return<{ project: string; workingDirectory?: string }, Error> {
  const signal = context?.signal
  let project = hashDir
  let workingDirectory: string | undefined
  const wsJson = yield* readTextEffect(join(wsDir, hashDir, 'workspace.json'), 'utf8', signal)
  if (wsJson) {
    const decoded = decodeWorkspaceJson(wsJson)
    if (Result.isSuccess(decoded) && decoded.success.folder !== undefined) {
      // folder is a URI like 'file:///home/user/myapp' or 'file:///C:/Users/...'
      const fsPath = copilotWorkspaceFsPath(decoded.success.folder)
      if (fsPath) {
        const clean = fsPath.replace(/\/+$/, '')
        const name = basename(clean)
        if (name) project = name
        if (clean) workingDirectory = clean
      } else {
        // Remote URI (vscode-remote, wsl): keep a useful grouping label.
        const name = basename(decoded.success.folder.replace(/\/+$/, ''))
        if (name) project = name
      }
    }
  }
  return workingDirectory ? { project, workingDirectory } : { project }
})

/**
 * A VS Code core chat session on disk: the current delta journal (`.jsonl`) or
 * the pre-1.109 flat document (`.json`).
 */
function isChatSessionFile(file: string): boolean {
  return file.endsWith('.jsonl') || file.endsWith('.json')
}

const hasChatSessionFiles = Effect.fnUntraced(function* (
  chatSessionsDir: string,
  context?: ProviderScanContext,
): Effect.fn.Return<boolean, Error> {
  const signal = context?.signal
  const files = yield* optionalDiscovery(readDirectoryEffect(chatSessionsDir, signal), [])

  for (const file of files) {
    yield* checkScanAbort(signal)
    if (!isChatSessionFile(file)) continue
    const s = yield* optionalDiscovery(statEffect(join(chatSessionsDir, file), signal), null)
    if (s?.isFile()) return true
  }
  return false
})

// ---------------------------------------------------------------------------
// Session discovery: VS Code core chatSessions
// ---------------------------------------------------------------------------

const discoverWorkspaceChatSessions = Effect.fnUntraced(function* (
  workspaceStorageDirs: string[],
  context?: ProviderScanContext,
): Effect.fn.Return<ChatSessionSource[], Error> {
  const signal = context?.signal
  const sources: ChatSessionSource[] = []

  for (const wsDir of workspaceStorageDirs) {
    yield* checkScanAbort(signal)
    const hashDirs = yield* optionalDiscovery(readDirectoryEffect(wsDir, signal), [])

    for (const hashDir of hashDirs) {
      yield* checkScanAbort(signal)
      const chatSessionsDir = join(wsDir, hashDir, 'chatSessions')
      const files = yield* optionalDiscovery(readDirectoryEffect(chatSessionsDir, signal), [])

      const { project, workingDirectory } = yield* resolveWorkspaceProject(wsDir, hashDir, context)
      for (const file of files) {
        yield* checkScanAbort(signal)
        if (!isChatSessionFile(file)) continue
        const path = join(chatSessionsDir, file)
        const s = yield* optionalDiscovery(statEffect(path, signal), null)
        if (!s?.isFile()) continue
        sources.push({
          path,
          project,
          provider: 'copilot',
          sourceType: 'chatsession',
          ...(workingDirectory ? { workingDirectory } : {}),
        })
      }
    }
  }

  return sources
})

const discoverEmptyWindowChatSessions = Effect.fnUntraced(function* (
  globalStorageDirs: string[],
  context?: ProviderScanContext,
): Effect.fn.Return<ChatSessionSource[], Error> {
  const signal = context?.signal
  const sources: ChatSessionSource[] = []

  for (const globalDir of globalStorageDirs) {
    yield* checkScanAbort(signal)
    const chatSessionsDir = join(globalDir, 'emptyWindowChatSessions')
    const files = yield* optionalDiscovery(readDirectoryEffect(chatSessionsDir, signal), [])

    for (const file of files) {
      yield* checkScanAbort(signal)
      if (!isChatSessionFile(file)) continue
      const path = join(chatSessionsDir, file)
      const s = yield* optionalDiscovery(statEffect(path, signal), null)
      if (!s?.isFile()) continue
      sources.push({
        path,
        project: 'copilot-chat',
        provider: 'copilot',
        sourceType: 'chatsession',
      })
    }
  }

  return sources
})

// ---------------------------------------------------------------------------
// Session discovery: VS Code workspace transcripts
// ---------------------------------------------------------------------------

/**
 * Discover Copilot Chat transcript sessions stored in VS Code workspaceStorage.
 * Structure: {wsDir}/{hash}/GitHub.copilot-chat/transcripts/{session}.jsonl
 * Project is read from {wsDir}/{hash}/workspace.json (folder URI).
 */
const discoverTranscriptSessions = Effect.fnUntraced(function* (
  workspaceStorageDirs: string[],
  context?: ProviderScanContext,
): Effect.fn.Return<JsonlSessionSource[], Error> {
  const signal = context?.signal
  const sources: JsonlSessionSource[] = []

  for (const wsDir of workspaceStorageDirs) {
    yield* checkScanAbort(signal)
    const hashDirs = yield* optionalDiscovery(readDirectoryEffect(wsDir, signal), [])

    for (const hashDir of hashDirs) {
      yield* checkScanAbort(signal)
      const chatSessionsDir = join(wsDir, hashDir, 'chatSessions')
      if (yield* hasChatSessionFiles(chatSessionsDir, context)) continue

      const transcriptsDir = join(wsDir, hashDir, 'GitHub.copilot-chat', 'transcripts')
      const { project, workingDirectory } = yield* resolveWorkspaceProject(wsDir, hashDir, context)
      const transcriptFiles = yield* optionalDiscovery(readDirectoryEffect(transcriptsDir, signal), [])

      for (const file of transcriptFiles) {
        yield* checkScanAbort(signal)
        if (!file.endsWith('.jsonl')) continue
        const s = yield* optionalDiscovery(statEffect(join(transcriptsDir, file), signal), null)
        if (!s?.isFile()) continue
        sources.push({
          path: join(transcriptsDir, file),
          project,
          provider: 'copilot',
          sourceType: 'jsonl',
          sessionKind: 'transcript',
          ...(workingDirectory ? { workingDirectory } : {}),
        })
      }
    }
  }

  return sources
})

export function createCopilotProvider(
  sessionStateDir?: string,
  workspaceStorageDir?: string,
  globalStorageDir?: string,
  jetbrainsDir?: string,
  paths?: AppPaths,
): Provider {
  // jsonlDir is resolved lazily inside discoverSessions so that env-var
  // overrides set after module load (e.g. in tests) are respected.

  /**
   * The provider-lifetime record of what the session-store has described, keyed
   * by `${sessionId}\n${model}` and holding that pair's rows.
   *
   * It lives in the provider closure because the architecture gives a provider
   * no per-scan object: `createSessionParser` is called once per source and
   * nothing threads state between them. The store source is discovered FIRST
   * (see discoverSessions) and the scan parses sources in discovery order, so
   * by the time any events.jsonl source asks, this map already holds every row
   * the store covered in this pass.
   *
   * Rows rather than totals because reconciliation is per leg interval: a leg
   * claims only what happened between its predecessor, its own last compaction
   * and itself, and only the rows inside that window may cancel it.
   */
  const storeRows = new Map<string, StoreRowUsage[]>()

  /**
   * Session ids this pass has seen billed usage for — a journal call carrying
   * tokens or an exact credit figure, or a store row.
   *
   * A VS Code core chat-session journal of the same session is a second record
   * of the same requests (the agent host writes both, under one id), so the
   * journal parser leaves such a session out rather than counting it twice. A
   * session-state file with no usage yet keeps the chat journal.
   */
  const agentHostUsageSessions = new Set<string>()

  /**
   * Session ids the store has billed usage for.
   *
   * A VS Code core chat-session journal of the same session is a second record of
   * the same requests (the agent host writes both, under one id), so the journal
   * parser leaves such a session out rather than counting it twice. A session-state
   * file with no usage yet keeps the journal.
   */
  const storeSessionIds = new Set<string>()

  /**
   * The set of session ids that have a LOCAL per-turn journal
   * (`session-state/<id>/events.jsonl`), filled by JSONL discovery.
   *
   * The store parser reads it to decide which rows may own their output (see the
   * OUTPUT OWNERSHIP block there): a row whose session has no local journal is
   * the ONLY record of that request's output anywhere, so zeroing it the way a
   * local session's row is zeroed loses the tokens outright.
   *
   * Monotonic over the provider's lifetime, like `storeUsage` and for the same
   * reason: never cleared, so an id added once keeps the `assistant.message`
   * owner. Clearing it per pass would be tighter on paper, but a discovery pass
   * that fails or is aborted mid-walk would then hand every session's output back
   * to the store rows as well — double-counting, the one direction this provider
   * must never take. Stale ids can only under-report, which the durable cache
   * already covers by serving the per-turn output it recorded once.
   */
  const localSessionIds = new Set<string>()

  /**
   * Returns the workspaceStorage directories to scan for transcript sessions.
   * When workspaceStorageDir is explicitly provided (e.g. in tests), that single
   * directory is used. The WATCHTOWER_COPILOT_WS_STORAGE_DIR env var provides a
   * single-dir override (useful for tests). Otherwise all platform-default VS
   * Code variant paths are returned.
   */
  function getWsDirs(): string[] {
    if (workspaceStorageDir !== undefined) return [workspaceStorageDir]
    const envDir = overrideFor(paths, 'WATCHTOWER_COPILOT_WS_STORAGE_DIR')
    if (envDir) return [envDir]
    return getVSCodeWorkspaceStorageDirs(homedir(), platform())
  }

  function getGlobalDirs(): string[] {
    if (globalStorageDir !== undefined) return [globalStorageDir]
    const envDir = overrideFor(paths, 'WATCHTOWER_COPILOT_GLOBAL_STORAGE_DIR')
    if (envDir) return [envDir]
    return getVSCodeGlobalStorageDirs(homedir(), platform())
  }

  /**
   * Resolve the CLI store candidate; Effect-native stat checks it during discovery.
   *
   * Resolved lazily inside native discovery (like the session-state dir) so an
   * override set after module load is respected, and derived from the CLI home
   * so the one session-state seam redirects both roots.
   */
  function getSessionStorePath(): string {
    return getCopilotSessionStoreDbCandidate(sessionStateDir, paths)
  }

  const discoverEffect = Effect.fn('discoverCopilotSessions')(function* (
    context?: ProviderScanContext,
  ): Effect.fn.Return<SessionSource[], Error> {
    const signal = context?.signal
    yield* checkScanAbort(signal)
    const sources: SessionSource[] = []

    // Store first: its parser populates covered session/model keys before events.jsonl rollups.
    sources.push(...(yield* discoverSessionStoreSessions(getSessionStorePath(), context)))

    // OTel carries richer token data and takes precedence over chat journals.
    const disableOtel = overrideFor(paths, 'WATCHTOWER_COPILOT_DISABLE_OTEL') === '1'
    let discoveredOtel = false
    if (!disableOtel) {
      const dbPath = yield* findExistingFile(getAgentTracesDbCandidates(paths), signal)
      if (dbPath) {
        const otelSources = yield* discoverOtelSessions(dbPath, context)
        discoveredOtel = otelSources.length > 0
        sources.push(...otelSources)
      }
    }

    sources.push(
      ...(yield* discoverJsonlSessions(getCopilotSessionStateDir(sessionStateDir, paths), localSessionIds, context)),
    )
    if (!discoveredOtel) {
      sources.push(...(yield* discoverWorkspaceChatSessions(getWsDirs(), context)))
      sources.push(...(yield* discoverEmptyWindowChatSessions(getGlobalDirs(), context)))
    }
    sources.push(...(yield* discoverTranscriptSessions(getWsDirs(), context)))
    sources.push(...(yield* discoverJetBrainsSessions(getJetBrainsCopilotRoot(jetbrainsDir, paths), context)))
    yield* checkScanAbort(signal)
    return sources
  })

  const discover = (context?: ProviderScanContext) => Effect.suspend(() => discoverEffect(context))

  return {
    name: 'copilot',
    displayName: 'Copilot',
    durableSources: true,

    modelDisplayName(model: string): string {
      for (const [key, display] of modelDisplayEntries) {
        if (model.includes(key)) return display
      }
      return model
    },

    toolDisplayName(rawTool: string): string {
      return normalizeTool(rawTool)
    },

    discoverSessionsEffect: discover,

    createSessionParser(
      source: SessionSource,
      seenKeys: Set<string>,
      _dateRange?: DateRange,
      context?: ProviderScanContext,
    ): SessionParser {
      throwIfScanAborted(context?.signal)
      const parserContext: CopilotParserContext = {
        ...context,
        pricing: context?.pricing ?? captureScanPricing(),
      }
      // Route to the correct parser based on source type.
      // The dedup key set (seenKeys) is shared across both parsers,
      // so if OTel already yielded a span, the JSONL parser will skip
      // the matching assistant.message (and vice versa).
      if (isSessionStoreSource(source)) {
        return createSessionStoreParser(source, seenKeys, storeRows, storeSessionIds, localSessionIds, parserContext)
      }
      if (isOtelSource(source)) {
        return createOtelParser(source, seenKeys, parserContext)
      }
      if (isChatSessionSource(source)) {
        return createChatSessionParser(source, seenKeys, storeSessionIds, agentHostUsageSessions, parserContext)
      }
      if (isJetBrainsSource(source)) {
        return createJetBrainsParser(source, seenKeys, parserContext)
      }
      return createJsonlParser(source, seenKeys, storeRows, localSessionIds, agentHostUsageSessions, parserContext)
    },
  }
}

// Default export for the provider registry
export const copilot = createCopilotProvider()
