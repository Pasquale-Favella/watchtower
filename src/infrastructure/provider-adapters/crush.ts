import { readFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { join, resolve } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'

import { type AppPaths, overrideFor, platformFor } from '@/infrastructure/config/environment.js'
import { fileErrorCode, reportProviderIssue } from '@/infrastructure/ingestion/file-errors.js'
import { captureScanPricing } from '@/infrastructure/pricing/models.js'
import { isScanAbortedError } from '@/core/ingestion/reconciliation/scan-control.js'
import { checkScanAbort, scanIo } from '@/infrastructure/ingestion/scan-io.js'
import { blobToText, isSqliteAvailable, openDatabase, type SqliteDatabase } from '@/infrastructure/ingestion/sqlite.js'
import type { DateRange } from '@/core/domain/observations/types.js'
import type {
  ParsedProviderCall,
  Provider,
  ProviderScanContext,
  SessionParser,
  SessionSource,
} from '@/infrastructure/provider-adapters/types.js'

/// Crush stores per-project SQLite databases discovered through a JSON registry.
/// We only read both. Schema source: charmbracelet/crush
/// internal/db/migrations/20250424200609_initial.sql, verified against v0.66.1.
/// The schema comments claim millisecond timestamps, but inserts in
/// internal/db/sql/{sessions,messages}.sql use strftime('%s', 'now'), which
/// returns Unix seconds. We treat values as seconds.

const registryEntrySchema = Schema.Struct({ path: Schema.String, data_dir: Schema.String })
const registryArraySchema = Schema.Array(Schema.Unknown)
const registryObjectSchema = Schema.Record(Schema.String, Schema.Unknown)
const registryRootSchema = Schema.Union([registryArraySchema, registryObjectSchema])
const sessionRowSchema = Schema.Struct({
  prompt_tokens: Schema.Unknown,
  completion_tokens: Schema.Unknown,
  cost: Schema.Unknown,
  created_at: Schema.Unknown,
  updated_at: Schema.Unknown,
})
const discoveredSessionRowSchema = Schema.Struct({ id: Schema.Uint8Array })
const modelRowSchema = Schema.Struct({ model: Schema.NullOr(Schema.Uint8Array) })

const decodeRegistryRoot = Schema.decodeUnknownResult(registryRootSchema)
const decodeRegistryEntry = Schema.decodeUnknownResult(registryEntrySchema)
const decodeSessionRow = Schema.decodeUnknownResult(sessionRowSchema)
const decodeDiscoveredSessionRow = Schema.decodeUnknownResult(discoveredSessionRowSchema)
const decodeModelRow = Schema.decodeUnknownResult(modelRowSchema)
const decodeFinite = Schema.decodeUnknownResult(Schema.Finite)
const decodeBytes = Schema.decodeUnknownResult(Schema.Uint8Array)
const decodeRegistryJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))

type ProjectEntry = Schema.Schema.Type<typeof registryEntrySchema>
type SessionRow = Schema.Schema.Type<typeof sessionRowSchema>

class CrushDatabaseError extends Schema.TaggedError<CrushDatabaseError>()('CrushDatabaseError', {
  operation: Schema.Literals(['open', 'read', 'close']),
  cause: Schema.Defect(),
  message: Schema.String,
}) {}

type OwnedDatabase = { db: SqliteDatabase; closed: boolean }

export function getRegistryPath(paths?: AppPaths): string {
  const explicit = overrideFor(paths, 'CRUSH_GLOBAL_DATA')
  if (explicit) return join(explicit, 'projects.json')

  // `platform` is the OS module's, not the snapshot's. AppPaths carries
  // platform roots, never an OS name.
  if (platform() === 'win32') {
    const localAppData = platformFor(paths).localAppData ?? join(homedir(), 'AppData', 'Local')
    return join(localAppData, 'crush', 'projects.json')
  }

  const xdg = platformFor(paths).xdgDataHome ?? join(homedir(), '.local', 'share')
  return join(xdg, 'crush', 'projects.json')
}

function decodeRegistryEntries(value: unknown): ProjectEntry[] {
  const root = decodeRegistryRoot(value)
  if (Result.isFailure(root)) return []
  const rawEntries = Array.isArray(root.success) ? root.success : Object.values(root.success)

  return rawEntries.flatMap(raw => {
    const entry = decodeRegistryEntry(raw)
    return Result.isSuccess(entry) ? [entry.success] : []
  })
}

const loadRegistry = Effect.fnUntraced(function* (
  path: string,
  signal?: AbortSignal,
): Effect.fn.Return<ProjectEntry[], Error> {
  const raw = yield* scanIo(() => readFile(path, 'utf8'), signal).pipe(
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(null as string | null))),
  )
  if (raw === null) return []

  const decoded = decodeRegistryJson(raw)
  if (Result.isFailure(decoded)) return []
  return decodeRegistryEntries(decoded.success)
})

function resolveDbPath(entry: ProjectEntry): string {
  // data_dir defaults to ".crush" relative to the project path. Absolute
  // paths are honored if the user has changed the layout.
  return join(resolve(entry.path, entry.data_dir), 'crush.db')
}

function sanitizeProject(path: string): string {
  return path.replace(/^\//, '').replace(/\//g, '-')
}

function databaseError(operation: CrushDatabaseError['operation'], cause: unknown): CrushDatabaseError {
  const error = cause instanceof Error ? cause : new Error(String(cause), { cause })
  return new CrushDatabaseError({ operation, cause: error, message: error.message })
}

function closeDatabase(source: OwnedDatabase): Effect.Effect<void, CrushDatabaseError> {
  return Effect.suspend(() => {
    if (source.closed) return Effect.void
    source.closed = true
    return Effect.try({ try: () => source.db.close(), catch: cause => databaseError('close', cause) })
  })
}

function validateSchema(db: SqliteDatabase): Effect.Effect<boolean> {
  return Effect.try({
    try: () => {
      db.query('SELECT 1 FROM sessions WHERE 0')
      db.query('SELECT 1 FROM messages WHERE 0')
    },
    catch: cause => databaseError('read', cause),
  }).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  )
}

function epochSecondsToIso(value: unknown): string {
  const decoded = decodeFinite(value)
  if (Result.isFailure(decoded)) return new Date(0).toISOString()
  return new Date(decoded.success * 1000).toISOString()
}

function dominantModel(db: SqliteDatabase, sessionId: string): Effect.Effect<string, CrushDatabaseError> {
  return Effect.try({
    try: () =>
      db.query(
        `SELECT CAST(model AS BLOB) AS model FROM messages
         WHERE session_id = ? AND model IS NOT NULL AND model <> ''
         GROUP BY model
         ORDER BY COUNT(*) DESC
         LIMIT 1`,
        [sessionId],
      ),
    catch: cause => databaseError('read', cause),
  }).pipe(
    Effect.map(rows => {
      const decoded = decodeModelRow(rows[0])
      return Result.isSuccess(decoded) && decoded.success.model ? blobToText(decoded.success.model) : 'unknown'
    }),
    Effect.catch(() => Effect.succeed('unknown')),
  )
}

function splitSourcePath(path: string): { dbPath: string; sessionId: string } {
  const segments = path.split(':')
  const sessionId = segments.pop() ?? ''
  return { dbPath: segments.join(':'), sessionId }
}

function openDatabaseEffect(path: string): Effect.Effect<OwnedDatabase, CrushDatabaseError> {
  return Effect.try({
    try: () => ({ db: openDatabase(path), closed: false }),
    catch: cause => databaseError('open', cause),
  })
}

function discoveryRows(db: SqliteDatabase): Record<string, unknown>[] {
  return db.query(
    `SELECT CAST(id AS BLOB) AS id FROM sessions
     WHERE parent_session_id IS NULL
       AND (cost > 0 OR prompt_tokens > 0 OR completion_tokens > 0)
     ORDER BY created_at DESC`,
  )
}

function sqliteValueProjection(column: string): string {
  return `CASE WHEN ${column} IS NULL OR typeof(${column}) IN ('integer', 'real')
    THEN ${column} ELSE CAST(${column} AS BLOB) END AS ${column}`
}

function numericComparisonValue(value: unknown): unknown {
  const bytes = decodeBytes(value)
  return Result.isSuccess(bytes) ? blobToText(bytes.success) : value
}

const discoverFromDb = Effect.fnUntraced(function* (
  dbPath: string,
  project: string,
  signal?: AbortSignal,
): Effect.fn.Return<SessionSource[], Error> {
  yield* checkScanAbort(signal)
  if (!isSqliteAvailable()) return []

  const acquired = yield* Effect.result(
    Effect.acquireUseRelease(
      openDatabaseEffect(dbPath),
      source =>
        Effect.result(
          Effect.gen(function* () {
            if (!(yield* validateSchema(source.db))) return []
            const rows = yield* Effect.try({
              try: () => discoveryRows(source.db),
              catch: cause => databaseError('read', cause),
            })
            return rows.flatMap(raw => {
              const decoded = decodeDiscoveredSessionRow(raw)
              if (Result.isFailure(decoded)) return []
              const id = blobToText(decoded.success.id)
              return [{ path: `${dbPath}:${id}`, project, provider: 'crush' as const }]
            })
          }),
        ),
      source => closeDatabase(source),
    ),
  )

  yield* checkScanAbort(signal)
  if (Result.isFailure(acquired)) {
    if (acquired.failure instanceof CrushDatabaseError && acquired.failure.operation === 'close') {
      return yield* Effect.fail(acquired.failure)
    }
    return []
  }
  if (Result.isFailure(acquired.success)) return []
  return acquired.success.success
})

const discoverSessionsEffect = Effect.fn('discoverCrushSessions')(function* (
  registryPath: string,
  context?: ProviderScanContext,
): Effect.fn.Return<SessionSource[], Error> {
  const signal = context?.signal
  yield* checkScanAbort(signal)
  if (!isSqliteAvailable()) return []

  const sources: SessionSource[] = []
  for (const entry of yield* loadRegistry(registryPath, signal)) {
    yield* checkScanAbort(signal)
    const dbPath = resolveDbPath(entry)
    sources.push(...(yield* discoverFromDb(dbPath, sanitizeProject(entry.path), signal)))
  }
  return sources
})

function createParser(source: SessionSource, seenKeys: Set<string>, context?: ProviderScanContext): SessionParser {
  // Remove the factory fallback when every direct Crush parser caller supplies
  // the scan-owned pricing snapshot.
  const pricing = context?.pricing ?? captureScanPricing()
  const signal = context?.signal
  const split = splitSourcePath(source.path)

  const parseStream: NonNullable<SessionParser['parseStream']> = (onUnparsedCall = Effect.void) =>
    Stream.scoped(
      Stream.unwrap(
        Effect.gen(function* () {
          yield* checkScanAbort(signal)
          if (!isSqliteAvailable()) {
            reportProviderIssue('crush', 'sqlite-unavailable')
            return Stream.empty
          }

          const acquired = yield* Effect.acquireRelease(
            openDatabaseEffect(split.dbPath).pipe(
              Effect.catchTag('CrushDatabaseError', error => {
                if (error.operation === 'open') {
                  reportProviderIssue('crush', fileErrorCode(error.cause, 'db-open-failed'))
                  return Effect.succeed(null)
                }
                return Effect.fail(error)
              }),
            ),
            database => (database ? closeDatabase(database).pipe(Effect.orDie) : Effect.void),
          )
          if (!acquired) return Stream.empty
          const db = acquired.db
          if (!(yield* validateSchema(db))) return Stream.fromEffectDrain(closeDatabase(acquired))
          yield* checkScanAbort(signal)

          const rows = yield* Effect.try({
            try: () =>
              db.query(
                `SELECT ${sqliteValueProjection('prompt_tokens')},
                        ${sqliteValueProjection('completion_tokens')},
                        ${sqliteValueProjection('cost')},
                        ${sqliteValueProjection('created_at')},
                        ${sqliteValueProjection('updated_at')}
                 FROM sessions
                 WHERE id = ? AND parent_session_id IS NULL`,
                [split.sessionId],
              ),
            catch: cause => databaseError('read', cause),
          })
          yield* checkScanAbort(signal)
          const decoded = decodeSessionRow(rows[0])
          if (Result.isFailure(decoded)) return Stream.fromEffectDrain(closeDatabase(acquired))
          const session: SessionRow = decoded.success
          const rawInputTokens = session.prompt_tokens ?? 0
          const rawOutputTokens = session.completion_tokens ?? 0
          const rawCost = session.cost ?? 0
          if (rawInputTokens === 0 && rawOutputTokens === 0 && rawCost === 0) {
            return Stream.fromEffectDrain(closeDatabase(acquired))
          }

          const deduplicationKey = `crush:${split.sessionId}`
          if (seenKeys.has(deduplicationKey)) return Stream.fromEffectDrain(closeDatabase(acquired))
          seenKeys.add(deduplicationKey)

          const decodedInputTokens = decodeFinite(rawInputTokens)
          const decodedOutputTokens = decodeFinite(rawOutputTokens)
          if (Result.isFailure(decodedInputTokens) || Result.isFailure(decodedOutputTokens)) {
            yield* onUnparsedCall
            return Stream.fromEffectDrain(closeDatabase(acquired))
          }
          const inputTokens = decodedInputTokens.success
          const outputTokens = decodedOutputTokens.success

          let recordedCost = 0
          if (Number(numericComparisonValue(rawCost)) > 0) {
            const decodedCost = decodeFinite(rawCost)
            if (Result.isFailure(decodedCost)) {
              yield* onUnparsedCall
              return Stream.fromEffectDrain(closeDatabase(acquired))
            }
            recordedCost = decodedCost.success
          }

          const model = yield* dominantModel(db, split.sessionId)
          const costUSD = yield* Effect.try({
            try: () =>
              recordedCost > 0 ? recordedCost : pricing.calculateCost(model, inputTokens, outputTokens, 0, 0, 0),
            catch: cause => (cause instanceof Error ? cause : new Error(String(cause), { cause })),
          })
          const call: ParsedProviderCall = {
            provider: 'crush',
            model,
            inputTokens,
            outputTokens,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            cachedInputTokens: 0,
            reasoningTokens: 0,
            webSearchRequests: 0,
            costUSD,
            tools: [],
            bashCommands: [],
            timestamp: epochSecondsToIso(session.updated_at ?? session.created_at),
            speed: 'standard',
            deduplicationKey,
            userMessage: '',
            sessionId: split.sessionId,
          }
          return Stream.succeed(call).pipe(Stream.concat(Stream.fromEffectDrain(closeDatabase(acquired))))
        }),
      ),
    )

  return {
    parseStream,
  }
}

export function createCrushProvider(paths?: AppPaths): Provider {
  const discover = (context?: ProviderScanContext) =>
    Effect.suspend(() => discoverSessionsEffect(getRegistryPath(paths), context))
  return {
    name: 'crush',
    displayName: 'Crush',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
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

export const crush = createCrushProvider()
