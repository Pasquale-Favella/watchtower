import { homedir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'

import { type AppPaths, overrideFor } from '../../env.js'
import { extractBashCommands } from '../bash-utils.js'
import { fileErrorCode, reportProviderIssue } from '../file-errors.js'
import { captureScanPricing, getShortModelName } from '../models.js'
import { checkScanAbort } from '../scan-io.js'
import { blobToText, isSqliteAvailable, openDatabase, type SqliteDatabase } from '../sqlite.js'
import { estimateTokensFromChars } from '../token-estimate.js'
import type { DateRange } from '../types.js'
import type { ParsedProviderCall, Provider, ProviderScanContext, SessionParser, SessionSource } from './types.js'

const WARP_GROUP_CONTAINER = '2BBY89MBSN.dev.warp'
const WARP_STABLE_BUNDLE_ID = 'dev.warp.Warp-Stable'
const WARP_PREVIEW_BUNDLE_ID = 'dev.warp.Warp-Preview'
const PRIMARY_AGENT_CATEGORY = 'primary_agent'

const modelAliases: Record<string, string> = {
  'Claude Sonnet 4.6': 'claude-sonnet-4-6',
  'Claude Sonnet 4.5': 'claude-sonnet-4-5',
  'Claude Haiku 4.5': 'claude-haiku-4-5',
  'Claude Opus 4.6': 'claude-opus-4-6',
  'GPT-5.3 Codex (low reasoning)': 'gpt-5.3-codex',
  'GPT-5.3 Codex (medium reasoning)': 'gpt-5.3-codex',
  'GPT-5.3 Codex (high reasoning)': 'gpt-5.3-codex',
  'GPT-5.3 Codex (extra high reasoning)': 'gpt-5.3-codex',
  'auto-efficient': 'warp-auto-efficient',
  'auto-powerful': 'warp-auto-powerful',
}

const textValueSchema = Schema.Union([Schema.String, Schema.Uint8Array])
const nullableTextValueSchema = Schema.NullOr(textValueSchema)
const discoveryRowSchema = Schema.Struct({
  conversation_id: textValueSchema,
  working_directory: nullableTextValueSchema,
})
const conversationRowSchema = Schema.Struct({ conversation_data: textValueSchema })
const exchangeRowSchema = Schema.Struct({
  exchange_id: textValueSchema,
  start_ts: textValueSchema,
  input: nullableTextValueSchema,
  output_status: nullableTextValueSchema,
  working_directory: nullableTextValueSchema,
  model_id: Schema.optional(Schema.Unknown),
  planning_model_id: Schema.optional(Schema.Unknown),
  coding_model_id: Schema.optional(Schema.Unknown),
})
const blockRowSchema = Schema.Struct({
  start_ts: nullableTextValueSchema,
  stylized_command: nullableTextValueSchema,
})
const jsonValueSchema = Schema.fromJsonString(Schema.Unknown)
const recordSchema = Schema.Record(Schema.String, Schema.Unknown)
const arraySchema = Schema.Array(Schema.Unknown)
const tokenEntrySchema = Schema.Struct({
  model_id: Schema.optional(Schema.Unknown),
  warp_tokens: Schema.optional(Schema.Unknown),
  byok_tokens: Schema.optional(Schema.Unknown),
  warp_token_usage_by_category: Schema.optional(Schema.Unknown),
  byok_token_usage_by_category: Schema.optional(Schema.Unknown),
})
const usageMetadataSchema = Schema.Struct({ token_usage: Schema.optional(Schema.Unknown) })
const conversationDataSchema = Schema.Struct({ conversation_usage_metadata: Schema.optional(Schema.Unknown) })
const queryItemSchema = Schema.Struct({ Query: Schema.optional(Schema.Unknown) })
const querySchema = Schema.Struct({ text: Schema.optional(Schema.Unknown) })
const decodeDiscoveryRow = Schema.decodeUnknownResult(discoveryRowSchema)
const decodeConversationRow = Schema.decodeUnknownResult(conversationRowSchema)
const decodeExchangeRow = Schema.decodeUnknownResult(exchangeRowSchema)
const decodeBlockRow = Schema.decodeUnknownResult(blockRowSchema)
const decodeJsonValue = Schema.decodeUnknownResult(jsonValueSchema)
const decodeRecord = Schema.decodeUnknownResult(recordSchema)
const decodeArray = Schema.decodeUnknownResult(arraySchema)
const decodeTokenEntry = Schema.decodeUnknownResult(tokenEntrySchema)
const decodeUsageMetadata = Schema.decodeUnknownResult(usageMetadataSchema)
const decodeConversationData = Schema.decodeUnknownResult(conversationDataSchema)
const decodeQueryItem = Schema.decodeUnknownResult(queryItemSchema)
const decodeQuery = Schema.decodeUnknownResult(querySchema)
const decodeTextValue = Schema.decodeUnknownResult(textValueSchema)
const decodeFinite = Schema.decodeUnknownResult(Schema.Finite)

type WarpExchange = {
  readonly exchangeId: string
  readonly startMs: number
  readonly input: string
  readonly workingDirectory: string
  readonly outputStatus: string
  readonly modelId: unknown
  readonly planningModelId: unknown
  readonly codingModelId: unknown
}

type ParsedExchange = WarpExchange & { readonly userMessage: string; readonly weight: number }
type ExchangeToolInfo = { tools: string[]; bashCommands: string[] }
type OwnedDatabase = { readonly db: SqliteDatabase; closed: boolean }

class WarpDatabaseError extends Schema.TaggedError<WarpDatabaseError>()('WarpDatabaseError', {
  operation: Schema.Literals(['open', 'read', 'close']),
  cause: Schema.Defect(),
  message: Schema.String,
}) {}

function sanitizeProject(path: string): string {
  return path.replace(/^\/+/, '').replace(/\//g, '-')
}

function warpDbPath(bundleId: string): string {
  return join(
    homedir(),
    'Library',
    'Group Containers',
    WARP_GROUP_CONTAINER,
    'Library',
    'Application Support',
    bundleId,
    'warp.sqlite',
  )
}

function getDbCandidates(dbPathOverride?: string, paths?: AppPaths): string[] {
  if (dbPathOverride) return [dbPathOverride]
  const configuredPath = overrideFor(paths, 'WARP_DB_PATH')
  if (configuredPath) return [configuredPath]
  return [warpDbPath(WARP_STABLE_BUNDLE_ID), warpDbPath(WARP_PREVIEW_BUNDLE_ID)]
}

function normalizeModel(rawModel: string): string {
  const model = rawModel.trim()
  if (!model) return model
  return modelAliases[model] ?? model
}

function modelDisplayName(model: string): string {
  if (model === 'warp-auto-efficient') return 'Warp Auto (efficient)'
  if (model === 'warp-auto-powerful') return 'Warp Auto (powerful)'
  return getShortModelName(model)
}

function parseTimestamp(raw: string | null | undefined): number | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const withT = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T')
  const lastPlus = withT.lastIndexOf('+')
  const lastMinus = withT.lastIndexOf('-')
  const hasOffset = lastPlus > 9 || lastMinus > 9
  const hasTimezone = withT.endsWith('Z') || hasOffset
  const normalized = hasTimezone ? withT : `${withT}Z`
  const ms = Date.parse(normalized)
  return Number.isNaN(ms) ? null : ms
}

function positiveFinite(value: unknown): number {
  const decoded = decodeFinite(value)
  return Result.isSuccess(decoded) && decoded.success > 0 ? decoded.success : 0
}

function decodedText(value: unknown): string {
  const decoded = decodeTextValue(value)
  if (Result.isFailure(decoded)) return ''
  return typeof decoded.success === 'string' ? decoded.success : blobToText(decoded.success)
}

function categoryTokens(value: unknown): number {
  const decoded = decodeRecord(value)
  if (Result.isFailure(decoded)) return 0
  return positiveFinite(decoded.success[PRIMARY_AGENT_CATEGORY])
}

function extractTokenBudget(rawConversationData: string): { tokenBudget: number; dominantModel: string } {
  const json = decodeJsonValue(rawConversationData)
  if (Result.isFailure(json)) return { tokenBudget: 0, dominantModel: '' }
  const data = decodeConversationData(json.success)
  if (Result.isFailure(data)) return { tokenBudget: 0, dominantModel: '' }
  const metadata = decodeUsageMetadata(data.success.conversation_usage_metadata)
  const rawEntries = metadata && Result.isSuccess(metadata) ? decodeArray(metadata.success.token_usage) : undefined
  const entries = rawEntries && Result.isSuccess(rawEntries) ? rawEntries.success : []

  let primaryTotal = 0
  let fallbackTotal = 0
  let dominantPrimaryTokens = 0
  let dominantFallbackTokens = 0
  let dominantModel = ''

  for (const rawEntry of entries) {
    const decoded = decodeTokenEntry(rawEntry)
    if (Result.isFailure(decoded)) continue
    const entry = decoded.success
    const primaryTokens =
      categoryTokens(entry.warp_token_usage_by_category) + categoryTokens(entry.byok_token_usage_by_category)
    const entryTotal = positiveFinite(entry.warp_tokens) + positiveFinite(entry.byok_tokens)
    primaryTotal += primaryTokens
    fallbackTotal += entryTotal

    const model = typeof entry.model_id === 'string' ? entry.model_id : dominantModel
    if (primaryTokens > dominantPrimaryTokens) {
      dominantPrimaryTokens = primaryTokens
      dominantModel = model
    }
    if (dominantPrimaryTokens === 0 && entryTotal > dominantFallbackTokens) {
      dominantFallbackTokens = entryTotal
      dominantModel = model
    }
  }

  const tokenBudget = primaryTotal > 0 ? primaryTotal : fallbackTotal
  return { tokenBudget: Math.max(0, Math.round(tokenBudget)), dominantModel: normalizeModel(dominantModel) }
}

function extractUserMessage(rawInput: string): string {
  const json = decodeJsonValue(rawInput)
  if (Result.isFailure(json)) return ''
  const items = decodeArray(json.success)
  if (Result.isFailure(items)) return ''
  for (const rawItem of items.success) {
    const item = decodeQueryItem(rawItem)
    if (Result.isFailure(item)) continue
    const query = decodeQuery(item.success.Query)
    if (Result.isFailure(query)) continue
    const text = query.success.text
    if (typeof text === 'string' && text.trim()) return text
  }
  return ''
}

function estimateWeight(rawInput: string): number {
  const userMessage = extractUserMessage(rawInput)
  return Math.max(1, estimateTokensFromChars((userMessage || rawInput).length))
}

function allocateTokens(weights: number[], tokenBudget: number): number[] {
  if (weights.length === 0) return []
  const normalizedWeights = weights.map(weight => Math.max(0, Math.round(weight)))
  const totalWeight = normalizedWeights.reduce((sum, weight) => sum + weight, 0)
  const budget = Math.max(0, Math.round(tokenBudget))

  if (budget === 0) return normalizedWeights.map(() => 0)
  if (totalWeight === 0) {
    const even = Math.floor(budget / normalizedWeights.length)
    const allocated = normalizedWeights.map(() => even)
    let remainder = budget - even * normalizedWeights.length
    let index = 0
    while (remainder > 0) {
      allocated[index] = (allocated[index] ?? 0) + 1
      remainder--
      index = (index + 1) % normalizedWeights.length
    }
    return allocated
  }

  const rawAllocation = normalizedWeights.map(weight => (budget * weight) / totalWeight)
  const allocated = rawAllocation.map(value => Math.floor(value))
  let remainder = budget - allocated.reduce((sum, value) => sum + value, 0)
  const byLargestFraction = rawAllocation
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction)
  let pointer = 0
  while (remainder > 0 && byLargestFraction.length > 0) {
    const allocation = byLargestFraction[pointer]
    if (!allocation) break
    const index = allocation.index
    allocated[index] = (allocated[index] ?? 0) + 1
    remainder--
    pointer = (pointer + 1) % byLargestFraction.length
  }
  return allocated
}

function resolveModelForExchange(exchange: WarpExchange, dominantModel: string): Result.Result<string, string> {
  let candidate = ''
  for (const model of [exchange.modelId, exchange.codingModelId, exchange.planningModelId]) {
    const decoded = decodeTextValue(model)
    if (Result.isFailure(decoded)) return Result.fail('model field is not text')
    const value = typeof decoded.success === 'string' ? decoded.success : blobToText(decoded.success)
    candidate = value.trim()
    if (candidate) break
  }
  candidate ||= dominantModel || 'warp-auto-efficient'
  const normalized = normalizeModel(candidate)
  if ((normalized === 'warp-auto-efficient' || normalized === 'warp-auto-powerful') && dominantModel) {
    return Result.succeed(dominantModel)
  }
  return Result.succeed(normalized)
}

function assignCommandBlocksToExchanges(
  blocks: readonly unknown[],
  exchanges: readonly ParsedExchange[],
): Map<string, ExchangeToolInfo> {
  const toolsByExchange = new Map<string, ExchangeToolInfo>()
  for (const rawBlock of blocks) {
    const decoded = decodeBlockRow(rawBlock)
    if (Result.isFailure(decoded)) continue
    const block = decoded.success
    const blockStartMs = parseTimestamp(block.start_ts === null ? null : decodedText(block.start_ts))
    if (blockStartMs === null) continue

    let targetExchange: ParsedExchange | undefined
    for (const exchange of exchanges) {
      if (exchange.startMs > blockStartMs) break
      targetExchange = exchange
    }
    if (!targetExchange) continue

    let info = toolsByExchange.get(targetExchange.exchangeId)
    if (!info) {
      info = { tools: [], bashCommands: [] }
      toolsByExchange.set(targetExchange.exchangeId, info)
    }
    if (!info.tools.includes('Bash')) info.tools.push('Bash')
    const commandText = block.stylized_command === null ? '' : decodedText(block.stylized_command)
    for (const command of extractBashCommands(commandText)) {
      if (!info.bashCommands.includes(command)) info.bashCommands.push(command)
    }
  }
  return toolsByExchange
}

function decodeSourcePath(path: string): { dbPath: string; conversationId: string } {
  const splitIndex = path.lastIndexOf(':')
  if (splitIndex <= 0) return { dbPath: path, conversationId: '' }
  return { dbPath: path.slice(0, splitIndex), conversationId: path.slice(splitIndex + 1) }
}

function databaseError(operation: WarpDatabaseError['operation'], cause: unknown): WarpDatabaseError {
  const error = cause instanceof Error ? cause : new Error(String(cause), { cause })
  return new WarpDatabaseError({ operation, cause: error, message: error.message })
}

function closeDatabase(owned: OwnedDatabase): Effect.Effect<void, WarpDatabaseError> {
  return Effect.suspend(() => {
    if (owned.closed) return Effect.void
    owned.closed = true
    return Effect.try({ try: () => owned.db.close(), catch: cause => databaseError('close', cause) })
  })
}

function acquireDatabase(path: string): Effect.Effect<OwnedDatabase, WarpDatabaseError> {
  return Effect.try({
    try: () => ({ db: openDatabase(path), closed: false }),
    catch: cause => databaseError('open', cause),
  })
}

function validateSchema(db: SqliteDatabase): Effect.Effect<boolean, WarpDatabaseError> {
  return Effect.try({
    try: () => {
      db.query('SELECT 1 FROM agent_conversations WHERE 0')
      db.query('SELECT 1 FROM ai_queries WHERE 0')
      db.query('SELECT 1 FROM blocks WHERE 0')
    },
    catch: cause => databaseError('read', cause),
  }).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  )
}

const readDiscoveryRows = Effect.fnUntraced(function* (
  db: SqliteDatabase,
): Effect.fn.Return<Record<string, unknown>[], WarpDatabaseError> {
  return yield* Effect.try({
    try: () =>
      db.query(
        `SELECT CAST(c.conversation_id AS BLOB) AS conversation_id,
                CAST((
                  SELECT q.working_directory
                  FROM ai_queries q
                  WHERE q.conversation_id = c.conversation_id
                    AND q.working_directory IS NOT NULL
                    AND q.working_directory <> ''
                  ORDER BY q.start_ts DESC
                  LIMIT 1
                ) AS BLOB) AS working_directory
         FROM agent_conversations c
         WHERE EXISTS (SELECT 1 FROM ai_queries q WHERE q.conversation_id = c.conversation_id)
         ORDER BY c.last_modified_at DESC`,
      ),
    catch: cause => databaseError('read', cause),
  })
})

const discoverFromDb = Effect.fnUntraced(function* (
  dbPath: string,
  context?: ProviderScanContext,
): Effect.fn.Return<SessionSource[], Error> {
  yield* checkScanAbort(context?.signal)
  if (!isSqliteAvailable()) return []

  const result = yield* Effect.result(
    Effect.acquireUseRelease(
      acquireDatabase(dbPath),
      db =>
        Effect.result(
          Effect.gen(function* () {
            if (!(yield* validateSchema(db.db))) return []
            yield* checkScanAbort(context?.signal)
            const rows = yield* readDiscoveryRows(db.db).pipe(
              Effect.catchTag('WarpDatabaseError', error =>
                error.operation === 'read' ? Effect.succeed([]) : Effect.fail(error),
              ),
            )
            yield* checkScanAbort(context?.signal)
            return rows.flatMap(raw => {
              const decoded = decodeDiscoveryRow(raw)
              if (Result.isFailure(decoded)) return []
              const row = decoded.success
              const conversationId = decodedText(row.conversation_id)
              if (!conversationId) return []
              const workingDirectory = row.working_directory === null ? '' : decodedText(row.working_directory)
              const project = workingDirectory.trim() ? sanitizeProject(workingDirectory.trim()) : 'warp'
              return [{ path: `${dbPath}:${conversationId}`, project, provider: 'warp' as const }]
            })
          }),
        ),
      db => closeDatabase(db),
    ),
  )
  yield* checkScanAbort(context?.signal)
  if (Result.isFailure(result)) {
    if (result.failure.operation === 'close') return yield* Effect.fail(result.failure)
    return []
  }
  if (Result.isFailure(result.success)) return []
  return result.success.success
})

function readConversation(db: SqliteDatabase, conversationId: string): Effect.Effect<string | null, WarpDatabaseError> {
  return Effect.try({
    try: () =>
      db.query(
        `SELECT CAST(conversation_data AS BLOB) AS conversation_data
         FROM agent_conversations WHERE conversation_id = ? LIMIT 1`,
        [conversationId],
      ),
    catch: cause => databaseError('read', cause),
  }).pipe(
    Effect.map(rows => {
      const decoded = decodeConversationRow(rows[0])
      return Result.isSuccess(decoded) ? decodedText(decoded.success.conversation_data) : null
    }),
  )
}

function readExchanges(
  db: SqliteDatabase,
  conversationId: string,
): Effect.Effect<Record<string, unknown>[], WarpDatabaseError> {
  return Effect.try({
    try: () =>
      db.query(
        `SELECT CAST(exchange_id AS BLOB) AS exchange_id,
                CAST(start_ts AS BLOB) AS start_ts,
                CAST(input AS BLOB) AS input,
                CAST(working_directory AS BLOB) AS working_directory,
                CAST(output_status AS BLOB) AS output_status,
                CASE WHEN model_id IS NULL OR typeof(model_id) <> 'text' THEN model_id ELSE CAST(model_id AS BLOB) END AS model_id,
                CASE WHEN planning_model_id IS NULL OR typeof(planning_model_id) <> 'text' THEN planning_model_id ELSE CAST(planning_model_id AS BLOB) END AS planning_model_id,
                CASE WHEN coding_model_id IS NULL OR typeof(coding_model_id) <> 'text' THEN coding_model_id ELSE CAST(coding_model_id AS BLOB) END AS coding_model_id
         FROM ai_queries WHERE conversation_id = ? ORDER BY start_ts ASC`,
        [conversationId],
      ),
    catch: cause => databaseError('read', cause),
  })
}

const decodeExchanges = Effect.fnUntraced(function* (
  rows: readonly Record<string, unknown>[],
  onUnparsedCall: Effect.Effect<void>,
): Effect.fn.Return<ParsedExchange[]> {
  const exchanges: ParsedExchange[] = []
  for (const raw of rows) {
    const decoded = decodeExchangeRow(raw)
    if (Result.isFailure(decoded)) {
      yield* onUnparsedCall
      continue
    }
    const row = decoded.success
    const outputStatus = row.output_status === null ? '' : decodedText(row.output_status)
    if (!isFinalStatus(outputStatus)) continue
    const startMs = parseTimestamp(decodedText(row.start_ts))
    if (startMs === null) continue
    const input = row.input === null ? '' : decodedText(row.input)
    exchanges.push({
      exchangeId: decodedText(row.exchange_id),
      startMs,
      input,
      workingDirectory: row.working_directory === null ? '' : decodedText(row.working_directory),
      outputStatus,
      modelId: row.model_id,
      planningModelId: row.planning_model_id,
      codingModelId: row.coding_model_id,
      userMessage: extractUserMessage(input),
      weight: estimateWeight(input),
    })
  }
  return exchanges
})

function readBlocks(
  db: SqliteDatabase,
  conversationId: string,
): Effect.Effect<Record<string, unknown>[], WarpDatabaseError> {
  return Effect.try({
    try: () =>
      db.query(
        `SELECT CAST(start_ts AS BLOB) AS start_ts,
                CAST(stylized_command AS BLOB) AS stylized_command
         FROM blocks
         WHERE ai_metadata IS NOT NULL
           AND ai_metadata <> ''
           AND json_extract(ai_metadata, '$.conversation_id') = ?
         ORDER BY start_ts ASC`,
        [conversationId],
      ),
    catch: cause => databaseError('read', cause),
  })
}

function isFinalStatus(rawStatus: string): boolean {
  const json = decodeJsonValue(rawStatus)
  const status = Result.isSuccess(json) && typeof json.success === 'string' ? json.success : rawStatus
  return status === 'Completed' || status === 'Cancelled' || status === 'Failed'
}

function createParser(source: SessionSource, seenKeys: Set<string>, context?: ProviderScanContext): SessionParser {
  const pricing = context?.pricing ?? captureScanPricing()
  const signal = context?.signal
  const { dbPath, conversationId } = decodeSourcePath(source.path)
  const parseStream: NonNullable<SessionParser['parseStream']> = onUnparsedCall =>
    Stream.scoped(
      Stream.unwrap(
        Effect.gen(function* () {
          const countUnparsed = onUnparsedCall ?? Effect.void
          yield* checkScanAbort(signal)
          if (!isSqliteAvailable()) {
            reportProviderIssue('warp', 'sqlite-unavailable')
            return Stream.empty
          }
          if (!conversationId) return Stream.empty
          const acquired = yield* Effect.acquireRelease(
            acquireDatabase(dbPath).pipe(
              Effect.catchTag('WarpDatabaseError', error => {
                if (error.operation === 'open') {
                  reportProviderIssue('warp', fileErrorCode(error.cause, 'db-open-failed'))
                  return Effect.succeed(null)
                }
                return Effect.fail(error)
              }),
            ),
            db => (db ? closeDatabase(db).pipe(Effect.orDie) : Effect.void),
          )
          if (!acquired) return Stream.empty
          const finishEmpty = () => Stream.fromEffectDrain(closeDatabase(acquired))
          if (!(yield* validateSchema(acquired.db))) return finishEmpty()

          yield* checkScanAbort(signal)
          const conversationData = yield* readConversation(acquired.db, conversationId)
          if (conversationData === null) return finishEmpty()
          const exchanges = yield* decodeExchanges(yield* readExchanges(acquired.db, conversationId), countUnparsed)
          if (exchanges.length === 0) return finishEmpty()
          const blocks = yield* readBlocks(acquired.db, conversationId)
          yield* checkScanAbort(signal)

          const { tokenBudget, dominantModel } = extractTokenBudget(conversationData)
          const weights = exchanges.map(exchange => exchange.weight)
          const fallbackBudget = weights.reduce((sum, weight) => sum + weight, 0)
          const allocatedTokens = allocateTokens(weights, tokenBudget > 0 ? tokenBudget : fallbackBudget)
          const parsedExchanges = exchanges.map((exchange, index) => ({
            ...exchange,
            inputTokens: allocatedTokens[index] ?? 0,
          }))
          const toolsByExchange = assignCommandBlocksToExchanges(blocks, parsedExchanges)

          return Stream.fromIterable(parsedExchanges).pipe(
            Stream.mapEffect(exchange =>
              Effect.gen(function* () {
                yield* checkScanAbort(signal)
                const deduplicationKey = `warp:${conversationId}:${exchange.exchangeId}`
                if (seenKeys.has(deduplicationKey)) return Result.fail(undefined)
                const selectedModel = resolveModelForExchange(exchange, dominantModel)
                if (Result.isFailure(selectedModel)) {
                  yield* countUnparsed
                  return Result.fail(undefined)
                }
                const model = selectedModel.success
                const projectPath = exchange.workingDirectory.trim() || undefined
                const project = projectPath ? sanitizeProject(projectPath) : source.project
                const exchangeTools = toolsByExchange.get(exchange.exchangeId) ?? { tools: [], bashCommands: [] }
                seenKeys.add(deduplicationKey)
                const call = yield* Effect.try({
                  try: (): ParsedProviderCall => ({
                    provider: 'warp',
                    model,
                    inputTokens: exchange.inputTokens,
                    // Warp exposes only conversation totals, so it cannot split output usage by exchange.
                    outputTokens: 0,
                    cacheCreationInputTokens: 0,
                    cacheReadInputTokens: 0,
                    cachedInputTokens: 0,
                    reasoningTokens: 0,
                    webSearchRequests: 0,
                    costUSD: pricing.calculateCost(model, exchange.inputTokens, 0, 0, 0, 0),
                    costIsEstimated: true,
                    tools: exchangeTools.tools,
                    bashCommands: exchangeTools.bashCommands,
                    timestamp: new Date(exchange.startMs).toISOString(),
                    speed: 'standard',
                    deduplicationKey,
                    userMessage: exchange.userMessage.slice(0, 500),
                    sessionId: conversationId,
                    project,
                    projectPath,
                  }),
                  catch: cause => (cause instanceof Error ? cause : new Error(String(cause), { cause })),
                })
                return Result.succeed(call)
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

const discoverSessionsEffect = Effect.fn('discoverWarpSessions')(function* (
  dbPathOverride?: string,
  paths?: AppPaths,
  context?: ProviderScanContext,
): Effect.fn.Return<SessionSource[], Error> {
  const sessions: SessionSource[] = []
  for (const candidate of getDbCandidates(dbPathOverride, paths)) {
    yield* checkScanAbort(context?.signal)
    sessions.push(...(yield* discoverFromDb(candidate, context)))
  }
  return sessions
})

export function createWarpProvider(dbPathOverride?: string, paths?: AppPaths): Provider {
  const discover = (context?: ProviderScanContext) =>
    Effect.suspend(() => discoverSessionsEffect(dbPathOverride, paths, context))
  return {
    name: 'warp',
    displayName: 'Warp',
    modelDisplayName,
    toolDisplayName(rawTool: string): string {
      return rawTool === 'run_command' ? 'Bash' : rawTool
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

export const warp = createWarpProvider()
