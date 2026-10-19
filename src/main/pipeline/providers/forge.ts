import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import { extractBashCommands } from '../bash-utils.js'
import { reportProviderIssue } from '../file-errors.js'
import { captureScanPricing } from '../models.js'
import { checkScanAbort } from '../scan-io.js'
import { blobToText, isSqliteAvailable, openDatabase, type SqliteDatabase } from '../sqlite.js'
import type { DateRange } from '../types.js'
import type { ParsedProviderCall, Provider, ProviderScanContext, SessionParser, SessionSource } from './types.js'

const DEFAULT_DB_PATH = join(homedir(), '.forge', '.forge.db')

const discoveryRowSchema = Schema.Struct({
  conversation_id: Schema.String,
  title: Schema.NullOr(Schema.String),
  workspace_id: Schema.NullOr(Schema.String),
})
const conversationRowSchema = Schema.Struct({
  conversation_id: Schema.String,
  context: Schema.NullOr(Schema.Union([Schema.String, Schema.Uint8Array])),
  created_at: Schema.NullOr(Schema.String),
  updated_at: Schema.NullOr(Schema.String),
})
const contextSchema = Schema.Struct({ messages: Schema.optional(Schema.Unknown) })
const contextJsonSchema = Schema.fromJsonString(contextSchema)
const itemSchema = Schema.Struct({ message: Schema.optional(Schema.Unknown), usage: Schema.optional(Schema.Unknown) })
const messageSchema = Schema.Struct({
  text: Schema.optional(Schema.Unknown),
})
const textSchema = Schema.Struct({
  role: Schema.optional(Schema.Unknown),
  content: Schema.optional(Schema.Unknown),
  model: Schema.optional(Schema.Unknown),
  tool_calls: Schema.optional(Schema.Unknown),
})
const recordSchema = Schema.Record(Schema.String, Schema.Unknown)
const callSchema = Schema.Struct({
  name: Schema.optional(Schema.Unknown),
  call_id: Schema.optional(Schema.Unknown),
  arguments: Schema.optional(Schema.Unknown),
})
const argsSchema = Schema.Struct({ command: Schema.optional(Schema.Unknown) })
const actualSchema = Schema.Struct({ actual: Schema.optional(Schema.Finite) })
const decodeDiscoveryRow = Schema.decodeUnknownResult(discoveryRowSchema)
const decodeConversationRow = Schema.decodeUnknownResult(conversationRowSchema)
const decodeContext = Schema.decodeUnknownResult(contextJsonSchema)
const decodeItem = Schema.decodeUnknownResult(itemSchema)
const decodeMessage = Schema.decodeUnknownResult(messageSchema)
const decodeText = Schema.decodeUnknownResult(textSchema)
const decodeRecord = Schema.decodeUnknownResult(recordSchema)
const decodeCall = Schema.decodeUnknownResult(callSchema)
const decodeArgs = Schema.decodeUnknownResult(argsSchema)
const decodeActual = Schema.decodeUnknownResult(actualSchema)
const decodeString = Schema.decodeUnknownResult(Schema.String)
const decodeFinite = Schema.decodeUnknownResult(Schema.Finite)
const decodeMessages = Schema.decodeUnknownResult(Schema.Array(Schema.Unknown))
const decodeToolCalls = Schema.decodeUnknownResult(Schema.Array(Schema.Unknown))

type ForgeDatabase = { db: SqliteDatabase; closed: boolean }

function sqliteTimestampToIso(value: string | null | undefined): string {
  if (!value) return new Date(0).toISOString()
  const match = value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?$/)
  if (match) {
    const ms = (match[3] ?? '').padEnd(3, '0').slice(0, 3)
    const parsed = new Date(`${match[1]}T${match[2]}.${ms}Z`)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString()
}

function validateSchema(db: SqliteDatabase): Effect.Effect<boolean> {
  return Effect.try({
    try: () =>
      db.query(
        'SELECT conversation_id, title, CAST(workspace_id AS TEXT) AS workspace_id, context, created_at, updated_at FROM conversations WHERE 0',
      ),
    catch: cause => databaseError('read', cause),
  }).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  )
}

function record(value: unknown): Record<string, unknown> | undefined {
  const result = decodeRecord(value)
  return Result.isSuccess(result) ? result.success : undefined
}

function string(value: unknown): string | undefined {
  const result = decodeString(value)
  return Result.isSuccess(result) ? result.success : undefined
}

function finite(value: unknown): number | undefined {
  const result = decodeFinite(value)
  return Result.isSuccess(result) ? result.success : undefined
}

function usageActual(usage: unknown, key: string): number {
  const values = record(usage)
  const result = values && decodeActual(values[key])
  const fields = result && Result.isSuccess(result) ? result.success : undefined
  return finite(fields?.actual) ?? 0
}

function mapToolName(name: string): string {
  switch (name) {
    case 'shell':
    case 'bash':
      return 'Bash'
    case 'read':
    case 'Read':
      return 'Read'
    case 'write':
    case 'Write':
      return 'Write'
    case 'patch':
    case 'Edit':
    case 'edit':
      return 'Edit'
    case 'fs_search':
    case 'grep':
      return 'Grep'
    case 'task':
    case 'dispatch_agent':
      return 'Agent'
    default:
      return name
  }
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value)
}

function extractToolsAndCommands(value: unknown): { tools: string[]; bashCommands: string[]; firstCallId?: string } {
  const tools: string[] = []
  const bashCommands: string[] = []
  let firstCallId: string | undefined
  const decodedCalls = decodeToolCalls(value)
  if (Result.isFailure(decodedCalls)) return { tools, bashCommands }
  for (const item of decodedCalls.success) {
    const result = decodeCall(item)
    if (Result.isFailure(result)) continue
    const call = result.success
    const name = string(call?.name)
    if (!name) continue
    const callId = string(call?.call_id)
    if (!firstCallId && callId) firstCallId = callId
    const tool = mapToolName(name)
    pushUnique(tools, tool)
    if (tool === 'Bash') {
      const argsResult = decodeArgs(call.arguments)
      const args = Result.isSuccess(argsResult) ? argsResult.success : undefined
      const command = string(args?.command)
      if (command) for (const extracted of extractBashCommands(command)) pushUnique(bashCommands, extracted)
    }
  }
  return { tools, bashCommands, firstCallId }
}

function splitSourcePath(path: string): { dbPath: string; conversationId: string } | undefined {
  const index = path.lastIndexOf(':')
  return index < 0 ? undefined : { dbPath: path.slice(0, index), conversationId: path.slice(index + 1) }
}

class ForgeDatabaseError extends Schema.TaggedError<ForgeDatabaseError>()('ForgeDatabaseError', {
  operation: Schema.Literals(['open', 'read', 'close']),
  cause: Schema.Defect(),
  message: Schema.String,
}) {}

function databaseError(operation: ForgeDatabaseError['operation'], cause: unknown): ForgeDatabaseError {
  const error = cause instanceof Error ? cause : new Error(String(cause), { cause })
  return new ForgeDatabaseError({ operation, cause: error, message: error.message })
}

function closeDatabase(source: ForgeDatabase): Effect.Effect<void, ForgeDatabaseError> {
  return Effect.suspend(() => {
    if (source.closed) return Effect.void
    source.closed = true
    return Effect.try({ try: () => source.db.close(), catch: cause => databaseError('close', cause) })
  })
}

function acquireDatabase(path: string): Effect.Effect<ForgeDatabase | null, never> {
  return Effect.try({
    try: () => ({ db: openDatabase(path), closed: false }),
    catch: cause => databaseError('open', cause),
  }).pipe(Effect.catchTag('ForgeDatabaseError', () => Effect.succeed(null)))
}

function createParser(source: SessionSource, seenKeys: Set<string>, context?: ProviderScanContext): SessionParser {
  const pricing = context?.pricing ?? captureScanPricing()
  const signal = context?.signal
  const parseStream = (): Stream.Stream<ParsedProviderCall, Error> =>
    Stream.scoped(
      Stream.unwrap(
        Effect.gen(function* () {
          yield* checkScanAbort(signal)
          if (!isSqliteAvailable()) {
            reportProviderIssue('forge', 'sqlite-unavailable')
            return Stream.empty
          }
          const split = splitSourcePath(source.path)
          if (!split) return Stream.empty
          const acquired = yield* Effect.acquireRelease(acquireDatabase(split.dbPath), source =>
            source ? closeDatabase(source).pipe(Effect.orDie) : Effect.void,
          )
          if (!acquired) return Stream.empty
          const db = acquired.db
          const finishEmpty = () => Stream.fromEffectDrain(closeDatabase(acquired))
          if (!(yield* validateSchema(db))) return finishEmpty()
          yield* checkScanAbort(signal)
          const rows = yield* Effect.try({
            try: () =>
              db.query(
                'SELECT conversation_id, CAST(context AS BLOB) AS context, created_at, updated_at FROM conversations WHERE conversation_id = ?',
                [split.conversationId],
              ),
            catch: cause => databaseError('read', cause),
          })
          yield* checkScanAbort(signal)
          const rowResult = decodeConversationRow(rows[0])
          const row = Result.isSuccess(rowResult) ? rowResult.success : undefined
          if (!row?.context) return finishEmpty()
          const payloadResult = decodeContext(blobToText(row.context))
          const payload = Result.isSuccess(payloadResult) ? payloadResult.success : undefined
          const decodedMessages = decodeMessages(payload?.messages)
          const messages = Result.isSuccess(decodedMessages) ? decodedMessages.success : []
          let index = 0
          let userMessage = ''
          return Stream.fromIterable(messages).pipe(
            Stream.rechunk(1),
            Stream.mapEffect(item =>
              Effect.gen(function* () {
                yield* checkScanAbort(signal)
                const currentIndex = index++
                const entryResult = decodeItem(item)
                const entry = Result.isSuccess(entryResult) ? entryResult.success : undefined
                const messageResult = entry && decodeMessage(entry.message)
                const message = messageResult && Result.isSuccess(messageResult) ? messageResult.success : undefined
                const textResult = message && decodeText(message.text)
                const text = textResult && Result.isSuccess(textResult) ? textResult.success : undefined
                const role = string(text?.role)?.toLowerCase() ?? ''
                const content = string(text?.content) ?? ''
                if (role === 'user') {
                  userMessage = content.length > 500 ? content.slice(0, 500) : content
                  return Result.fail(undefined)
                }
                if (role !== 'assistant' || !entry) return Result.fail(undefined)
                const promptTokens = usageActual(entry.usage, 'prompt_tokens')
                const outputTokens = usageActual(entry.usage, 'completion_tokens')
                const cachedInputTokens = usageActual(entry.usage, 'cached_tokens')
                const inputTokens = Math.max(0, promptTokens - cachedInputTokens)
                if (inputTokens === 0 && outputTokens === 0) return Result.fail(undefined)
                const model = string(text?.model) ?? 'unknown'
                const { tools, bashCommands, firstCallId } = extractToolsAndCommands(text?.tool_calls)
                const stableId = firstCallId ?? `${model}:${promptTokens}:${outputTokens}:${currentIndex}`
                const deduplicationKey = `forge:${row.conversation_id}:${stableId}`
                if (seenKeys.has(deduplicationKey)) return Result.fail(undefined)
                seenKeys.add(deduplicationKey)
                yield* checkScanAbort(signal)
                const costUSD = yield* Effect.try({
                  try: () => pricing.calculateCost(model, inputTokens, outputTokens, 0, cachedInputTokens, 0),
                  catch: cause => (cause instanceof Error ? cause : new Error(String(cause), { cause })),
                })
                yield* checkScanAbort(signal)
                return Result.succeed({
                  provider: 'forge' as const,
                  model,
                  inputTokens,
                  outputTokens,
                  cacheCreationInputTokens: 0,
                  cacheReadInputTokens: cachedInputTokens,
                  cachedInputTokens,
                  reasoningTokens: 0,
                  webSearchRequests: 0,
                  costUSD,
                  tools,
                  bashCommands,
                  timestamp: sqliteTimestampToIso(row.updated_at ?? row.created_at),
                  speed: 'standard' as const,
                  deduplicationKey,
                  userMessage,
                  sessionId: row.conversation_id,
                })
              }),
            ),
            Stream.filterMap(value => value),
            Stream.concat(Stream.fromEffectDrain(closeDatabase(acquired))),
          )
        }),
      ),
    )
  return {
    parseStream,
  }
}

function discoverFromDb(dbPath: string, context?: ProviderScanContext): Effect.Effect<SessionSource[], Error> {
  return Effect.scoped(
    Effect.gen(function* () {
      yield* checkScanAbort(context?.signal)
      if (!isSqliteAvailable()) return []
      if (!existsSync(dbPath)) return []

      const acquired = yield* Effect.acquireRelease(acquireDatabase(dbPath), source =>
        source ? closeDatabase(source).pipe(Effect.orDie) : Effect.void,
      )
      if (!acquired) return []
      const db = acquired.db
      if (!(yield* validateSchema(db))) {
        yield* closeDatabase(acquired)
        yield* checkScanAbort(context?.signal)
        return []
      }

      yield* checkScanAbort(context?.signal)
      const rows = yield* Effect.try({
        try: () =>
          db.query(
            'SELECT conversation_id, title, CAST(workspace_id AS TEXT) AS workspace_id FROM conversations WHERE context IS NOT NULL',
          ),
        catch: cause => databaseError('read', cause),
      }).pipe(Effect.catchTag('ForgeDatabaseError', () => Effect.succeed(null)))
      yield* checkScanAbort(context?.signal)

      const sessions =
        rows?.flatMap(value => {
          const rowResult = decodeDiscoveryRow(value)
          const row = Result.isSuccess(rowResult) ? rowResult.success : undefined
          return row
            ? [
                {
                  path: `${dbPath}:${row.conversation_id}`,
                  project: row.title ?? String(row.workspace_id),
                  provider: 'forge' as const,
                },
              ]
            : []
        }) ?? []
      yield* closeDatabase(acquired)
      yield* checkScanAbort(context?.signal)
      return sessions
    }),
  )
}

export function createForgeProvider(dbPath = DEFAULT_DB_PATH): Provider {
  return {
    name: 'forge',
    displayName: 'Forge',
    modelDisplayName: model => model,
    toolDisplayName: rawTool => rawTool,
    discoverSessionsEffect: context => discoverFromDb(dbPath, context),
    createSessionParser: (
      source: SessionSource,
      seenKeys: Set<string>,
      _dateRange?: DateRange,
      context?: ProviderScanContext,
    ) => createParser(source, seenKeys, context),
  }
}

export const forge = createForgeProvider()
