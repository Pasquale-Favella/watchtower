import * as Cache from 'effect/Cache'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import { readdir, readFile, stat } from 'fs/promises'
import { homedir } from 'os'
import { basename, join } from 'path'

import { readSessionFileEffect } from '../fs-utils.js'
import { getShortModelName } from '../models.js'
import { isScanAbortedError } from '../scan-control.js'
import { checkScanAbort, scanIo } from '../scan-io.js'
import type { SqliteDatabase } from '../sqlite.js'
import { openDatabase } from '../sqlite.js'
import type { DateRange } from '../types.js'
import type { ParsedProviderCall, Provider, ProviderScanContext, SessionParser, SessionSource } from './types.js'

type DevinSessionMetadata = {
  id: string
  workingDirectory: string | null
  model: string
  title?: string
  createdAt: string
  lastActivityAt: string
  hidden: boolean
}

type DevinUsage = {
  committedAcuCost: number
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

const DEFAULT_DEVIN_CLI_DIR = join(homedir(), '.local', 'share', 'devin', 'cli')

const DEFAULT_MODEL_NAME = 'devin'
const DEVIN_PROVIDER_NAME = 'devin'
const DEVIN_PROVIDER_DISPLAY_NAME = 'Devin'
const DEVIN_TRANSCRIPTS_SUBDIR = 'transcripts'
const DEVIN_SESSIONS_DB = 'sessions.db'
const DEVIN_EFFORT_TIERS = new Set(['xhigh', 'high', 'medium', 'low'])

const trajectorySchema = Schema.Struct({
  session_id: Schema.optional(Schema.Unknown),
  agent: Schema.optional(Schema.Unknown),
  steps: Schema.Array(Schema.Unknown),
})
const recordSchema = Schema.Record(Schema.String, Schema.Unknown)
const configSchema = Schema.Struct({
  devin: Schema.optional(
    Schema.Struct({
      acuUsdRate: Schema.optional(Schema.Unknown),
    }),
  ),
})
const positiveRateSchema = Schema.Finite.check(Schema.isGreaterThan(0))
const stepSchema = Schema.Struct({
  step_id: Schema.optional(Schema.Unknown),
  model_name: Schema.optional(Schema.Unknown),
  message: Schema.optional(Schema.Unknown),
  tool_calls: Schema.optional(Schema.Unknown),
  extra: Schema.optional(Schema.Unknown),
  metadata: Schema.optional(Schema.Unknown),
  metrics: Schema.optional(Schema.Unknown),
})
const configJsonSchema = Schema.fromJsonString(configSchema)
const trajectoryJsonSchema = Schema.fromJsonString(trajectorySchema)
const decodeConfig = Schema.decodeUnknownResult(configJsonSchema)
const decodePositiveRate = Schema.decodeUnknownResult(positiveRateSchema)
const decodeTrajectory = Schema.decodeUnknownResult(trajectoryJsonSchema)
const decodeRecord = Schema.decodeUnknownResult(recordSchema)
const decodeStep = Schema.decodeUnknownResult(stepSchema)
const decodeString = Schema.decodeUnknownResult(Schema.String)
const decodeFinite = Schema.decodeUnknownResult(Schema.Finite)
const decodeUnknownArray = Schema.decodeUnknownResult(Schema.Array(Schema.Unknown))
const decodeToolCalls = Schema.decodeUnknownResult(Schema.Array(Schema.Struct({ function_name: Schema.String })))

type JsonRecord = Schema.Schema.Type<typeof recordSchema>
type DevinStep = Schema.Schema.Type<typeof stepSchema>
type DevinAgentTrajectory = Schema.Schema.Type<typeof trajectorySchema>

class DevinDatabaseError extends Schema.TaggedError<DevinDatabaseError>()('DevinDatabaseError', {
  operation: Schema.Literals(['open', 'read', 'close']),
  cause: Schema.Defect(),
  message: Schema.String,
}) {}

export interface DevinScanReadData {
  readonly readCostFactor: (path: string) => Effect.Effect<number | null, Error>
}

export class DevinScanReads extends Context.Service<DevinScanReads, DevinScanReadData>()(
  'watchtower/pipeline/DevinScanReads',
) {}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause), { cause })
}

function databaseError(operation: DevinDatabaseError['operation'], cause: unknown): DevinDatabaseError {
  const error = toError(cause)
  return new DevinDatabaseError({ operation, cause: error, message: error.message })
}

function recordOf(value: unknown): JsonRecord | null {
  const decoded = decodeRecord(value)
  return Result.isSuccess(decoded) ? decoded.success : null
}

function stringValue(value: unknown): string | undefined {
  const decoded = decodeString(value)
  return Result.isSuccess(decoded) ? decoded.success : undefined
}

function finiteValue(value: unknown): number | undefined {
  const decoded = decodeFinite(value)
  return Result.isSuccess(decoded) ? decoded.success : undefined
}

function positiveNumber(value: unknown): number | undefined {
  const decoded = decodePositiveRate(value)
  return Result.isSuccess(decoded) ? decoded.success : undefined
}

function readField(record: JsonRecord | null, key: string): unknown {
  return record?.[key]
}

function parseNumericTimestamp(value: unknown): string {
  if (value === null) return new Date(0).toISOString()
  const numeric = finiteValue(value)
  if (numeric === undefined) throw new Error('Invalid numeric timestamp')
  const millis = numeric < 10_000_000_000 ? numeric * 1000 : numeric
  return new Date(millis).toISOString()
}

function parseTranscript(raw: string): DevinAgentTrajectory | null {
  const decoded = decodeTrajectory(raw)
  return Result.isSuccess(decoded) ? decoded.success : null
}

function getCommittedAcuCost(step: DevinStep): number {
  const metadata = recordOf(step.metadata)
  const extra = recordOf(step.extra)
  return (
    positiveNumber(readField(metadata, 'committed_acu_cost')) ??
    positiveNumber(readField(extra, 'committed_acu_cost')) ??
    0
  )
}

function hasAnyTokenField(metrics: JsonRecord | null): boolean {
  if (!metrics) return false
  const extra = recordOf(readField(metrics, 'extra'))
  return [
    readField(metrics, 'prompt_tokens'),
    readField(metrics, 'completion_tokens'),
    readField(metrics, 'cached_tokens'),
    readField(extra, 'cache_creation_input_tokens'),
  ].some(value => value != null)
}

function getMetricsFromStep(step: DevinStep): JsonRecord | null {
  const metrics = recordOf(step.metrics)
  // Prefer step.metrics (standard ATIF v1.7) only when it actually carries
  // token fields; a present-but-empty metrics object must not shadow the
  // legacy metadata.metrics location.
  if (hasAnyTokenField(metrics)) return metrics

  const metadata = recordOf(step.metadata)
  const legacy = recordOf(readField(metadata, 'metrics'))
  if (metadata && legacy) {
    return {
      prompt_tokens: readField(legacy, 'input_tokens'),
      completion_tokens: readField(legacy, 'output_tokens'),
      cached_tokens: readField(legacy, 'cache_read_tokens'),
      extra: { cache_creation_input_tokens: readField(legacy, 'cache_creation_tokens') },
    }
  }

  return metrics
}

function getUsage(step: DevinStep): DevinUsage | null {
  const committedAcuCost = getCommittedAcuCost(step)
  const metrics = getMetricsFromStep(step)
  const metricsExtra = recordOf(readField(metrics, 'extra'))
  const input = readField(metrics, 'prompt_tokens')
  const output = readField(metrics, 'completion_tokens')
  const cacheCreate = readField(metricsExtra, 'cache_creation_input_tokens')
  const cacheRead = readField(metrics, 'cached_tokens')

  const hasAnyUsage = [committedAcuCost, input, output, cacheCreate, cacheRead].some(
    value => positiveNumber(value) !== undefined,
  )

  if (!hasAnyUsage) return null

  return {
    committedAcuCost,
    inputTokens: Math.max(0, finiteValue(input) ?? 0),
    outputTokens: Math.max(0, finiteValue(output) ?? 0),
    cacheCreationInputTokens: Math.max(0, finiteValue(cacheCreate) ?? 0),
    cacheReadInputTokens: Math.max(0, finiteValue(cacheRead) ?? 0),
  }
}

function getSessionId(source: SessionSource, transcript: DevinAgentTrajectory): string {
  const fromTranscript = stringValue(transcript.session_id)?.trim()
  return fromTranscript || basename(source.path, '.json')
}

function projectNameFromPath(path: string): string {
  const normalized = path.trim().replace(/[/\\]+$/, '')
  return normalized.split(/[/\\]/).filter(Boolean).pop() ?? path
}

function getProjectName(source: SessionSource, session: DevinSessionMetadata | null): string {
  if (session?.workingDirectory) return projectNameFromPath(session.workingDirectory)
  if (session?.title) return session.title
  return source.project
}

function getProjectPath(session: DevinSessionMetadata | null): string | undefined {
  return session?.workingDirectory ?? undefined
}

function getTimestamp(step: DevinStep, session: DevinSessionMetadata | null): Result.Result<string, unknown> {
  const metadata = recordOf(step.metadata)
  const timestamp = readField(metadata, 'created_at')
  if (timestamp) return decodeString(timestamp)
  return Result.succeed(session?.lastActivityAt || session?.createdAt || '')
}

function firstPresentString(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

function getFriendlyGptName(model: string): string {
  const shortName = getShortModelName(model)
  const match = model.match(/^gpt-(\d+(?:\.\d+)*)(?:-(.+))?$/)
  if (!match) return shortName

  const suffixParts = match[2]?.split('-').filter(Boolean) ?? []
  // A purely numeric suffix token means this is a dated snapshot id such as
  // gpt-4-1106-preview, not a clean version+word id. Fabricating a friendly
  // name here would mislabel the date as text (e.g. "GPT-4 1106 Preview"), so
  // defer to getShortModelName, which passes unknown snapshots through raw.
  if (suffixParts.some(part => /^\d+$/.test(part))) return shortName

  const suffix = suffixParts.map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')

  const reconstructed = `GPT-${match[1]}${suffix ? ` ${suffix}` : ''}`
  if (shortName !== model && (!suffix || shortName !== `GPT-${match[1]}`)) {
    return shortName
  }

  return reconstructed
}

function getDevinDisplayModelName(generationModel: string | undefined, modelName: string): string {
  if (!generationModel || /^MODEL_/.test(generationModel)) {
    return getShortModelName(modelName)
  }

  if (generationModel.startsWith('gpt-')) {
    // Devin minor versions are always a single digit (gpt-5-3-codex). Restrict
    // the dash-to-dot rewrite to a single-digit minor at a token boundary so a
    // dated snapshot like gpt-4-1106-preview is not misread as version 4.1106.
    const normalized = generationModel.replace(/^gpt-(\d+)-(\d)(?=-|$)/, 'gpt-$1.$2')
    const effortMatch = normalized.match(/-([^-]+)$/)
    const effort = effortMatch && DEVIN_EFFORT_TIERS.has(effortMatch[1]!) ? effortMatch[1] : undefined
    const base = effort ? normalized.slice(0, -(effort.length + 1)) : normalized
    const friendlyBase = getFriendlyGptName(base)
    return effort ? `${friendlyBase} (${effort})` : friendlyBase
  }

  return getShortModelName(generationModel)
}

function getModelName(transcript: DevinAgentTrajectory, step: DevinStep, session: DevinSessionMetadata | null): string {
  const metadata = recordOf(step.metadata)
  const extra = recordOf(step.extra)
  const agent = recordOf(transcript.agent)
  const generationModel = firstPresentString(
    stringValue(readField(metadata, 'generation_model')),
    stringValue(readField(extra, 'generation_model')),
  )
  const modelName =
    firstPresentString(stringValue(step.model_name), stringValue(readField(agent, 'model_name')), session?.model) ??
    DEFAULT_MODEL_NAME

  return getDevinDisplayModelName(generationModel, modelName)
}

function getToolNames(step: DevinStep): Result.Result<string[], unknown> {
  return Result.map(decodeToolCalls(step.tool_calls ?? []), calls => calls.map(call => call.function_name))
}

function normalizeContentPartMessage(value: unknown): string {
  const contentPart = recordOf(value)
  if (stringValue(readField(contentPart, 'type')) === 'text') {
    return stringValue(readField(contentPart, 'text')) ?? ''
  }
  const source = recordOf(readField(contentPart, 'source'))
  return stringValue(readField(source, 'path')) ?? ''
}

function normalizeStepMessage(message: unknown): string {
  const decodedString = decodeString(message)
  if (Result.isSuccess(decodedString)) return decodedString.success.trim()
  const contentParts = decodeUnknownArray(message)
  if (Result.isFailure(contentParts)) return ''
  return contentParts.success
    .map(normalizeContentPartMessage)
    .map(part => part.trim())
    .join(' ')
}

function getFirstUserMessageBeforeStep(steps: readonly unknown[], index: number): string | null {
  for (let i = index - 1; i >= 0; i--) {
    const decoded = decodeStep(steps[i])
    if (Result.isFailure(decoded)) continue
    const step = decoded.success
    const metadata = recordOf(step.metadata)
    if (!readField(metadata, 'is_user_input')) continue
    const message = step.message ? normalizeStepMessage(step.message) : undefined
    if (message) return message
  }
  return null
}

const sessionRowSchema = Schema.Struct({
  id: Schema.optional(Schema.Unknown),
  working_directory: Schema.optional(Schema.Unknown),
  model: Schema.optional(Schema.Unknown),
  title: Schema.optional(Schema.Unknown),
  created_at: Schema.optional(Schema.Unknown),
  last_activity_at: Schema.optional(Schema.Unknown),
  hidden: Schema.optional(Schema.Unknown),
})
const decodeSessionRow = Schema.decodeUnknownResult(sessionRowSchema)

function readSessionRows(db: SqliteDatabase, sessions: Map<string, DevinSessionMetadata>): void {
  const rows = db.query<Record<string, unknown>>(
    `SELECT id, working_directory, model, title, created_at, last_activity_at, hidden
     FROM sessions`,
  )
  for (const rawRow of rows) {
    const decoded = decodeSessionRow(rawRow)
    if (Result.isFailure(decoded)) continue
    const row = decoded.success
    const id = stringValue(row.id)
    if (!id) continue
    const workingDirectory = row.working_directory === null ? null : (stringValue(row.working_directory) ?? '')
    const model = stringValue(row.model) ?? ''
    const title = stringValue(row.title)
    sessions.set(id, {
      id,
      workingDirectory,
      model,
      ...(title !== undefined ? { title } : {}),
      createdAt: parseNumericTimestamp(row.created_at),
      lastActivityAt: parseNumericTimestamp(row.last_activity_at),
      hidden: Boolean(row.hidden),
    })
  }
}

const loadSessionMetadataEffect = Effect.fnUntraced(function* (
  dbPath: string,
  signal?: AbortSignal,
): Effect.fn.Return<Map<string, DevinSessionMetadata>, Error> {
  const sessions = new Map<string, DevinSessionMetadata>()
  yield* checkScanAbort(signal)
  const result = yield* Effect.result(
    Effect.acquireUseRelease(
      Effect.try({ try: () => openDatabase(dbPath), catch: cause => databaseError('open', cause) }),
      db =>
        Effect.result(
          Effect.try({ try: () => readSessionRows(db, sessions), catch: cause => databaseError('read', cause) }),
        ),
      db => Effect.try({ try: () => db.close(), catch: cause => databaseError('close', cause) }),
    ),
  )
  yield* checkScanAbort(signal)
  if (Result.isFailure(result)) {
    if (result.failure instanceof DevinDatabaseError && result.failure.operation === 'close') {
      return yield* Effect.fail(toError(result.failure.cause))
    }
    return sessions
  }
  if (Result.isFailure(result.success)) return sessions
  return sessions
})

function configPath(): string {
  return join(homedir(), '.config', 'watchtower', 'config.json')
}

const loadCostFactor = Effect.fnUntraced(function* (
  path: string,
  signal?: AbortSignal,
): Effect.fn.Return<number | null, Error> {
  const raw = yield* scanIo(() => readFile(path, 'utf-8'), signal).pipe(
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(null))),
  )
  if (raw === null) return null
  const decoded = decodeConfig(raw)
  if (Result.isFailure(decoded)) return null
  return positiveNumber(decoded.success.devin?.acuUsdRate) ?? null
})

export const createDevinScanReads = Effect.fnUntraced(function* (
  signal?: AbortSignal,
): Effect.fn.Return<DevinScanReadData> {
  const costFactors = yield* Cache.make({
    capacity: Infinity,
    lookup: (path: string) => loadCostFactor(path, signal),
  })
  return {
    readCostFactor: path => checkScanAbort(signal).pipe(Effect.andThen(Cache.get(costFactors, path))),
  }
})

const readCostFactor = Effect.fnUntraced(function* (signal?: AbortSignal): Effect.fn.Return<number | null, Error> {
  const path = configPath()
  const scanReads = Option.getOrUndefined(yield* Effect.serviceOption(DevinScanReads))
  return yield* scanReads ? scanReads.readCostFactor(path) : loadCostFactor(path, signal)
})

function createParser(
  source: SessionSource,
  seenKeys: Set<string>,
  getSessionMetadata: (signal?: AbortSignal) => Effect.Effect<Map<string, DevinSessionMetadata>, Error>,
  context?: ProviderScanContext,
): SessionParser {
  const signal = context?.signal
  const parseEffect = Effect.fn('parseDevinSession')(function* (
    onUnparsedCall?: Effect.Effect<void>,
  ): Effect.fn.Return<Stream.Stream<ParsedProviderCall, Error>, Error> {
    yield* checkScanAbort(signal)
    const raw = yield* readSessionFileEffect(source.path, 'utf-8', signal ? { signal } : {}).pipe(
      Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(null))),
    )
    if (!raw) return Stream.empty
    const transcript = parseTranscript(raw)
    if (!transcript) return Stream.empty

    const sessionId = getSessionId(source, transcript)
    const metadata = yield* getSessionMetadata(signal)
    const session = metadata.get(sessionId) ?? null
    if (session?.hidden) return Stream.empty

    const costFactor = yield* readCostFactor(signal)
    if (costFactor === null) return Stream.empty

    const project = getProjectName(source, session)
    const projectPath = getProjectPath(session)
    const indexedSteps = transcript.steps.map((step, index) => ({ step, index }))
    return Stream.fromIterable(indexedSteps).pipe(
      Stream.mapEffect(({ step: rawStep, index }) =>
        Effect.gen(function* () {
          yield* checkScanAbort(signal)
          const decoded = decodeStep(rawStep)
          if (Result.isFailure(decoded)) {
            if (onUnparsedCall) yield* onUnparsedCall
            return null
          }
          const step = decoded.success
          const stepMetadata = recordOf(step.metadata)
          if (readField(stepMetadata, 'is_user_input')) return null

          const usage = getUsage(step)
          if (!usage) return null
          const timestamp = getTimestamp(step, session)
          const deduplicationKey = `devin:${sessionId}:${step.step_id}`
          if (seenKeys.has(deduplicationKey)) return null
          seenKeys.add(deduplicationKey)
          if (session?.workingDirectory === null || Result.isFailure(timestamp)) {
            if (onUnparsedCall) yield* onUnparsedCall
            return null
          }

          const model = getModelName(transcript, step, session)
          const decodedTools = getToolNames(step)
          if (Result.isFailure(decodedTools)) {
            if (onUnparsedCall) yield* onUnparsedCall
            return null
          }
          const tools = decodedTools.success
          const userMessage = getFirstUserMessageBeforeStep(transcript.steps, index) ?? ''
          const call: ParsedProviderCall = {
            provider: DEVIN_PROVIDER_NAME,
            model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheCreationInputTokens: usage.cacheCreationInputTokens,
            cacheReadInputTokens: usage.cacheReadInputTokens,
            cachedInputTokens: usage.cacheReadInputTokens,
            reasoningTokens: 0,
            webSearchRequests: 0,
            costUSD: usage.committedAcuCost * costFactor,
            tools,
            bashCommands: [],
            timestamp: timestamp.success,
            speed: 'standard',
            deduplicationKey,
            userMessage,
            sessionId,
            project,
            projectPath,
          }
          return call
        }),
      ),
      Stream.filter((call): call is ParsedProviderCall => call !== null),
    )
  })

  const parseStream = (onUnparsedCall?: Effect.Effect<void>) => Stream.unwrap(parseEffect(onUnparsedCall))
  return {
    parseStream,
  }
}

export function createDevinProvider(cliDir: string): Provider {
  const sessionsDbPath = join(cliDir, DEVIN_SESSIONS_DB)
  let sessionMetadata: Map<string, DevinSessionMetadata> | null = null

  const getSessionMetadata = Effect.fnUntraced(function* (
    signal?: AbortSignal,
  ): Effect.fn.Return<Map<string, DevinSessionMetadata>, Error> {
    if (sessionMetadata) return sessionMetadata
    const loaded = yield* loadSessionMetadataEffect(sessionsDbPath, signal)
    sessionMetadata = loaded
    return loaded
  })

  const discoverEffect = Effect.fn('discoverDevinSessions')(function* (
    context?: ProviderScanContext,
  ): Effect.fn.Return<SessionSource[], Error> {
    const signal = context?.signal
    yield* checkScanAbort(signal)
    if ((yield* readCostFactor(signal)) === null) return []

    const transcriptsDir = join(cliDir, DEVIN_TRANSCRIPTS_SUBDIR)
    const entries = yield* scanIo(() => readdir(transcriptsDir), signal).pipe(
      Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed([] as string[]))),
    )
    const metadata = yield* getSessionMetadata(signal)
    const sources: SessionSource[] = []
    for (const entry of entries) {
      yield* checkScanAbort(signal)
      if (!entry.endsWith('.json')) continue

      const filePath = join(transcriptsDir, entry)
      const fileStats = yield* scanIo(() => stat(filePath), signal).pipe(
        Effect.map(stats => (stats.isFile() ? stats : null)),
        Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(null))),
      )
      if (!fileStats) continue

      const session = metadata.get(basename(filePath, '.json')) ?? null
      if (session?.hidden) continue
      const tmpSource: SessionSource = { path: filePath, project: DEVIN_PROVIDER_NAME, provider: DEVIN_PROVIDER_NAME }
      sources.push({ path: filePath, project: getProjectName(tmpSource, session), provider: DEVIN_PROVIDER_NAME })
    }
    return sources
  })

  return {
    name: DEVIN_PROVIDER_NAME,
    displayName: DEVIN_PROVIDER_DISPLAY_NAME,

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    discoverSessionsEffect: discoverEffect,

    createSessionParser(
      source: SessionSource,
      seenKeys: Set<string>,
      _dateRange?: DateRange,
      context?: ProviderScanContext,
    ): SessionParser {
      return createParser(source, seenKeys, getSessionMetadata, context)
    },
  }
}

export const devin = createDevinProvider(DEFAULT_DEVIN_CLI_DIR)
