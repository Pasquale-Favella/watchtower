import { Effect, Result, Schema, Stream } from 'effect'
import { readdir, stat } from 'fs/promises'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'

import { billableOutputTokens } from '../billable-output.js'
import { fileErrorCode, reportProviderIssue } from '../file-errors.js'
import { captureScanPricing, getShortModelName } from '../models.js'
import { isScanAbortedError } from '../scan-control.js'
import { checkScanAbort, scanIo } from '../scan-io.js'
import { isSqliteAvailable, isSqliteBusyError, openDatabase, type SqliteDatabase } from '../sqlite.js'
import type { DateRange } from '../types.js'
import type { ToolCall } from '../types.js'
import type { ParsedProviderCall, Provider, ProviderScanContext, SessionParser, SessionSource } from './types.js'

type HermesSessionRow = {
  id: string
  source: string | null
  model: string | null
  cwd: string | null
  billing_provider: string | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  reasoning_tokens: number | null
  estimated_cost_usd: number | null
  actual_cost_usd: number | null
  api_call_count: number | null
  tool_call_count: number | null
  started_at: number | null
  ended_at: number | null
  title: string | null
}

type HermesMessageRow = {
  id: number | null
  role: string
  content: string | null
  tool_calls: string | null
  tool_name: string | null
  timestamp: number | null
}

type ProfileDb = {
  dbPath: string
  profile: string
}

type TableColumn = keyof HermesSessionRow | keyof HermesMessageRow

const nullableString = Schema.NullOr(Schema.String)
const nullableFinite = Schema.NullOr(Schema.Finite)
const sqliteCostValueSchema = Schema.Union([Schema.Number, Schema.String, Schema.Uint8Array])
const nullableSqliteCostValue = Schema.NullOr(sqliteCostValueSchema)
const tableInfoSchema = Schema.Struct({ name: Schema.String })
const discoveryRowSchema = Schema.Struct({ id: Schema.String })
const recordedCostsSchema = Schema.Struct({
  estimated_cost_usd: nullableSqliteCostValue,
  actual_cost_usd: nullableSqliteCostValue,
})
const parserSessionRowSchema = Schema.Struct({
  id: Schema.String,
  model: nullableString,
  cwd: nullableString,
  input_tokens: Schema.Finite,
  output_tokens: Schema.Finite,
  cache_read_tokens: Schema.Finite,
  cache_write_tokens: Schema.Finite,
  reasoning_tokens: Schema.Finite,
  started_at: nullableFinite,
})
const messageRoleSchema = Schema.Struct({ role: Schema.String })
const userMessageFieldsSchema = Schema.Struct({ content: nullableString })
const assistantMessageFieldsSchema = Schema.Struct({ tool_calls: nullableString })
const toolMessageFieldsSchema = Schema.Struct({ tool_name: nullableString })
const toolCallSchema = Schema.Struct({
  function: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      arguments: Schema.optional(Schema.Unknown),
    }),
  ),
})
const jsonArraySchema = Schema.Array(Schema.Unknown)
const argumentRecordSchema = Schema.Record(Schema.String, Schema.Unknown)

type ParserSessionRow = Schema.Schema.Type<typeof parserSessionRowSchema>
type RecordedCosts = Schema.Schema.Type<typeof recordedCostsSchema>
type MessageRow = {
  role: string
  content?: string | null
  tool_calls?: string | null
  tool_name?: string | null
}
type ToolCallValue = Schema.Schema.Type<typeof toolCallSchema>
type DiscoveryRow = Schema.Schema.Type<typeof discoveryRowSchema>

const decodeTableInfo = Schema.decodeUnknownResult(tableInfoSchema)
const decodeDiscoveryRow = Schema.decodeUnknownResult(discoveryRowSchema)
const decodeRecordedCosts = Schema.decodeUnknownResult(recordedCostsSchema)
const decodeParserSessionRow = Schema.decodeUnknownResult(parserSessionRowSchema)
const decodeSelectedRecordedCost = Schema.decodeUnknownResult(Schema.Finite)
const decodeMessageRole = Schema.decodeUnknownResult(messageRoleSchema)
const decodeUserMessageFields = Schema.decodeUnknownResult(userMessageFieldsSchema)
const decodeAssistantMessageFields = Schema.decodeUnknownResult(assistantMessageFieldsSchema)
const decodeToolMessageFields = Schema.decodeUnknownResult(toolMessageFieldsSchema)
const decodeToolCall = Schema.decodeUnknownResult(toolCallSchema)
const decodeJsonArray = Schema.decodeUnknownResult(jsonArraySchema)
const decodeArgumentRecord = Schema.decodeUnknownResult(argumentRecordSchema)
const decodeString = Schema.decodeUnknownResult(Schema.String)

function selectRecordedCost(costs: RecordedCosts): Result.Result<number | null, Schema.SchemaError> {
  if (Number(costs.actual_cost_usd ?? 0) > 0) return decodeSelectedRecordedCost(costs.actual_cost_usd)
  if (Number(costs.estimated_cost_usd ?? 0) > 0) return decodeSelectedRecordedCost(costs.estimated_cost_usd)
  return Result.succeed(null)
}

class HermesDatabaseError extends Schema.TaggedError<HermesDatabaseError>()('HermesDatabaseError', {
  operation: Schema.Literals(['open', 'read', 'close']),
  cause: Schema.Defect(),
  message: Schema.String,
}) {}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause), { cause })
}

function databaseError(operation: HermesDatabaseError['operation'], cause: unknown): HermesDatabaseError {
  const error = toError(cause)
  return new HermesDatabaseError({ operation, cause: error, message: error.message })
}

const sourceRows = Effect.fnUntraced(function* <A>(
  path: string,
  read: (db: SqliteDatabase) => A,
): Effect.fn.Return<A, HermesDatabaseError> {
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

const toolNameMap: Record<string, string> = {
  terminal: 'Bash',
  execute_code: 'CodeExecution',
  read_file: 'Read',
  search_files: 'Grep',
  write_file: 'Write',
  patch: 'Edit',
  browser_navigate: 'Browser',
  browser_click: 'Browser',
  browser_type: 'Browser',
  browser_press: 'Browser',
  browser_scroll: 'Browser',
  browser_snapshot: 'Browser',
  browser_vision: 'Vision',
  browser_console: 'Browser',
  browser_get_images: 'Browser',
  web_search: 'WebSearch',
  web_extract: 'WebFetch',
  delegate_task: 'Agent',
  vision_analyze: 'Vision',
  process: 'Bash',
  todo: 'TodoWrite',
  skill_view: 'Skill',
  skill_manage: 'Skill',
  skills_list: 'Skill',
  memory: 'Memory',
  session_search: 'SessionSearch',
}

function getHermesHome(override?: string): string {
  return override ?? process.env['HERMES_HOME'] ?? join(homedir(), '.hermes')
}

function sanitizeProject(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return 'hermes'
  return trimmed.replace(/^[/\\]+/, '').replace(/[:/\\]/g, '-')
}

function parseProfileName(dbPath: string, hermesHome: string): string {
  const profilesDir = join(hermesHome, 'profiles')
  const dir = dirname(dbPath)
  if (dirname(dir) === profilesDir) return basename(dir)
  return 'default'
}

const findStateDbs = Effect.fn('findHermesStateDbs')(function* (
  hermesHome: string,
  signal?: AbortSignal,
): Effect.fn.Return<ProfileDb[], Error> {
  const dbs: ProfileDb[] = []
  const rootDb = join(hermesHome, 'state.db')
  const rootStat = yield* scanIo(() => stat(rootDb), signal).pipe(
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(null))),
  )
  if (rootStat?.isFile()) dbs.push({ dbPath: rootDb, profile: 'default' })

  const profilesDir = join(hermesHome, 'profiles')
  const profiles = yield* scanIo(() => readdir(profilesDir, { withFileTypes: true }), signal).pipe(
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed([]))),
  )
  for (const entry of profiles) {
    yield* checkScanAbort(signal)
    if (!entry.isDirectory()) continue
    const dbPath = join(profilesDir, entry.name, 'state.db')
    const info = yield* scanIo(() => stat(dbPath), signal).pipe(
      Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(null))),
    )
    if (info?.isFile()) dbs.push({ dbPath, profile: entry.name })
  }
  return dbs
})

function encodeSourcePath(dbPath: string, sessionId: string): string {
  return `${dbPath}#hermes-session=${encodeURIComponent(sessionId)}`
}

function decodeSourcePath(path: string): { dbPath: string; sessionId: string } | null {
  const marker = '#hermes-session='
  const idx = path.lastIndexOf(marker)
  if (idx === -1) return null
  return {
    dbPath: path.slice(0, idx),
    sessionId: decodeURIComponent(path.slice(idx + marker.length)),
  }
}

function validateSchema(db: SqliteDatabase): boolean {
  try {
    db.query('SELECT session_id, role, content, tool_calls FROM messages LIMIT 1')
    const columns = getSessionColumns(db)
    return columns.has('id') && columns.has('input_tokens') && columns.has('output_tokens')
  } catch (err) {
    if (isSqliteBusyError(err)) throw err
    return false
  }
}

function getSessionColumns(db: SqliteDatabase): Set<string> {
  return new Set(
    db.query('PRAGMA table_info(sessions)').flatMap(raw => {
      const decoded = decodeTableInfo(raw)
      return Result.isSuccess(decoded) ? [decoded.success.name] : []
    }),
  )
}

function numberColumn(columns: Set<string>, name: TableColumn): string {
  return columns.has(name) ? `coalesce(${name}, 0) AS ${name}` : `0 AS ${name}`
}

function nullableColumn(columns: Set<string>, name: TableColumn): string {
  return columns.has(name) ? name : `NULL AS ${name}`
}

function getMessageColumns(db: SqliteDatabase): Set<string> {
  return new Set(
    db.query('PRAGMA table_info(messages)').flatMap(raw => {
      const decoded = decodeTableInfo(raw)
      return Result.isSuccess(decoded) ? [decoded.success.name] : []
    }),
  )
}

function usageExpression(columns: Set<string>): string {
  const usageColumns: Array<keyof HermesSessionRow> = [
    'input_tokens',
    'output_tokens',
    'cache_read_tokens',
    'cache_write_tokens',
    'reasoning_tokens',
  ]
  const parts = usageColumns.filter(name => columns.has(name)).map(name => `coalesce(${name}, 0)`)
  return parts.length > 0 ? parts.join(' + ') : '0'
}

function parseTimestamp(raw: number | null): string {
  if (raw == null) return ''
  const ms = raw < 1e12 ? raw * 1000 : raw
  return new Date(ms).toISOString()
}

function decodeMessageRow(raw: unknown): MessageRow | null {
  const decodedRole = decodeMessageRole(raw)
  if (Result.isFailure(decodedRole)) return null
  const role = decodedRole.success.role
  if (role === 'user' || role === 'system') {
    const decoded = decodeUserMessageFields(raw)
    return Result.isSuccess(decoded) ? { role, content: decoded.success.content } : null
  }
  if (role === 'assistant') {
    const decoded = decodeAssistantMessageFields(raw)
    return Result.isSuccess(decoded) ? { role, tool_calls: decoded.success.tool_calls } : null
  }
  if (role === 'tool') {
    const decoded = decodeToolMessageFields(raw)
    return Result.isSuccess(decoded) ? { role, tool_name: decoded.success.tool_name } : null
  }
  return { role }
}

function firstUserMessage(messages: MessageRow[]): string {
  const msg = messages.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.trim().length > 0)
  return Array.from(msg?.content ?? '')
    .slice(0, 500)
    .join('')
}

function mapToolName(raw: string): string {
  // Composio MCP tools are matched first — the generic mcp_ prefix on line
  // below would also match composio names, so order matters here.
  if (raw.startsWith('mcp_composio_')) return 'MCP'
  if (raw.startsWith('mcp_') || raw.startsWith('mcp__')) return raw
  if (raw.startsWith('browser_')) return 'Browser'
  return toolNameMap[raw] ?? raw
}

function parseToolCalls(raw: string | null): ToolCallValue[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    const decoded = decodeJsonArray(parsed)
    if (Result.isFailure(decoded)) return []
    return decoded.success.flatMap(candidate => {
      const call = decodeToolCall(candidate)
      return Result.isSuccess(call) ? [call.success] : []
    })
  } catch {
    return []
  }
}

function collectTools(messages: MessageRow[]): {
  tools: string[]
  toolSequence: ToolCall[][]
  bashCommands: string[]
} {
  const tools: string[] = []
  const toolSequence: ToolCall[][] = []
  const bashCommands: string[] = []

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const currentTurnTools: ToolCall[] = []
      for (const call of parseToolCalls(msg.tool_calls ?? null)) {
        const rawName = call.function?.name ?? ''
        if (!rawName) continue
        const mapped = mapToolName(rawName)
        tools.push(mapped)
        const toolCall: ToolCall = { tool: mapped }
        const decodedArgs = decodeString(call.function?.arguments)
        if (Result.isSuccess(decodedArgs) && decodedArgs.success) {
          try {
            const parsedArgs = JSON.parse(decodedArgs.success) as unknown
            const args = decodeArgumentRecord(parsedArgs)
            if (Result.isSuccess(args)) {
              const file = decodeString(args.success['path'] ?? args.success['file_path'])
              if (Result.isSuccess(file)) toolCall.file = file.success
              const command = decodeString(args.success['command'])
              if (Result.isSuccess(command)) {
                toolCall.command = command.success
                bashCommands.push(command.success)
              }
            }
          } catch {
            // Ignore malformed arguments from historical sessions.
          }
        }
        currentTurnTools.push(toolCall)
      }
      if (currentTurnTools.length > 0) {
        toolSequence.push(currentTurnTools)
      }
    } else if (msg.role === 'tool' && msg.tool_name) {
      tools.push(mapToolName(msg.tool_name))
    }
  }

  return {
    tools: [...new Set(tools)],
    toolSequence: toolSequence.length > 0 ? toolSequence : [],
    bashCommands,
  }
}

function inferProject(messages: MessageRow[], fallback: string): { project: string; projectPath?: string } {
  const cwdPattern = /^Current working directory:\s*([a-zA-Z]:\\[^\r\n`"]+|\/[^\r\n`"\\]+)/m
  for (const msg of messages) {
    if (msg.role !== 'user' && msg.role !== 'system') continue
    const text = msg.content ?? ''
    const match = cwdPattern.exec(text)
    if (match?.[1]) {
      const projectPath = match[1].trim()
      return { project: sanitizeProject(projectPath), projectPath }
    }
  }
  return { project: fallback }
}

const discoverFromDb = Effect.fn('discoverHermesSessionsFromDb')(function* (
  dbPath: string,
  profile: string,
): Effect.fn.Return<SessionSource[], Error> {
  const rows = yield* sourceRows(dbPath, db => {
    if (!validateSchema(db)) return []
    const columns = getSessionColumns(db)
    const usage = usageExpression(columns)
    const orderBy = columns.has('started_at') ? 'started_at DESC' : 'id DESC'
    return db.query(
      `SELECT id,
              ${nullableColumn(columns, 'title')},
              ${numberColumn(columns, 'input_tokens')},
              ${numberColumn(columns, 'output_tokens')},
              ${numberColumn(columns, 'cache_read_tokens')},
              ${numberColumn(columns, 'cache_write_tokens')},
              ${numberColumn(columns, 'reasoning_tokens')}
       FROM sessions
       WHERE ${usage} > 0
       ORDER BY ${orderBy}
       LIMIT 10000`,
    )
  }).pipe(
    Effect.catchTag('HermesDatabaseError', error => {
      if (error.operation === 'close' || (error.operation === 'read' && isSqliteBusyError(error.cause))) {
        return Effect.fail(toError(error.cause))
      }
      if (error.operation === 'read') reportProviderIssue('hermes', fileErrorCode(error.cause, 'db-query-failed'))
      return Effect.succeed([])
    }),
  )

  return rows.flatMap(raw => {
    const decoded = decodeDiscoveryRow(raw)
    if (Result.isFailure(decoded)) return []
    const row: DiscoveryRow = decoded.success
    return [
      {
        path: encodeSourcePath(dbPath, row.id),
        project: sanitizeProject(profile),
        provider: 'hermes',
      },
    ]
  })
})

function createParser(
  source: SessionSource,
  seenKeys: Set<string>,
  hermesHome: string,
  context?: ProviderScanContext,
): SessionParser {
  const pricing = context?.pricing ?? captureScanPricing()
  const signal = context?.signal
  const parseEffect = Effect.fnUntraced(function* (
    onUnparsedCall: Effect.Effect<void>,
  ): Effect.fn.Return<Stream.Stream<ParsedProviderCall, Error>, Error> {
    yield* checkScanAbort(signal)
    if (!isSqliteAvailable()) {
      reportProviderIssue('hermes', 'sqlite-unavailable')
      return Stream.empty
    }

    const decoded = decodeSourcePath(source.path)
    if (!decoded) return Stream.empty
    const profile = parseProfileName(decoded.dbPath, hermesHome)

    const materialized = yield* sourceRows(decoded.dbPath, db => {
      if (!validateSchema(db)) return null
      const columns = getSessionColumns(db)
      const rows = db.query(
        `SELECT id,
                ${nullableColumn(columns, 'source')},
                ${nullableColumn(columns, 'model')},
                ${nullableColumn(columns, 'cwd')},
                ${nullableColumn(columns, 'billing_provider')},
                ${numberColumn(columns, 'input_tokens')},
                ${numberColumn(columns, 'output_tokens')},
                ${numberColumn(columns, 'cache_read_tokens')},
                ${numberColumn(columns, 'cache_write_tokens')},
                ${numberColumn(columns, 'reasoning_tokens')},
                ${nullableColumn(columns, 'estimated_cost_usd')},
                ${nullableColumn(columns, 'actual_cost_usd')},
                ${numberColumn(columns, 'api_call_count')},
                ${numberColumn(columns, 'tool_call_count')},
                ${nullableColumn(columns, 'started_at')},
                ${nullableColumn(columns, 'ended_at')},
                ${nullableColumn(columns, 'title')}
         FROM sessions
         WHERE id = ?`,
        [decoded.sessionId],
      )
      const messageColumns = getMessageColumns(db)
      const orderColumns = ['timestamp', 'id'].filter(name => messageColumns.has(name))
      const orderBy = orderColumns.length > 0 ? `ORDER BY ${orderColumns.join(' ASC, ')} ASC` : ''
      const messages = db.query(
        `SELECT ${numberColumn(messageColumns, 'id')},
                role,
                content,
                tool_calls,
                ${nullableColumn(messageColumns, 'tool_name')},
                ${nullableColumn(messageColumns, 'timestamp')}
         FROM messages
         WHERE session_id = ?
         ${orderBy}`,
        [decoded.sessionId],
      )
      return { rows, messages }
    }).pipe(
      Effect.catchTag('HermesDatabaseError', error => {
        if (error.operation === 'open') {
          reportProviderIssue('hermes', fileErrorCode(error.cause, 'db-open-failed'))
          return Effect.succeed(null)
        }
        if (error.operation === 'close' || isSqliteBusyError(error.cause)) {
          return Effect.fail(toError(error.cause))
        }
        reportProviderIssue('hermes', fileErrorCode(error.cause, 'db-query-failed'))
        return Effect.succeed(null)
      }),
    )
    yield* checkScanAbort(signal)
    if (materialized === null) return Stream.empty

    const sessionRaw = materialized.rows[0]
    if (!sessionRaw) return Stream.empty
    const decodedSession = decodeParserSessionRow(sessionRaw)
    if (Result.isFailure(decodedSession)) return Stream.empty
    const row: ParserSessionRow = decodedSession.success
    const decodedCosts = decodeRecordedCosts(sessionRaw)
    if (Result.isFailure(decodedCosts)) return Stream.empty
    const recordedCosts: RecordedCosts = decodedCosts.success
    const messages: MessageRow[] = materialized.messages.flatMap(raw => {
      const decodedMessage = decodeMessageRow(raw)
      return decodedMessage === null ? [] : [decodedMessage]
    })

    const inputTokens = row.input_tokens
    const outputTokens = row.output_tokens
    const cacheReadTokens = row.cache_read_tokens
    const cacheWriteTokens = row.cache_write_tokens
    const reasoningTokens = row.reasoning_tokens
    if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens === 0) return Stream.empty

    const model = row.model ?? 'unknown'
    const { tools, toolSequence, bashCommands } = collectTools(messages)
    // Hermes records the session's working directory in sessions.cwd.
    // Prefer it; fall back to scraping a "Current working directory:" line
    // from the transcript (older builds), then to the profile name.
    const cwd = row.cwd?.trim()
    const projectInfo = cwd
      ? { project: sanitizeProject(cwd), projectPath: cwd }
      : inferProject(messages, sanitizeProject(profile))
    const timestamp = parseTimestamp(row.started_at)
    const dedupKey = `hermes:${profile}:${row.id}`
    const baseCall = {
      provider: 'hermes' as const,
      model,
      inputTokens,
      outputTokens,
      cacheCreationInputTokens: cacheWriteTokens,
      cacheReadInputTokens: cacheReadTokens,
      cachedInputTokens: cacheReadTokens,
      reasoningTokens,
      webSearchRequests: 0,
      tools,
      bashCommands,
      timestamp,
      speed: 'standard' as const,
      deduplicationKey: dedupKey,
      turnId: `${row.id}:session`,
      toolSequence: toolSequence.length > 0 ? toolSequence : undefined,
      userMessage: firstUserMessage(messages),
      sessionId: row.id,
      project: projectInfo.project,
      projectPath: projectInfo.projectPath,
    }

    return Stream.fromIterable([baseCall]).pipe(
      Stream.rechunk(1),
      Stream.mapEffect(call =>
        Effect.gen(function* () {
          yield* checkScanAbort(signal)
          if (seenKeys.has(dedupKey)) return Result.fail(undefined)
          seenKeys.add(dedupKey)

          // Evaluate computed pricing even when Hermes stored a positive cost;
          // legacy parser callback and failure ordering depend on this point.
          const calculatedCost = yield* Effect.try({
            try: () =>
              pricing.calculateCost(
                model,
                inputTokens,
                billableOutputTokens('hermes', outputTokens, reasoningTokens),
                cacheWriteTokens,
                cacheReadTokens,
                0,
              ),
            catch: toError,
          })
          const decodedRecordedCost = selectRecordedCost(recordedCosts)
          if (Result.isFailure(decodedRecordedCost)) {
            yield* onUnparsedCall
            return Result.fail(undefined)
          }
          const recordedCost = decodedRecordedCost.success
          const costUSD = recordedCost ?? calculatedCost
          const costIsEstimated = recordedCost === null
          yield* checkScanAbort(signal)
          return Result.succeed({ ...call, costUSD, costIsEstimated } satisfies ParsedProviderCall)
        }),
      ),
      Stream.filterMap(call => call),
    )
  })

  const parseStream = (onUnparsedCall: Effect.Effect<void> = Effect.void): Stream.Stream<ParsedProviderCall, Error> =>
    Stream.unwrap(parseEffect(onUnparsedCall))
  return {
    parseStream,
    // Remove this async-generator edge when all direct parser callers consume parseStream.
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      yield* Stream.toAsyncIterable(parseStream())
    },
  }
}

export function createHermesProvider(hermesHomeOverride?: string): Provider {
  const hermesHome = getHermesHome(hermesHomeOverride)
  const discoverEffect = Effect.fn('discoverHermesSessions')(function* (
    context?: ProviderScanContext,
  ): Effect.fn.Return<SessionSource[], Error> {
    yield* checkScanAbort(context?.signal)
    if (!isSqliteAvailable()) return []
    const dbs = yield* findStateDbs(hermesHome, context?.signal)
    const sessions: SessionSource[] = []
    for (const { dbPath, profile } of dbs) {
      yield* checkScanAbort(context?.signal)
      sessions.push(...(yield* discoverFromDb(dbPath, profile)))
    }
    yield* checkScanAbort(context?.signal)
    return sessions
  })

  return {
    name: 'hermes',
    displayName: 'Hermes Agent',

    modelDisplayName(model: string): string {
      return getShortModelName(model)
    },

    toolDisplayName(rawTool: string): string {
      return mapToolName(rawTool)
    },

    discoverSessionsEffect: discoverEffect,
    // Remove this Promise edge when every discovery caller uses the native Effect entry point.
    discoverSessions(context?: ProviderScanContext): Promise<SessionSource[]> {
      // eslint-disable-next-line no-restricted-syntax
      return Effect.runPromise(discoverEffect(context))
    },

    createSessionParser(
      source: SessionSource,
      seenKeys: Set<string>,
      _dateRange?: DateRange,
      context?: ProviderScanContext,
    ): SessionParser {
      return createParser(source, seenKeys, hermesHome, context)
    },
  }
}

export const hermes = createHermesProvider()
