import { homedir, platform } from 'node:os'
import { join } from 'node:path'

import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'

import { type AppPaths, overrideFor, platformFor } from '@/infrastructure/config/environment.js'
import { extractBashCommands } from '@/core/ingestion/parsers/bash-utils.js'
import { fileErrorCode, reportProviderIssue } from '@/infrastructure/ingestion/file-errors.js'
import { captureScanPricing, getShortModelName } from '@/infrastructure/pricing/models.js'
import { checkScanAbort } from '@/infrastructure/ingestion/scan-io.js'
import { blobToText, isSqliteAvailable, openDatabase, type SqliteDatabase } from '@/infrastructure/ingestion/sqlite.js'
import type { ToolCall } from '@/core/domain/observations/types.js'
import type { DateRange } from '@/core/domain/observations/types.js'
import type {
  ParsedProviderCall,
  Provider,
  ProviderScanContext,
  SessionParser,
  SessionSource,
} from '@/infrastructure/provider-adapters/types.js'

const sessionRowSchema = Schema.Struct({
  created_at: Schema.Unknown,
  updated_at: Schema.Unknown,
  accumulated_input_tokens: Schema.Unknown,
  accumulated_output_tokens: Schema.Unknown,
  model_config_json: Schema.Unknown,
})
const discoveryRowSchema = Schema.Struct({
  id: Schema.String,
  working_dir: Schema.NullOr(Schema.String),
  accumulated_input_tokens: Schema.NullOr(Schema.Finite),
  accumulated_output_tokens: Schema.NullOr(Schema.Finite),
})
const modelConfigSchema = Schema.fromJsonString(Schema.Struct({ model_name: Schema.optional(Schema.Unknown) }))
const modelConfigValueSchema = Schema.NullOr(Schema.Union([Schema.String, Schema.Uint8Array]))
const contentItemsSchema = Schema.fromJsonString(Schema.Array(Schema.Unknown))
const contentItemSchema = Schema.Struct({
  type: Schema.optional(Schema.Unknown),
  text: Schema.optional(Schema.Unknown),
  toolCall: Schema.optional(Schema.Unknown),
})
const toolCallSchema = Schema.Struct({ value: Schema.optional(Schema.Unknown) })
const toolCallValueSchema = Schema.Struct({
  name: Schema.optional(Schema.Unknown),
  arguments: Schema.optional(Schema.Unknown),
})
const toolArgumentsSchema = Schema.Struct({
  file_path: Schema.optional(Schema.Unknown),
  command: Schema.optional(Schema.Unknown),
})
const decodeSessionRow = Schema.decodeUnknownResult(sessionRowSchema)
const decodeDiscoveryRow = Schema.decodeUnknownResult(discoveryRowSchema)
const decodeModelConfig = Schema.decodeUnknownResult(modelConfigSchema)
const decodeModelConfigValue = Schema.decodeUnknownResult(modelConfigValueSchema)
const decodeContentItems = Schema.decodeUnknownResult(contentItemsSchema)
const decodeContentItem = Schema.decodeUnknownResult(contentItemSchema)
const decodeToolCall = Schema.decodeUnknownResult(toolCallSchema)
const decodeToolCallValue = Schema.decodeUnknownResult(toolCallValueSchema)
const decodeToolArguments = Schema.decodeUnknownResult(toolArgumentsSchema)
const decodeString = Schema.decodeUnknownResult(Schema.String)
const decodeFinite = Schema.decodeUnknownResult(Schema.Finite)
const decodeTimestampValue = Schema.decodeUnknownResult(Schema.Union([Schema.String, Schema.Finite]))

function sessionTimestamp(raw: unknown, nowMs: number): Date {
  const decodedTimestamp = decodeTimestampValue(raw)
  const dateInput = Result.isSuccess(decodedTimestamp) ? decodedTimestamp.success : String(raw)
  let timestamp = new Date(dateInput)
  if (Number.isNaN(timestamp.getTime())) timestamp = new Date(`${String(raw)}Z`)
  if (Number.isNaN(timestamp.getTime())) timestamp = new Date(nowMs)
  return timestamp
}

type GooseDatabase = { db: SqliteDatabase; closed: boolean }
type DatabaseAcquisition = { database: GooseDatabase | null; error: GooseDatabaseError | null }

const toolNameMap: Record<string, string> = {
  developer__shell: 'Bash',
  developer__text_editor: 'Edit',
  developer__read_file: 'Read',
  developer__write_file: 'Write',
  developer__list_directory: 'LS',
  developer__search_files: 'Grep',
  computercontroller__shell: 'Bash',
}

function sanitize(dir: string): string {
  return dir.replace(/^\//, '').replace(/\//g, '-')
}

export function getGooseDbPath(paths?: AppPaths): string {
  const root = overrideFor(paths, 'GOOSE_PATH_ROOT')
  if (root) return join(root, 'data', 'sessions', 'sessions.db')

  if (platform() === 'darwin' || platform() === 'linux') {
    const base = platformFor(paths).xdgDataHome ?? join(homedir(), '.local', 'share')
    return join(base, 'goose', 'sessions', 'sessions.db')
  }
  return join(homedir(), 'AppData', 'Roaming', 'Block', 'goose', 'sessions', 'sessions.db')
}

class GooseDatabaseError extends Schema.TaggedError<GooseDatabaseError>()('GooseDatabaseError', {
  operation: Schema.Literals(['open', 'read', 'close']),
  cause: Schema.Defect(),
  message: Schema.String,
}) {}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause), { cause })
}

function databaseError(operation: GooseDatabaseError['operation'], cause: unknown): GooseDatabaseError {
  const error = toError(cause)
  return new GooseDatabaseError({ operation, cause: error, message: error.message })
}

function validateSchema(db: SqliteDatabase): Effect.Effect<boolean> {
  return Effect.try({
    try: () => {
      db.query('SELECT 1 FROM sessions WHERE 0')
      db.query('SELECT 1 FROM messages WHERE 0')
      return true
    },
    catch: cause => databaseError('read', cause),
  }).pipe(Effect.catch(() => Effect.succeed(false)))
}

function closeDatabase(source: GooseDatabase): Effect.Effect<void, GooseDatabaseError> {
  return Effect.suspend(() => {
    if (source.closed) return Effect.void
    source.closed = true
    return Effect.try({
      try: () => source.db.close(),
      catch: cause => databaseError('close', cause),
    })
  })
}

function acquireDatabase(path: string): Effect.Effect<DatabaseAcquisition, never> {
  return Effect.try({
    try: () => ({ db: openDatabase(path), closed: false }),
    catch: cause => databaseError('open', cause),
  }).pipe(
    Effect.map(database => ({ database, error: null })),
    Effect.catchTag('GooseDatabaseError', error => Effect.succeed({ database: null, error })),
  )
}

function splitSourcePath(path: string): { dbPath: string; sessionId: string } | undefined {
  const index = path.lastIndexOf(':')
  return index < 0 ? undefined : { dbPath: path.slice(0, index), sessionId: path.slice(index + 1) }
}

function parseContentItems(raw: Uint8Array | string | null | undefined): unknown[] {
  const decoded = decodeContentItems(blobToText(raw))
  return Result.isSuccess(decoded) ? [...decoded.success] : []
}

function string(value: unknown): string | undefined {
  const decoded = decodeString(value)
  return Result.isSuccess(decoded) ? decoded.success : undefined
}

function extractToolsFromMessages(
  db: SqliteDatabase,
  sessionId: string,
): { tools: string[]; bashCommands: string[]; toolSequence: ToolCall[][] } {
  const tools: string[] = []
  const bashCommands: string[] = []
  const seen = new Set<string>()
  const toolSequence: ToolCall[][] = []

  try {
    const rows = db.query<{ content_json: Uint8Array | string }>(
      "SELECT CAST(content_json AS BLOB) AS content_json FROM messages WHERE session_id = ? AND role = 'assistant' AND content_json LIKE '%toolRequest%' ORDER BY created_timestamp ASC",
      [sessionId],
    )

    for (const row of rows) {
      const calls: ToolCall[] = []
      for (const rawItem of parseContentItems(row.content_json)) {
        const decodedItem = decodeContentItem(rawItem)
        if (Result.isFailure(decodedItem) || string(decodedItem.success.type) !== 'toolRequest') continue

        const decodedToolCall = decodeToolCall(decodedItem.success.toolCall)
        if (Result.isFailure(decodedToolCall)) continue
        const decodedValue = decodeToolCallValue(decodedToolCall.success.value)
        if (Result.isFailure(decodedValue)) continue
        const rawName = string(decodedValue.success.name)
        if (!rawName) continue

        const mapped = toolNameMap[rawName] ?? rawName.split('__').pop() ?? rawName
        if (!seen.has(mapped)) {
          seen.add(mapped)
          tools.push(mapped)
        }
        const call: ToolCall = { tool: mapped }
        const decodedArgs = decodeToolArguments(decodedValue.success.arguments)
        const args = Result.isSuccess(decodedArgs) ? decodedArgs.success : undefined
        const file = string(args?.file_path)
        const command = string(args?.command)
        if (file !== undefined) call.file = file
        if (command !== undefined) call.command = command
        calls.push(call)

        if (mapped === 'Bash' && command !== undefined) {
          for (const extracted of extractBashCommands(command)) {
            if (!bashCommands.includes(extracted)) bashCommands.push(extracted)
          }
        }
      }
      if (calls.length > 0) toolSequence.push(calls)
    }
  } catch {
    // Tool messages are best effort. A damaged sibling message does not discard usage.
  }

  return { tools, bashCommands, toolSequence }
}

function getFirstUserMessage(db: SqliteDatabase, sessionId: string): string {
  try {
    const rows = db.query<{ content_json: Uint8Array | string }>(
      "SELECT CAST(content_json AS BLOB) AS content_json FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_timestamp ASC LIMIT 1",
      [sessionId],
    )
    const first = rows[0]
    if (!first) return ''
    for (const rawItem of parseContentItems(first.content_json)) {
      const decodedItem = decodeContentItem(rawItem)
      if (Result.isFailure(decodedItem) || string(decodedItem.success.type) !== 'text') continue
      return (string(decodedItem.success.text) ?? '').slice(0, 500)
    }
  } catch {
    // The first prompt is optional context and must not block usage extraction.
  }
  return ''
}

function createParser(source: SessionSource, seenKeys: Set<string>, context?: ProviderScanContext): SessionParser {
  const pricing = context?.pricing ?? captureScanPricing()
  const signal = context?.signal

  const parseStream = (onUnparsedCall: Effect.Effect<void> = Effect.void): Stream.Stream<ParsedProviderCall, Error> =>
    Stream.scoped(
      Stream.unwrap(
        Effect.gen(function* () {
          yield* checkScanAbort(signal)
          if (!isSqliteAvailable()) {
            reportProviderIssue('goose', 'sqlite-unavailable')
            return Stream.empty
          }

          const split = splitSourcePath(source.path)
          if (!split) return Stream.empty

          const acquired = yield* Effect.acquireRelease(acquireDatabase(split.dbPath), value =>
            value.database ? closeDatabase(value.database).pipe(Effect.orDie) : Effect.void,
          )
          const database = acquired.database
          if (!database) {
            reportProviderIssue('goose', fileErrorCode(acquired.error?.cause, 'db-open-failed'))
            return Stream.empty
          }

          const finishEmpty = () => Stream.fromEffectDrain(closeDatabase(database))
          const db = database.db
          if (!(yield* validateSchema(db))) return finishEmpty()

          yield* checkScanAbort(signal)
          const rows = yield* Effect.try({
            try: () =>
              db.query(
                'SELECT created_at, updated_at, accumulated_input_tokens, accumulated_output_tokens, CAST(model_config_json AS BLOB) AS model_config_json FROM sessions WHERE id = ?',
                [split.sessionId],
              ),
            catch: cause => databaseError('read', cause),
          })
          yield* checkScanAbort(signal)

          const decodedRow = decodeSessionRow(rows[0])
          if (Result.isFailure(decodedRow)) {
            if (rows.length > 0) yield* onUnparsedCall
            return finishEmpty()
          }
          const session = decodedRow.success
          const rawInputTokens = session.accumulated_input_tokens ?? 0
          const rawOutputTokens = session.accumulated_output_tokens ?? 0
          if (rawInputTokens === 0 && rawOutputTokens === 0) return finishEmpty()

          const deduplicationKey = `goose:${split.sessionId}`
          if (seenKeys.has(deduplicationKey)) return finishEmpty()
          seenKeys.add(deduplicationKey)

          const inputResult = decodeFinite(rawInputTokens)
          const outputResult = decodeFinite(rawOutputTokens)
          if (Result.isFailure(inputResult) || Result.isFailure(outputResult)) {
            yield* onUnparsedCall
            return finishEmpty()
          }
          const inputTokens = inputResult.success
          const outputTokens = outputResult.success

          let model = 'unknown'
          const configValueResult = decodeModelConfigValue(session.model_config_json)
          if (Result.isFailure(configValueResult)) {
            yield* onUnparsedCall
            return finishEmpty()
          }
          if (configValueResult.success !== null) {
            const decodedConfig = decodeModelConfig(blobToText(configValueResult.success))
            if (Result.isSuccess(decodedConfig)) {
              const selectedModel = decodedConfig.success.model_name ?? 'unknown'
              const modelResult = decodeString(selectedModel)
              if (Result.isFailure(modelResult)) {
                yield* onUnparsedCall
                return finishEmpty()
              }
              model = modelResult.success
            }
          }

          const { tools, bashCommands, toolSequence } = extractToolsFromMessages(db, split.sessionId)
          const userMessage = getFirstUserMessage(db, split.sessionId)
          const raw = session.updated_at || session.created_at || ''
          const nowMs = yield* Clock.currentTimeMillis
          const timestamp = sessionTimestamp(raw, nowMs)

          // All SQLite data needed for this call is materialized before pricing.
          yield* closeDatabase(database)
          yield* checkScanAbort(signal)
          const costUSD = yield* Effect.try({
            try: () => pricing.calculateCost(model, inputTokens, outputTokens, 0, 0, 0),
            catch: toError,
          })
          yield* checkScanAbort(signal)

          const call: ParsedProviderCall = {
            provider: 'goose',
            model,
            inputTokens,
            outputTokens,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            cachedInputTokens: 0,
            reasoningTokens: 0,
            webSearchRequests: 0,
            costUSD,
            tools,
            bashCommands,
            toolSequence: toolSequence.length > 1 ? toolSequence : undefined,
            timestamp: timestamp.toISOString(),
            speed: 'standard',
            deduplicationKey,
            userMessage,
            sessionId: split.sessionId,
          }
          return Stream.succeed(call)
        }),
      ),
    )

  return {
    parseStream,
  }
}

function discoverFromDb(dbPath: string, context?: ProviderScanContext) {
  return Effect.scoped(
    Effect.gen(function* () {
      yield* checkScanAbort(context?.signal)
      if (!isSqliteAvailable()) return []

      const acquired = yield* Effect.acquireRelease(acquireDatabase(dbPath), value =>
        value.database ? closeDatabase(value.database).pipe(Effect.orDie) : Effect.void,
      )
      if (!acquired.database) return []

      const db = acquired.database.db
      const result = yield* Effect.result(
        Effect.try({
          try: () =>
            db.query(
              'SELECT id, working_dir, accumulated_input_tokens, accumulated_output_tokens FROM sessions ORDER BY updated_at DESC',
            ),
          catch: cause => databaseError('read', cause),
        }),
      )
      yield* checkScanAbort(context?.signal)
      if (Result.isFailure(result)) {
        yield* closeDatabase(acquired.database)
        return []
      }

      const sessions: SessionSource[] = []
      for (const raw of result.success) {
        const decoded = decodeDiscoveryRow(raw)
        if (Result.isFailure(decoded)) continue
        const row = decoded.success
        if ((row.accumulated_input_tokens ?? 0) <= 0 && (row.accumulated_output_tokens ?? 0) <= 0) continue
        sessions.push({
          path: `${dbPath}:${row.id}`,
          project: row.working_dir ? sanitize(row.working_dir) : 'goose',
          provider: 'goose',
        })
      }

      yield* closeDatabase(acquired.database)
      yield* checkScanAbort(context?.signal)
      return sessions
    }),
  )
}

const modelDisplayNames: Record<string, string> = {
  'gpt-5.5': 'GPT-5.5',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'gpt-4o': 'GPT-4o',
  'gpt-4o-mini': 'GPT-4o Mini',
}

export function createGooseProvider(paths?: AppPaths): Provider {
  const discover = (context?: ProviderScanContext) => discoverFromDb(getGooseDbPath(paths), context)

  return {
    name: 'goose',
    displayName: 'Goose',

    modelDisplayName(model: string): string {
      return modelDisplayNames[model] ?? getShortModelName(model)
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    discoverSessionsEffect: discover,

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

export const goose = createGooseProvider()
