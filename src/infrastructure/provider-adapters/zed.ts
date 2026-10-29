import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import zlib from 'zlib'

import { fileErrorCode, queueLogRecord, reportProviderIssue } from '@/infrastructure/ingestion/file-errors.js'
import { captureScanPricing } from '@/infrastructure/pricing/models.js'
import { checkScanAbort } from '@/infrastructure/ingestion/scan-io.js'
import type { ScanPricing } from '@/core/domain/pricing/scan-pricing.js'
import { isSqliteAvailable, openDatabase, type SqliteDatabase } from '@/infrastructure/ingestion/sqlite.js'
import type { DateRange } from '@/core/domain/observations/types.js'
import type {
  ParsedProviderCall,
  Provider,
  ProviderScanContext,
  SessionParser,
  SessionSource,
} from '@/infrastructure/provider-adapters/types.js'

// Zed's built-in agent stores one row per thread in a single SQLite database;
// the data blob is zstd-compressed JSON carrying per-request token counts.
const zstdDecompress = (zlib as { zstdDecompressSync?: (buf: Buffer) => Buffer }).zstdDecompressSync
type ZstdDecompress = NonNullable<typeof zstdDecompress>

function getZedThreadsDbPath(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Zed', 'threads', 'threads.db')
  }
  if (process.platform === 'win32') {
    return join(homedir(), 'AppData', 'Local', 'Zed', 'threads', 'threads.db')
  }
  return join(homedir(), '.local', 'share', 'zed', 'threads', 'threads.db')
}

const threadRowSchema = Schema.Struct({
  id: Schema.Unknown,
  summary: Schema.Unknown,
  updated_at: Schema.Unknown,
  data_type: Schema.Unknown,
  data: Schema.Unknown,
})
const tokenUsageSchema = Schema.Struct({
  input_tokens: Schema.optional(Schema.Unknown),
  output_tokens: Schema.optional(Schema.Unknown),
  cache_creation_input_tokens: Schema.optional(Schema.Unknown),
  cache_read_input_tokens: Schema.optional(Schema.Unknown),
})
const modelSchema = Schema.Struct({ model: Schema.optional(Schema.Unknown) })
const requestUsageSchema = Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Array(Schema.Unknown)])
const threadSchema = Schema.Struct({
  model: Schema.optional(Schema.Unknown),
  request_token_usage: Schema.optional(Schema.Unknown),
  cumulative_token_usage: Schema.optional(Schema.Unknown),
})
const databaseBlobSchema = Schema.Union([Schema.String, Schema.Uint8Array])
const timestampSchema = Schema.Union([Schema.String, Schema.Finite])
const threadJsonSchema = Schema.fromJsonString(threadSchema)
const decodeThreadRow = Schema.decodeUnknownResult(threadRowSchema)
const decodeTokenUsage = Schema.decodeUnknownResult(tokenUsageSchema)
const decodeModel = Schema.decodeUnknownResult(modelSchema)
const decodeRequestUsage = Schema.decodeUnknownResult(requestUsageSchema)
const decodeThreadJson = Schema.decodeUnknownResult(threadJsonSchema)
const decodeDatabaseBlob = Schema.decodeUnknownResult(databaseBlobSchema)
const decodeTimestamp = Schema.decodeUnknownResult(timestampSchema)
const decodeString = Schema.decodeUnknownResult(Schema.String)
const decodeFinite = Schema.decodeUnknownResult(Schema.Finite)
const decodeRecord = Schema.decodeUnknownResult(Schema.Record(Schema.String, Schema.Unknown))

type TokenUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

type ParsedThread = {
  readonly threadId: string
  readonly model: string | undefined
  readonly userMessage: string | undefined
  readonly timestamp: string
  readonly usageEntries: ReadonlyArray<readonly [string, TokenUsage]>
}

type ThreadRowResult =
  | { readonly _tag: 'Parsed'; readonly thread: ParsedThread }
  | { readonly _tag: 'Skipped' }
  | { readonly _tag: 'Ignore' }

function record(value: unknown): Record<string, unknown> | undefined {
  const decoded = decodeRecord(value)
  return Result.isSuccess(decoded) ? decoded.success : undefined
}

function field(value: unknown, key: string): unknown {
  return record(value)?.[key]
}

function finiteNonNegative(value: unknown): number {
  const decoded = decodeFinite(value)
  return Result.isSuccess(decoded) && decoded.success >= 0 ? decoded.success : 0
}

function usageFromUnknown(value: unknown): TokenUsage {
  const decoded = decodeTokenUsage(value)
  if (Result.isFailure(decoded)) {
    return { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  }
  return {
    input_tokens: finiteNonNegative(decoded.success.input_tokens),
    output_tokens: finiteNonNegative(decoded.success.output_tokens),
    cache_creation_input_tokens: finiteNonNegative(decoded.success.cache_creation_input_tokens),
    cache_read_input_tokens: finiteNonNegative(decoded.success.cache_read_input_tokens),
  }
}

function requestEntries(value: unknown): Array<readonly [string, unknown]> {
  const decoded = decodeRequestUsage(value)
  if (Result.isFailure(decoded)) return []
  if (Array.isArray(decoded.success)) {
    return decoded.success.map((usage, index) => [String(index), usage] as const)
  }
  return Object.entries(decoded.success)
}

function usageIsEmpty(usage: TokenUsage): boolean {
  return (
    usage.input_tokens === 0 &&
    usage.output_tokens === 0 &&
    usage.cache_creation_input_tokens === 0 &&
    usage.cache_read_input_tokens === 0
  )
}

function buildCall(opts: {
  threadId: string
  requestKey: string
  usage: TokenUsage
  model: string
  timestamp: string
  userMessage: string
  pricing: ScanPricing
}): ParsedProviderCall {
  const {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
  } = opts.usage
  return {
    provider: 'zed',
    model: opts.model,
    inputTokens: input,
    outputTokens: output,
    cacheCreationInputTokens: cacheWrite,
    cacheReadInputTokens: cacheRead,
    cachedInputTokens: cacheRead,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costUSD: opts.pricing.calculateCost(opts.model, input, output, cacheWrite, cacheRead, 0),
    tools: [],
    bashCommands: [],
    timestamp: opts.timestamp,
    speed: 'standard',
    deduplicationKey: `zed:${opts.threadId}:${opts.requestKey}`,
    userMessage: opts.userMessage,
    sessionId: opts.threadId,
  }
}

function readThreadRows(db: SqliteDatabase): unknown[] {
  try {
    return db.query('SELECT id, summary, updated_at, data_type, data FROM threads ORDER BY updated_at ASC')
  } catch {
    return []
  }
}

function parseThreadRow(candidate: unknown, decompress: ZstdDecompress): ThreadRowResult {
  const rowResult = decodeThreadRow(candidate)
  if (Result.isFailure(rowResult)) {
    return field(candidate, 'data') != null ? { _tag: 'Skipped' } : { _tag: 'Ignore' }
  }
  const row = rowResult.success
  const idResult = decodeString(row.id)
  const typeResult = decodeString(row.data_type)
  const dataResult = decodeDatabaseBlob(row.data)
  if (
    Result.isFailure(idResult) ||
    !idResult.success ||
    Result.isFailure(dataResult) ||
    !dataResult.success ||
    Result.isFailure(typeResult) ||
    (typeResult.success !== 'zstd' && typeResult.success !== 'json')
  ) {
    return row.data != null ? { _tag: 'Skipped' } : { _tag: 'Ignore' }
  }

  const updatedAt = row.updated_at == null ? '' : row.updated_at
  const decodedTimestamp = decodeTimestamp(updatedAt)
  if (Result.isFailure(decodedTimestamp)) return { _tag: 'Ignore' }
  const timestampDate = new Date(decodedTimestamp.success)
  if (Number.isNaN(timestampDate.getTime())) return { _tag: 'Ignore' }
  const timestamp = timestampDate.toISOString()

  let jsonText: string
  try {
    jsonText =
      typeResult.success === 'zstd'
        ? decompress(Buffer.from(dataResult.success)).toString('utf-8')
        : Buffer.from(dataResult.success).toString('utf-8')
  } catch {
    return { _tag: 'Skipped' }
  }

  const threadResult = decodeThreadJson(jsonText)
  if (Result.isFailure(threadResult)) return { _tag: 'Skipped' }
  const thread = threadResult.success

  const modelEnvelope = decodeModel(thread.model)
  const rawModel = Result.isSuccess(modelEnvelope) ? modelEnvelope.success.model : undefined
  const modelResult = decodeString(rawModel || 'unknown')
  const summaryResult = decodeString(row.summary ?? '')
  const normalizedRequests = requestEntries(thread.request_token_usage).flatMap(([requestKey, rawUsage]) => {
    if (rawUsage == null) return []
    const usage = usageFromUnknown(rawUsage)
    return usageIsEmpty(usage) ? [] : [[requestKey, usage] as const]
  })

  const cumulativeValue = thread.cumulative_token_usage
  const cumulative = cumulativeValue ? usageFromUnknown(cumulativeValue) : undefined
  const usageEntries: Array<readonly [string, TokenUsage]> = [...normalizedRequests]
  if (cumulative && !usageIsEmpty(cumulative)) {
    const sum = normalizedRequests.reduce(
      (total, [, usage]) => ({
        input_tokens: total.input_tokens + usage.input_tokens,
        output_tokens: total.output_tokens + usage.output_tokens,
        cache_creation_input_tokens: total.cache_creation_input_tokens + usage.cache_creation_input_tokens,
        cache_read_input_tokens: total.cache_read_input_tokens + usage.cache_read_input_tokens,
      }),
      { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    )
    const remainder: TokenUsage = {
      input_tokens: Math.max(0, cumulative.input_tokens - sum.input_tokens),
      output_tokens: Math.max(0, cumulative.output_tokens - sum.output_tokens),
      cache_creation_input_tokens: Math.max(
        0,
        cumulative.cache_creation_input_tokens - sum.cache_creation_input_tokens,
      ),
      cache_read_input_tokens: Math.max(0, cumulative.cache_read_input_tokens - sum.cache_read_input_tokens),
    }
    if (!usageIsEmpty(remainder)) usageEntries.push(['cumulative-remainder', remainder])
  }

  return {
    _tag: 'Parsed',
    thread: {
      threadId: idResult.success,
      model: Result.isSuccess(modelResult) ? modelResult.success : undefined,
      userMessage: Result.isSuccess(summaryResult) ? summaryResult.success : undefined,
      timestamp,
      usageEntries,
    },
  }
}

function skippedLog(count: number): void {
  if (count === 0) return
  queueLogRecord({
    logEvent: 'scan.file-error',
    level: 'warn',
    fields: { op: 'scan', provider: 'zed', code: 'entries-unreadable', count },
  })
}

function threadStream(
  candidate: unknown,
  seenKeys: Set<string>,
  pricing: ScanPricing,
  signal: AbortSignal | undefined,
  onUnparsedCall: Effect.Effect<void> | undefined,
  state: { skipped: number },
  decompress: ZstdDecompress,
): Stream.Stream<ParsedProviderCall, Error> {
  const parsed = parseThreadRow(candidate, decompress)
  if (parsed._tag === 'Ignore') return Stream.empty
  if (parsed._tag === 'Skipped') {
    state.skipped++
    return Stream.empty
  }

  const { thread } = parsed
  let pricingFailed = false
  return Stream.fromIterable(thread.usageEntries).pipe(
    Stream.mapEffect(([requestKey, usage]) =>
      Effect.gen(function* () {
        yield* checkScanAbort(signal)
        if (pricingFailed) return Result.fail(undefined)
        const key = `zed:${thread.threadId}:${requestKey}`
        const model = thread.model
        const userMessage = thread.userMessage
        if (model === undefined || userMessage === undefined) {
          if (!seenKeys.has(key)) {
            seenKeys.add(key)
            if (onUnparsedCall) yield* onUnparsedCall
          }
          return Result.fail(undefined)
        }
        const callResult = yield* Effect.result(
          Effect.try({
            try: () =>
              buildCall({
                threadId: thread.threadId,
                requestKey,
                usage,
                model,
                timestamp: thread.timestamp,
                userMessage,
                pricing,
              }),
            catch: cause => (cause instanceof Error ? cause : new Error(String(cause), { cause })),
          }),
        )
        if (Result.isFailure(callResult)) {
          pricingFailed = true
          state.skipped++
          return Result.fail(undefined)
        }

        const call = callResult.success
        if (seenKeys.has(call.deduplicationKey)) return Result.fail(undefined)
        seenKeys.add(call.deduplicationKey)
        return Result.succeed(call)
      }),
    ),
    Stream.filterMap(value => value),
  )
}

class ZedDatabaseError extends Schema.TaggedError<ZedDatabaseError>()('ZedDatabaseError', {
  operation: Schema.Literals(['open', 'close']),
  cause: Schema.Defect(),
  message: Schema.String,
}) {}

function databaseError(operation: ZedDatabaseError['operation'], cause: unknown): ZedDatabaseError {
  const error = cause instanceof Error ? cause : new Error(String(cause), { cause })
  return new ZedDatabaseError({ operation, cause: error, message: error.message })
}

type OwnedDatabase = { readonly db: SqliteDatabase; closed: boolean }

function closeDatabase(owned: OwnedDatabase): Effect.Effect<void, ZedDatabaseError> {
  return Effect.suspend(() => {
    if (owned.closed) return Effect.void
    owned.closed = true
    return Effect.try({
      try: () => owned.db.close(),
      catch: cause => databaseError('close', cause),
    })
  })
}

type ParserState = { skipped: number }

function releaseDatabase(owned: OwnedDatabase & ParserState): Effect.Effect<void> {
  return Effect.ensuring(
    closeDatabase(owned).pipe(Effect.orDie),
    Effect.sync(() => skippedLog(owned.skipped)),
  )
}

function createParser(
  source: SessionSource,
  seenKeys: Set<string>,
  pricing: ScanPricing,
  signal?: AbortSignal,
): SessionParser {
  const parseStream: NonNullable<SessionParser['parseStream']> = onUnparsedCall =>
    Stream.scoped(
      Stream.unwrap(
        Effect.gen(function* () {
          yield* checkScanAbort(signal)
          if (!isSqliteAvailable()) {
            reportProviderIssue('zed', 'sqlite-unavailable')
            return Stream.empty
          }
          if (!zstdDecompress) {
            reportProviderIssue('zed', 'zstd-unavailable')
            return Stream.empty
          }
          const decompress = zstdDecompress

          const acquired = yield* Effect.acquireRelease(
            Effect.try({
              try: () => ({ db: openDatabase(source.path), closed: false, skipped: 0 }),
              catch: cause => databaseError('open', cause),
            }).pipe(
              Effect.catchTag('ZedDatabaseError', error => {
                reportProviderIssue('zed', fileErrorCode(error.cause, 'db-open-failed'))
                return Effect.succeed(null)
              }),
            ),
            owned => (owned ? releaseDatabase(owned) : Effect.void),
          )
          if (!acquired) return Stream.empty

          yield* checkScanAbort(signal)
          const rows = readThreadRows(acquired.db)
          const output = Stream.fromIterable(rows).pipe(
            Stream.flatMap(candidate =>
              threadStream(candidate, seenKeys, pricing, signal, onUnparsedCall, acquired, decompress),
            ),
          )
          return Stream.concat(output, Stream.fromEffectDrain(closeDatabase(acquired)))
        }),
      ),
    )

  return {
    parseStream,
  }
}

const discoverSessionsEffect = Effect.fn('discoverZedSessions')(function* (
  dbPathOverride?: string,
  context?: ProviderScanContext,
): Effect.fn.Return<SessionSource[], Error> {
  yield* checkScanAbort(context?.signal)
  if (!isSqliteAvailable()) return []
  const dbPath = dbPathOverride ?? getZedThreadsDbPath()
  const exists = yield* Effect.try({
    try: () => existsSync(dbPath),
    catch: cause => (cause instanceof Error ? cause : new Error(String(cause), { cause })),
  })
  yield* checkScanAbort(context?.signal)
  return exists ? [{ path: dbPath, project: 'zed', provider: 'zed' }] : []
})

export function createZedProvider(dbPathOverride?: string): Provider {
  return {
    name: 'zed',
    displayName: 'Zed',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    discoverSessionsEffect: context => discoverSessionsEffect(dbPathOverride, context),

    createSessionParser(
      source: SessionSource,
      seenKeys: Set<string>,
      _dateRange?: DateRange,
      context?: ProviderScanContext,
    ): SessionParser {
      const pricing = context?.pricing ?? captureScanPricing()
      return createParser(source, seenKeys, pricing, context?.signal)
    },
  }
}

export const zed = createZedProvider()
