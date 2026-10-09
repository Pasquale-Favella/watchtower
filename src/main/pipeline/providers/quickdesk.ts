import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'

import { Effect, Result, Schema, Stream } from 'effect'

import { captureScanPricing } from '../models.js'
import { isScanAbortedError } from '../scan-control.js'
import { checkScanAbort, scanIo } from '../scan-io.js'
import type { ScanPricing } from '../scan-pricing.js'
import type { SqliteDatabase } from '../sqlite.js'
import { blobToText, isSqliteAvailable, openDatabase } from '../sqlite.js'
import { estimateTokensFromChars } from '../token-estimate.js'
import type { DateRange } from '../types.js'
import type {
  ParsedProviderCall,
  ProbeRoot,
  Provider,
  ProviderScanContext,
  SessionParser,
  SessionSource,
} from './types.js'

const METRICS_FILE_RE = /^metrics-(\d{4})-(\d{2})-(\d{2})\.jsonl$/

const modelDisplayNames: Record<string, string> = {
  'claude-sonnet-4-5': 'Sonnet 4.5',
  'claude-sonnet-4-6': 'Sonnet 4.6',
}

const toolNameMap: Record<string, string> = {
  readFile: 'Read',
  read_file: 'Read',
  writeFile: 'Edit',
  write_file: 'Edit',
  editFile: 'Edit',
  edit_file: 'Edit',
  runCommand: 'Bash',
  run_command: 'Bash',
  executeBash: 'Bash',
  shell: 'Bash',
  grep: 'Grep',
  searchFiles: 'Grep',
  search_files: 'Grep',
}

type ProfileBase = {
  path: string
  profile: string
}

type MetricsRecord = {
  record: MetricRecord
}

type MetricRecord = Schema.Schema.Type<typeof metricRecordSchema>

type SessionMetadata = {
  id: string
  createdAt?: number
  deleted: boolean
  firstUserMessage: string
  inputChars: number
  outputChars: number
  tools: string[]
}

type DatabaseSnapshot = {
  sessions: Map<string, SessionMetadata>
  canEstimate: boolean
}

type SqlRow = Record<string, unknown>

class QuickdeskDatabaseError extends Schema.TaggedError<QuickdeskDatabaseError>()('QuickdeskDatabaseError', {
  operation: Schema.Literals(['open', 'read', 'close']),
  cause: Schema.Defect(),
  message: Schema.String,
}) {}

const objectSchema = Schema.Record(Schema.String, Schema.Unknown)
const profileManifestSchema = Schema.Struct({ entries: Schema.optional(Schema.Array(Schema.Unknown)) })
const metricRecordSchema = Schema.Struct({
  Model: Schema.optional(Schema.Unknown),
  InputTokens: Schema.optional(Schema.Unknown),
  OutputTokens: Schema.optional(Schema.Unknown),
  CostUSD: Schema.optional(Schema.Unknown),
  ToolName: Schema.optional(Schema.Unknown),
  session_id: Schema.optional(Schema.Unknown),
  _aws: Schema.optional(Schema.Unknown),
})
const sqlNameRowSchema = Schema.Struct({ name: Schema.optional(Schema.Unknown) })
const sessionRowSchema = Schema.Struct({
  id: Schema.optional(Schema.Unknown),
  created_at: Schema.optional(Schema.Unknown),
  deleted_at: Schema.optional(Schema.Unknown),
})
const messageRowSchema = Schema.Struct({
  session_id: Schema.optional(Schema.Unknown),
  role: Schema.optional(Schema.Unknown),
  content: Schema.optional(Schema.Unknown),
  tool_names: Schema.optional(Schema.Unknown),
})
const toolNameArraySchema = Schema.Array(Schema.Unknown)

const decodeObject = Schema.decodeUnknownResult(objectSchema)
const decodeProfileManifest = Schema.decodeUnknownResult(Schema.fromJsonString(profileManifestSchema))
const decodeMetricRecord = Schema.decodeUnknownResult(Schema.fromJsonString(metricRecordSchema))
const decodeSqlNameRow = Schema.decodeUnknownResult(sqlNameRowSchema)
const decodeSessionRow = Schema.decodeUnknownResult(sessionRowSchema)
const decodeMessageRow = Schema.decodeUnknownResult(messageRowSchema)
const decodeToolNameArray = Schema.decodeUnknownResult(Schema.fromJsonString(toolNameArraySchema))

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause), { cause })
}

function databaseError(operation: QuickdeskDatabaseError['operation'], cause: unknown): QuickdeskDatabaseError {
  const error = toError(cause)
  return new QuickdeskDatabaseError({ operation, cause: error, message: error.message })
}

function quickworkHome(override?: string): string {
  return resolve(override || process.env['QUICKWORK_HOME'] || join(homedir(), '.quickwork'))
}

function recordOf(value: unknown): Record<string, unknown> | null {
  const decoded = decodeObject(value)
  return Result.isSuccess(decoded) ? decoded.success : null
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nonNegativeNumber(value: unknown): number | undefined {
  const number = finiteNumber(value)
  return number !== undefined && number >= 0 ? number : undefined
}

function ordinaryFailureOr<A>(error: Error, fallback: A): Effect.Effect<A, Error> {
  return isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(fallback)
}

const resolveProfileBases = Effect.fnUntraced(function* (
  quickworkHomeOverride?: string,
  signal?: AbortSignal,
): Effect.fn.Return<ProfileBase[], Error> {
  const root = quickworkHome(quickworkHomeOverride)
  const profilesPath = join(root, 'profiles.json')
  const profilesContents = yield* scanIo(() => readFile(profilesPath, 'utf8'), signal).pipe(
    Effect.catch(error => ordinaryFailureOr(error, null as string | null)),
  )

  if (profilesContents !== null) {
    const decoded = decodeProfileManifest(profilesContents)
    if (Result.isSuccess(decoded)) {
      const bases: ProfileBase[] = []
      const seenPaths = new Set<string>()
      for (const rawEntry of decoded.success.entries ?? []) {
        const entry = recordOf(rawEntry)
        const profile = stringValue(entry?.['id'])
        const dataPath = stringValue(entry?.['data_path'])
        if (!profile || !dataPath) continue
        const basePath = isAbsolute(dataPath) ? resolve(dataPath) : resolve(root, dataPath)
        if (seenPaths.has(basePath)) continue
        seenPaths.add(basePath)
        bases.push({ path: basePath, profile })
      }

      if (bases.length > 0) {
        const legacyDbPath = join(root, 'sessions', 'sessions.db')
        if (!seenPaths.has(root) && (yield* isFile(legacyDbPath, signal))) {
          bases.push({ path: root, profile: 'default' })
        }
        return bases
      }
    }
  }

  return [{ path: root, profile: 'default' }]
})

const isFile = Effect.fnUntraced(function* (path: string, signal?: AbortSignal): Effect.fn.Return<boolean, Error> {
  const info = yield* scanIo(() => stat(path), signal).pipe(Effect.catch(error => ordinaryFailureOr(error, null)))
  return info?.isFile() ?? false
})

const metricsFiles = Effect.fnUntraced(function* (
  basePath: string,
  signal?: AbortSignal,
): Effect.fn.Return<string[], Error> {
  const entries = yield* scanIo(() => readdir(join(basePath, 'metrics'), { withFileTypes: true }), signal).pipe(
    Effect.catch(error => ordinaryFailureOr(error, [])),
  )
  return entries
    .filter(entry => entry.isFile() && METRICS_FILE_RE.test(entry.name))
    .map(entry => join(basePath, 'metrics', entry.name))
    .sort()
})

const discoverSources = Effect.fnUntraced(function* (
  quickworkHomeOverride?: string,
  signal?: AbortSignal,
): Effect.fn.Return<SessionSource[], Error> {
  const sources: SessionSource[] = []
  for (const base of yield* resolveProfileBases(quickworkHomeOverride, signal)) {
    yield* checkScanAbort(signal)
    for (const metricsPath of yield* metricsFiles(base.path, signal)) {
      sources.push({
        path: metricsPath,
        project: base.profile,
        provider: 'quickdesk',
        sourceId: 'metrics',
        sourcePath: base.path,
      })
    }
    const dbPath = join(base.path, 'sessions', 'sessions.db')
    if (yield* isFile(dbPath, signal)) {
      sources.push({
        path: dbPath,
        project: base.profile,
        provider: 'quickdesk',
        sourceId: 'sessions-db',
        sourcePath: base.path,
      })
    }
  }
  return sources
})

function tableNames(db: SqliteDatabase): Set<string> {
  const rows = db.query<SqlRow>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sessions', 'session_messages')",
  )
  return new Set(
    rows.flatMap(raw => {
      const decoded = decodeSqlNameRow(raw)
      return Result.isSuccess(decoded) ? [stringValue(decoded.success.name)].filter(Boolean) : []
    }),
  )
}

function tableColumns(db: SqliteDatabase, table: 'sessions' | 'session_messages'): Set<string> {
  const rows = db.query<SqlRow>(`PRAGMA table_info(${table})`)
  return new Set(
    rows.flatMap(raw => {
      const decoded = decodeSqlNameRow(raw)
      return Result.isSuccess(decoded) ? [stringValue(decoded.success.name)].filter(Boolean) : []
    }),
  )
}

function selectColumn(columns: Set<string>, name: string, fallback = 'NULL'): string {
  return columns.has(name) ? name : `${fallback} AS ${name}`
}

function toolNames(value: unknown): string[] {
  const text = value instanceof Uint8Array ? blobToText(value) : stringValue(value)
  if (!text) return []
  const parsed = decodeToolNameArray(text)
  if (Result.isSuccess(parsed)) {
    return parsed.success.flatMap(entry => {
      if (typeof entry === 'string') return entry.trim() ? [entry.trim()] : []
      const record = recordOf(entry)
      const name =
        stringValue(record?.['name']) || stringValue(record?.['tool_name']) || stringValue(record?.['toolName'])
      return name ? [name] : []
    })
  }
  return text
    .split(',')
    .map(name => name.trim())
    .filter(Boolean)
}

function uniqueMappedTools(values: string[]): string[] {
  return [...new Set(values.map(value => toolNameMap[value] ?? value).filter(Boolean))]
}

function timestampSeconds(value: unknown): number | undefined {
  const number = finiteNumber(value)
  return number !== undefined && number >= 0 ? number : undefined
}

function unixSecondsIso(value: number): string | null {
  const date = new Date(value * 1000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function readDatabaseSnapshot(db: SqliteDatabase): DatabaseSnapshot {
  const empty: DatabaseSnapshot = { sessions: new Map(), canEstimate: false }
  const tables = tableNames(db)
  if (!tables.has('sessions')) return empty

  const sessionColumns = tableColumns(db, 'sessions')
  if (!sessionColumns.has('id')) return empty
  const deletionKnown = sessionColumns.has('deleted_at')
  const sessionRows = db.query<SqlRow>(
    `SELECT id,
            ${selectColumn(sessionColumns, 'created_at')},
            ${selectColumn(sessionColumns, 'deleted_at')}
     FROM sessions`,
  )

  const sessions = new Map<string, SessionMetadata>()
  for (const raw of sessionRows) {
    const decoded = decodeSessionRow(raw)
    if (Result.isFailure(decoded)) continue
    const row = decoded.success
    const id = stringValue(row.id)
    if (!id) continue
    sessions.set(id, {
      id,
      createdAt: timestampSeconds(row.created_at),
      deleted: deletionKnown && row.deleted_at !== null && row.deleted_at !== undefined,
      firstUserMessage: '',
      inputChars: 0,
      outputChars: 0,
      tools: [],
    })
  }

  if (!tables.has('session_messages')) return { sessions, canEstimate: false }

  const messageColumns = tableColumns(db, 'session_messages')
  if (!messageColumns.has('session_id') || !messageColumns.has('role') || !messageColumns.has('content')) {
    return { sessions, canEstimate: false }
  }

  try {
    const orderBy = messageColumns.has('timestamp') ? 'ORDER BY timestamp ASC' : ''
    const rows = db.query<SqlRow>(
      `SELECT session_id,
              role,
              CAST(content AS BLOB) AS content,
              ${messageColumns.has('tool_names') ? 'CAST(tool_names AS BLOB) AS tool_names' : 'NULL AS tool_names'}
       FROM session_messages
       ${orderBy}`,
    )
    for (const raw of rows) {
      const decoded = decodeMessageRow(raw)
      if (Result.isFailure(decoded)) continue
      const row = decoded.success
      const session = sessions.get(stringValue(row.session_id))
      if (!session) continue
      const role = stringValue(row.role).toLowerCase()
      const content = row.content instanceof Uint8Array ? blobToText(row.content) : stringValue(row.content)
      if (role === 'assistant') session.outputChars += content.length
      else session.inputChars += content.length
      if (role === 'user' && !session.firstUserMessage && content.trim()) {
        session.firstUserMessage = content.trim()
      }
      session.tools.push(...toolNames(row.tool_names))
    }
  } catch {
    return { sessions, canEstimate: false }
  }

  for (const session of sessions.values()) session.tools = uniqueMappedTools(session.tools)
  return { sessions, canEstimate: true }
}

const loadDatabaseSnapshot = Effect.fnUntraced(function* (
  basePath: string,
  signal?: AbortSignal,
): Effect.fn.Return<DatabaseSnapshot, Error> {
  const empty: DatabaseSnapshot = { sessions: new Map(), canEstimate: false }
  yield* checkScanAbort(signal)
  if (!isSqliteAvailable()) return empty

  const result = yield* Effect.result(
    Effect.acquireUseRelease(
      Effect.try({
        try: () => openDatabase(join(basePath, 'sessions', 'sessions.db')),
        catch: cause => databaseError('open', cause),
      }),
      db =>
        Effect.result(
          Effect.try({ try: () => readDatabaseSnapshot(db), catch: cause => databaseError('read', cause) }),
        ),
      db => Effect.try({ try: () => db.close(), catch: cause => databaseError('close', cause) }),
    ),
  )
  yield* checkScanAbort(signal)
  if (Result.isFailure(result)) {
    if (result.failure instanceof QuickdeskDatabaseError && result.failure.operation === 'close') {
      return yield* Effect.fail(toError(result.failure.cause))
    }
    return empty
  }
  if (Result.isFailure(result.success)) return empty
  return result.success.success
})

const readMetricsRecords = Effect.fnUntraced(function* (
  path: string,
  signal?: AbortSignal,
): Effect.fn.Return<MetricsRecord[], Error> {
  const contents = yield* scanIo(() => readFile(path, 'utf8'), signal).pipe(
    Effect.catch(error => ordinaryFailureOr(error, null as string | null)),
  )
  if (contents === null) return []

  const records: MetricsRecord[] = []
  for (const line of contents.split(/\r?\n/)) {
    yield* checkScanAbort(signal)
    const trimmed = line.trim()
    if (!trimmed) continue
    const decoded = decodeMetricRecord(trimmed)
    if (Result.isSuccess(decoded)) records.push({ record: decoded.success })
  }
  return records
})

function usageRecord(record: MetricRecord): boolean {
  return (
    Boolean(stringValue(record.Model)) &&
    nonNegativeNumber(record.InputTokens) !== undefined &&
    nonNegativeNumber(record.OutputTokens) !== undefined
  )
}

function sessionId(record: MetricRecord): string {
  return stringValue(record.session_id)
}

function collectMetricTools(records: MetricsRecord[]): Map<string, string[]> {
  const tools = new Map<string, string[]>()
  for (const { record } of records) {
    const key = sessionId(record)
    const tool = stringValue(record.ToolName)
    if (!key || !tool) continue
    const current = tools.get(key) ?? []
    current.push(toolNameMap[tool] ?? tool)
    tools.set(key, current)
  }
  for (const [key, values] of tools) tools.set(key, [...new Set(values)])
  return tools
}

function fallbackTimestamp(path: string): string | null {
  const match = METRICS_FILE_RE.exec(basename(path))
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return date.toISOString()
}

function metricsTimestamp(record: MetricRecord, path: string): string | null {
  const aws = recordOf(record._aws)
  const timestampMs = finiteNumber(aws?.['Timestamp'])
  if (timestampMs !== undefined) {
    const date = new Date(timestampMs)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  return fallbackTimestamp(path)
}

const metricSessionIds = Effect.fnUntraced(function* (
  basePath: string,
  signal?: AbortSignal,
): Effect.fn.Return<Set<string>, Error> {
  const ids = new Set<string>()
  for (const path of yield* metricsFiles(basePath, signal)) {
    for (const { record } of yield* readMetricsRecords(path, signal)) {
      yield* checkScanAbort(signal)
      if (!usageRecord(record)) continue
      const id = sessionId(record)
      if (id) ids.add(id)
    }
  }
  return ids
})

const allMetricSessionIds = Effect.fnUntraced(function* (
  quickworkHomeOverride: string | undefined,
  signal?: AbortSignal,
): Effect.fn.Return<Set<string>, Error> {
  const ids = new Set<string>()
  for (const base of yield* resolveProfileBases(quickworkHomeOverride, signal)) {
    for (const id of yield* metricSessionIds(base.path, signal)) ids.add(id)
  }
  return ids
})

function basePathFor(source: SessionSource): string {
  if (source.sourcePath) return source.sourcePath
  return resolve(source.path, '..', '..')
}

function commonCallFields(source: SessionSource, basePath: string) {
  return {
    provider: 'quickdesk' as const,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    bashCommands: [] as string[],
    speed: 'standard' as const,
    project: source.project,
    projectPath: basePath,
  }
}

function createMetricsParser(
  source: SessionSource,
  seenKeys: Set<string>,
  pricing: ScanPricing,
  signal?: AbortSignal,
): SessionParser {
  const parseStream = (): Stream.Stream<ParsedProviderCall, Error> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const records = yield* readMetricsRecords(source.path, signal)
        const basePath = basePathFor(source)
        const linkedTools = collectMetricTools(records)
        const snapshot = yield* loadDatabaseSnapshot(basePath, signal)
        const fileId = basename(source.path)

        return Stream.fromIterable(records).pipe(
          Stream.mapEffect(
            ({ record }) =>
              Effect.gen(function* () {
                yield* checkScanAbort(signal)
                if (!usageRecord(record)) return null
                const model = stringValue(record.Model)
                const inputTokens = nonNegativeNumber(record.InputTokens)
                const outputTokens = nonNegativeNumber(record.OutputTokens)
                if (!model || inputTokens === undefined || outputTokens === undefined) return null
                const timestamp = metricsTimestamp(record, source.path)
                if (!timestamp) return null

                const linkedSessionId = sessionId(record)
                const metadata = linkedSessionId ? snapshot.sessions.get(linkedSessionId) : undefined
                if (metadata?.deleted) return null

                const fallbackId = `${source.project}:${fileId}`
                const deduplicationKey = `quickdesk:${linkedSessionId || fallbackId}:${timestamp}:${model}:${inputTokens}:${outputTokens}`
                if (seenKeys.has(deduplicationKey)) return null
                seenKeys.add(deduplicationKey)

                const recordedCost = nonNegativeNumber(record.CostUSD)
                const costIsEstimated = recordedCost === undefined
                const metricTools = linkedTools.get(sessionId(record)) ?? []
                const tools = uniqueMappedTools([...metricTools, ...(metadata?.tools ?? [])])
                const costUSD =
                  recordedCost ??
                  (yield* Effect.try({
                    try: () => pricing.calculateCost(model, inputTokens, outputTokens, 0, 0, 0),
                    catch: toError,
                  }))

                const call: ParsedProviderCall = {
                  ...commonCallFields(source, basePath),
                  model,
                  inputTokens,
                  outputTokens,
                  costUSD,
                  costIsEstimated,
                  tools,
                  timestamp,
                  deduplicationKey,
                  userMessage: metadata?.firstUserMessage ?? '',
                  sessionId: linkedSessionId || fileId,
                }
                return call
              }),
            { concurrency: 1 },
          ),
          Stream.filter((call): call is ParsedProviderCall => call !== null),
        )
      }),
    )

  return {
    parseStream,
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      yield* Stream.toAsyncIterable(parseStream())
    },
  }
}

function createDatabaseParser(
  source: SessionSource,
  seenKeys: Set<string>,
  pricing: ScanPricing,
  quickworkHomeOverride?: string,
  signal?: AbortSignal,
): SessionParser {
  const parseStream = (): Stream.Stream<ParsedProviderCall, Error> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const basePath = basePathFor(source)
        const snapshot = yield* loadDatabaseSnapshot(basePath, signal)
        if (!snapshot.canEstimate) return Stream.empty
        const meteredSessions = yield* allMetricSessionIds(quickworkHomeOverride, signal)

        return Stream.fromIterable(snapshot.sessions.values()).pipe(
          Stream.mapEffect(
            metadata =>
              Effect.gen(function* () {
                yield* checkScanAbort(signal)
                if (metadata.deleted || meteredSessions.has(metadata.id) || metadata.createdAt === undefined)
                  return null
                const createdAtSeconds =
                  metadata.createdAt > 1_000_000_000_000 ? metadata.createdAt / 1000 : metadata.createdAt
                const timestamp = unixSecondsIso(createdAtSeconds)
                if (!timestamp) return null
                const inputTokens = estimateTokensFromChars(metadata.inputChars)
                const outputTokens = estimateTokensFromChars(metadata.outputChars)
                if (inputTokens + outputTokens === 0) return null

                const deduplicationKey = `quickdesk-est:${metadata.id}`
                if (seenKeys.has(deduplicationKey)) return null
                seenKeys.add(deduplicationKey)
                const model = 'quickdesk-auto'
                const costUSD = yield* Effect.try({
                  try: () => pricing.calculateCost(model, inputTokens, outputTokens, 0, 0, 0),
                  catch: toError,
                })

                const call: ParsedProviderCall = {
                  ...commonCallFields(source, basePath),
                  model,
                  inputTokens,
                  outputTokens,
                  costUSD,
                  costIsEstimated: true,
                  tools: metadata.tools,
                  timestamp,
                  deduplicationKey,
                  userMessage: metadata.firstUserMessage,
                  sessionId: metadata.id,
                }
                return call
              }),
            { concurrency: 1 },
          ),
          Stream.filter((call): call is ParsedProviderCall => call !== null),
        )
      }),
    )

  return {
    parseStream,
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      yield* Stream.toAsyncIterable(parseStream())
    },
  }
}

export function createQuickdeskProvider(quickworkHomeOverride?: string): Provider {
  const discoverEffect = Effect.fn('discoverQuickdeskSessions')(function* (
    context?: ProviderScanContext,
  ): Effect.fn.Return<SessionSource[], Error> {
    yield* checkScanAbort(context?.signal)
    const sources = yield* discoverSources(quickworkHomeOverride, context?.signal)
    yield* checkScanAbort(context?.signal)
    return sources
  })

  return {
    name: 'quickdesk',
    displayName: 'Quick Desktop',
    durableSources: true,

    modelDisplayName(model: string): string {
      if (model === 'quickdesk-auto') return 'Quick Desktop (auto)'
      return modelDisplayNames[model] ?? model
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    async probeRoots(): Promise<ProbeRoot[]> {
      // Remove after Provider exposes an Effect-native probe-root hook.
      // eslint-disable-next-line no-restricted-syntax
      return (await Effect.runPromise(resolveProfileBases(quickworkHomeOverride))).map(base => ({
        path: base.path,
        label: base.profile,
      }))
    },

    discoverSessionsEffect: discoverEffect,
    discoverSessions(context?: ProviderScanContext): Promise<SessionSource[]> {
      // Remove this Promise edge when external discovery callers use the Effect hook.
      // eslint-disable-next-line no-restricted-syntax
      return Effect.runPromise(discoverEffect(context))
    },

    createSessionParser(
      source: SessionSource,
      seenKeys: Set<string>,
      _dateRange?: DateRange,
      context?: ProviderScanContext,
    ): SessionParser {
      const pricing = context?.pricing ?? captureScanPricing()
      return source.sourceId === 'sessions-db' || basename(source.path) === 'sessions.db'
        ? createDatabaseParser(source, seenKeys, pricing, quickworkHomeOverride, context?.signal)
        : createMetricsParser(source, seenKeys, pricing, context?.signal)
    },
  }
}

export const quickdesk = createQuickdeskProvider()
