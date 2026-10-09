import { homedir } from 'node:os'
import { join } from 'node:path'

import { Effect, Result, Schema, Stream } from 'effect'

import { fileErrorCode, reportProviderIssue } from '../file-errors.js'
import { captureScanPricing } from '../models.js'
import { checkScanAbort } from '../scan-io.js'
import { isSqliteAvailable, openDatabase, type SqliteDatabase } from '../sqlite.js'
import type { DateRange } from '../types.js'
import type { ParsedProviderCall, Provider, ProviderScanContext, SessionParser, SessionSource } from './types.js'

/// ZCode (CLI v0.14.x) records usage in a single SQLite database at
/// ~/.zcode/cli/db/db.sqlite. We read it because the other on-disk sources are
/// unusable for billing: the JSONL activity log redacts token counts, and no
/// source stores a dollar cost (GLM-5.2 runs on z.ai's start-plan subscription).
/// Tokens are exact; cost is computed from the pricing table. Schema verified
/// against db v0.14.8 on 2026-06-20.

const nullableFinite = Schema.NullOr(Schema.Finite)
const nullableString = Schema.NullOr(Schema.String)
const sessionRowSchema = Schema.Struct({ id: Schema.String, directory: Schema.String })
const toolRowSchema = Schema.Struct({ turn_id: nullableString, tool_name: Schema.String })
const usageRowSchema = Schema.Struct({
  id: Schema.String,
  turn_id: Schema.optional(nullableString),
  model_id: Schema.String,
  input_tokens: Schema.optional(nullableFinite),
  output_tokens: Schema.optional(nullableFinite),
  reasoning_tokens: Schema.optional(nullableFinite),
  cache_creation_input_tokens: Schema.optional(nullableFinite),
  cache_read_input_tokens: Schema.optional(nullableFinite),
})
const timestampRowSchema = Schema.Struct({ started_at: Schema.Unknown, completed_at: Schema.Unknown })
const decodeTimestampNumber = Schema.decodeUnknownResult(Schema.Finite)
type SessionRow = Schema.Schema.Type<typeof sessionRowSchema>
type ToolRow = Schema.Schema.Type<typeof toolRowSchema>
type UsageRow = Schema.Schema.Type<typeof usageRowSchema>
type TimestampRow = Schema.Schema.Type<typeof timestampRowSchema>

const decodeSessionRow = Schema.decodeUnknownResult(sessionRowSchema)
const decodeToolRow = Schema.decodeUnknownResult(toolRowSchema)
const decodeUsageRow = Schema.decodeUnknownResult(usageRowSchema)
const decodeTimestampRow = Schema.decodeUnknownResult(timestampRowSchema)

function getDbPath(override?: string): string {
  return override ?? join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite')
}

function sanitizeProject(path: string): string {
  return path.replace(/^\//, '').replace(/\//g, '-')
}

function epochMsToIso(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return new Date(0).toISOString()
  return new Date(ms).toISOString()
}

function validateSchema(db: SqliteDatabase): boolean {
  try {
    db.query('SELECT COUNT(*) as cnt FROM model_usage LIMIT 1')
    db.query('SELECT COUNT(*) as cnt FROM session LIMIT 1')
    return true
  } catch {
    return false
  }
}

const sourceRows = Effect.fnUntraced(function* <A>(
  path: string,
  read: (db: SqliteDatabase) => A,
): Effect.fn.Return<A, ZcodeDatabaseError> {
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

class ZcodeDatabaseError extends Schema.TaggedError<ZcodeDatabaseError>()('ZcodeDatabaseError', {
  operation: Schema.Literals(['open', 'read', 'close']),
  cause: Schema.Defect(),
  message: Schema.String,
}) {}

function databaseError(operation: ZcodeDatabaseError['operation'], cause: unknown): ZcodeDatabaseError {
  const error = toError(cause)
  return new ZcodeDatabaseError({ operation, cause: error, message: error.message })
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

const discoverSessionsEffect = Effect.fn('discoverZcodeSessions')(function* (
  dbPath: string,
  context?: ProviderScanContext,
): Effect.fn.Return<SessionSource[], Error> {
  yield* checkScanAbort(context?.signal)
  if (!isSqliteAvailable()) return []

  const rows = yield* sourceRows(dbPath, db => {
    if (!validateSchema(db)) return []
    return db.query(
      'SELECT DISTINCT s.id as id, s.directory as directory\n' +
        '       FROM session s\n' +
        '       JOIN model_usage m ON m.session_id = s.id\n' +
        '       WHERE m.input_tokens > 0 OR m.output_tokens > 0 OR m.reasoning_tokens > 0\n' +
        '          OR m.cache_read_input_tokens > 0 OR m.cache_creation_input_tokens > 0',
    )
  }).pipe(
    Effect.catchTag('ZcodeDatabaseError', error =>
      error.operation === 'close' ? Effect.fail(toError(error.cause)) : Effect.succeed([]),
    ),
  )
  yield* checkScanAbort(context?.signal)
  return rows.flatMap(raw => {
    const decoded = decodeSessionRow(raw)
    if (Result.isFailure(decoded)) return []
    const row: SessionRow = decoded.success
    return [{ path: `${dbPath}:${row.id}`, project: sanitizeProject(row.directory), provider: 'zcode' }]
  })
})

function splitSourcePath(path: string): { dbPath: string; sessionId: string } {
  const segments = path.split(':')
  const sessionId = segments.pop() ?? ''
  return { dbPath: segments.join(':'), sessionId }
}

function createParser(source: SessionSource, seenKeys: Set<string>, context?: ProviderScanContext): SessionParser {
  const pricing = context?.pricing ?? captureScanPricing()
  const signal = context?.signal
  const { dbPath, sessionId } = splitSourcePath(source.path)

  const parseEffect = Effect.fnUntraced(function* (): Effect.fn.Return<
    Stream.Stream<ParsedProviderCall, Error>,
    Error
  > {
    yield* checkScanAbort(signal)
    if (!isSqliteAvailable()) {
      reportProviderIssue('zcode', 'sqlite-unavailable')
      return Stream.empty
    }

    const materialized = yield* sourceRows(dbPath, db => {
      if (!validateSchema(db)) return null
      // Materialize the minimal projections and close the native connection
      // before any calls are priced or emitted from the downstream stream.
      const toolRows = db.query(
        'SELECT turn_id, tool_name FROM tool_usage\n' +
          '           WHERE session_id = ? AND turn_id IS NOT NULL\n' +
          '           ORDER BY started_at ASC',
        [sessionId],
      )
      const usageRows = db.query(
        'SELECT id, turn_id, model_id, input_tokens, output_tokens, reasoning_tokens,\n' +
          '                  cache_creation_input_tokens, cache_read_input_tokens, started_at, completed_at\n' +
          '           FROM model_usage WHERE session_id = ?\n' +
          '           ORDER BY started_at ASC',
        [sessionId],
      )
      return { toolRows, usageRows }
    }).pipe(
      Effect.catchTag('ZcodeDatabaseError', error => {
        if (error.operation === 'open') {
          reportProviderIssue('zcode', fileErrorCode(error.cause, 'db-open-failed'))
          return Effect.succeed(null)
        }
        return Effect.fail(toError(error.cause))
      }),
    )
    if (materialized === null) return Stream.empty
    yield* checkScanAbort(signal)

    const toolsByTurn = new Map<string, string[]>()
    for (const raw of materialized.toolRows) {
      const decoded = decodeToolRow(raw)
      if (Result.isFailure(decoded) || !decoded.success.turn_id) continue
      const row: ToolRow = decoded.success
      const turnId = row.turn_id
      if (turnId === null) continue
      const list = toolsByTurn.get(turnId) ?? []
      list.push(row.tool_name)
      toolsByTurn.set(turnId, list)
    }

    const turnsWithToolsEmitted = new Set<string>()
    return Stream.fromIterable(materialized.usageRows).pipe(
      Stream.rechunk(1),
      Stream.mapEffect(raw =>
        Effect.gen(function* () {
          yield* checkScanAbort(signal)
          const decoded = decodeUsageRow(raw)
          if (Result.isFailure(decoded)) return Result.fail(undefined)
          const row: UsageRow = decoded.success
          const decodedTimestamp = decodeTimestampRow(raw)
          if (Result.isFailure(decodedTimestamp)) return Result.fail(undefined)
          const timestampRow: TimestampRow = decodedTimestamp.success
          const cacheRead = row.cache_read_input_tokens ?? 0
          const cacheCreation = row.cache_creation_input_tokens ?? 0
          const output = row.output_tokens ?? 0
          const reasoning = row.reasoning_tokens ?? 0
          // ZCode folds cached tokens into input_tokens (OpenAI-style). Split
          // them back out so fresh input bills at the input rate and cached at
          // the cache-read rate, matching the pricing table's Anthropic-style semantics.
          const freshInput = Math.max(0, (row.input_tokens ?? 0) - cacheRead - cacheCreation)
          if (freshInput === 0 && output === 0 && reasoning === 0 && cacheRead === 0 && cacheCreation === 0) {
            return Result.fail(undefined)
          }

          const deduplicationKey = `zcode:${row.id}`
          if (seenKeys.has(deduplicationKey)) return Result.fail(undefined)
          seenKeys.add(deduplicationKey)
          const turnId = row.turn_id ?? undefined
          let tools: string[] = []
          if (turnId && !turnsWithToolsEmitted.has(turnId)) {
            const turnTools = toolsByTurn.get(turnId)
            if (turnTools && turnTools.length > 0) {
              tools = turnTools
              turnsWithToolsEmitted.add(turnId)
            }
          }
          const model = row.model_id
          const costUSD = pricing.calculateCost(model, freshInput, output, cacheCreation, cacheRead, 0)
          const selectedTimestamp = timestampRow.completed_at ?? timestampRow.started_at
          const decodedTime = decodeTimestampNumber(selectedTimestamp)
          return Result.succeed({
            provider: 'zcode',
            model,
            inputTokens: freshInput,
            outputTokens: output,
            cacheCreationInputTokens: cacheCreation,
            cacheReadInputTokens: cacheRead,
            cachedInputTokens: 0,
            reasoningTokens: reasoning,
            webSearchRequests: 0,
            costUSD,
            tools,
            bashCommands: [],
            timestamp: epochMsToIso(Result.isSuccess(decodedTime) ? decodedTime.success : null),
            speed: 'standard',
            deduplicationKey,
            turnId,
            userMessage: '',
            sessionId,
          } satisfies ParsedProviderCall)
        }),
      ),
      Stream.filterMap(call => call),
    )
  })

  const parseStream = (): Stream.Stream<ParsedProviderCall, Error> => Stream.unwrap(parseEffect())
  return {
    parseStream,
    // Remove when scan/parser and external iterator callers have migrated to parseStream.
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      yield* Stream.toAsyncIterable(parseStream())
    },
  }
}

export function createZcodeProvider(dbPathOverride?: string): Provider {
  const dbPath = getDbPath(dbPathOverride)
  return {
    name: 'zcode',
    displayName: 'ZCode',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    discoverSessionsEffect(context?: ProviderScanContext) {
      return discoverSessionsEffect(dbPath, context)
    },
    // Remove when every discovery caller uses the native Effect entry point.
    discoverSessions(context?: ProviderScanContext): Promise<SessionSource[]> {
      // eslint-disable-next-line no-restricted-syntax
      return Effect.runPromise(discoverSessionsEffect(dbPath, context))
    },

    createSessionParser(
      source: SessionSource,
      seenKeys: Set<string>,
      _dateRange?: DateRange,
      context?: ProviderScanContext,
    ): SessionParser {
      return createParser(source, seenKeys, context)
    },
  }
}

export const zcode = createZcodeProvider()
