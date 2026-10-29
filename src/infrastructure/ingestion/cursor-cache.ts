import { randomBytes } from 'crypto'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as FileSystem from 'effect/FileSystem'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import { stat } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

import { type ParsedProviderCall, parsedProviderCallSchema } from '@/shared/schemas/providers.js'
import { resolveCursorCacheSuppressWrites } from '@/infrastructure/config/environment.js'
import { isRecoverableCacheFailure, writeCacheTempFileEffect } from '@/infrastructure/ingestion/cache-file-write.js'
import { isScanAbortedError, throwIfScanAborted } from '@/core/ingestion/reconciliation/scan-control.js'

// Bumped to 3 for the workspace-aware breakdown change: the cursor parser
// now derives `sessionId` from the bubble row key (the real composer id)
// rather than the empty `conversationId` JSON field, and the workspace
// router relies on those composer ids to bucket calls per project.
// Version 2 caches contain `sessionId: 'unknown'` for every call and would
// route everything to the orphan project, so we invalidate them.
// Version 5: parseAgentKv was removed (it double-counted against bubbles);
// real context tokens from composerData.promptTokenBreakdown now drive
// input, and agentKv is used only for the tools/bash breakdown. Cached v4
// results contain stale agentKv calls and lack the real token figures.
// Version 6: conversation input moved to composer-anchored records
// (cursor:composer-input:<id>) with per-conversation source selection, the
// agent stream regained tool/system context and stream-only sessions, and
// tool names are canonicalized. v5 results mix crediting regimes.
const CURSOR_CACHE_VERSION = 6
const CACHE_FILE = 'cursor-results.json'

const finiteNumber = Schema.Number.pipe(Schema.check(Schema.isFinite()))
const resultCacheSchema = Schema.Struct({
  version: Schema.Literal(CURSOR_CACHE_VERSION),
  dbMtimeMs: finiteNumber,
  dbSizeBytes: finiteNumber,
  lookbackFloor: Schema.String,
  calls: Schema.mutable(Schema.Array(parsedProviderCallSchema)),
})
const resultCacheJsonSchema = Schema.fromJsonString(resultCacheSchema)
const decodeResultCache = Schema.decodeUnknownResult(resultCacheJsonSchema)

function getCacheDir(): string {
  return join(homedir(), '.cache', 'watchtower')
}

function getCachePath(): string {
  return join(getCacheDir(), CACHE_FILE)
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause), { cause })
}

function abortCheck(signal?: AbortSignal): Effect.Effect<void, Error> {
  return Effect.try({ try: () => throwIfScanAborted(signal), catch: toError })
}

function getDbFingerprint(dbPath: string): Effect.Effect<{ mtimeMs: number; size: number } | null, Error> {
  return Effect.uninterruptible(
    Effect.tryPromise({
      try: () => stat(dbPath).then(file => ({ mtimeMs: file.mtimeMs, size: file.size })),
      catch: toError,
    }),
  ).pipe(Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(null))))
}

export const readCachedResultsEffect = Effect.fn('readCachedResultsEffect')(function* (
  dbPath: string,
  requestedFloor: string,
  signal?: AbortSignal,
): Effect.fn.Return<ParsedProviderCall[] | null, Error, FileSystem.FileSystem> {
  yield* abortCheck(signal)
  const fingerprint = yield* getDbFingerprint(dbPath)
  if (!fingerprint) return null
  const fs = yield* FileSystem.FileSystem
  const raw = yield* Effect.uninterruptible(fs.readFileString(getCachePath(), 'utf-8')).pipe(
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(null))),
  )
  yield* abortCheck(signal)
  if (raw === null) return null
  const decoded = decodeResultCache(raw)
  if (Result.isFailure(decoded)) return null
  const cache = decoded.success
  if (
    cache.dbMtimeMs !== fingerprint.mtimeMs ||
    cache.dbSizeBytes !== fingerprint.size ||
    cache.lookbackFloor > requestedFloor
  ) {
    return null
  }
  return cache.calls
})

export const writeCachedResultsEffect = Effect.fn('writeCachedResultsEffect')(function* (
  dbPath: string,
  calls: ParsedProviderCall[],
  lookbackFloor: string,
  suppressWrites?: boolean,
  signal?: AbortSignal,
): Effect.fn.Return<void, Error, FileSystem.FileSystem> {
  yield* abortCheck(signal)
  if (suppressWrites ?? resolveCursorCacheSuppressWrites(process.env['WATCHTOWER_SUPPRESS_CACHE_WRITES'])) return
  const fs = yield* FileSystem.FileSystem
  const fingerprint = yield* getDbFingerprint(dbPath)
  if (!fingerprint) return

  const dir = getCacheDir()
  yield* Effect.uninterruptible(fs.makeDirectory(dir, { recursive: true })).pipe(
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.void)),
  )
  yield* abortCheck(signal)
  const cache = {
    version: CURSOR_CACHE_VERSION,
    dbMtimeMs: fingerprint.mtimeMs,
    dbSizeBytes: fingerprint.size,
    lookbackFloor,
    calls,
  }
  const encoded = yield* Schema.encodeUnknownEffect(resultCacheSchema)(cache).pipe(
    Effect.catch(() => Effect.succeed(null)),
  )
  if (encoded === null) return
  const target = getCachePath()
  yield* Effect.scoped(
    Effect.gen(function* () {
      let tempPath: string | undefined = `${target}.${randomBytes(8).toString('hex')}.tmp`
      yield* Effect.addFinalizer(() =>
        Effect.suspend(() => {
          if (!tempPath) return Effect.void
          const ownedPath = tempPath
          tempPath = undefined
          return Effect.uninterruptible(fs.remove(ownedPath, { force: true })).pipe(Effect.catch(() => Effect.void))
        }),
      )
      const stagedPath = tempPath
      const staged = yield* Effect.exit(writeCacheTempFileEffect(fs, stagedPath, JSON.stringify(encoded), signal))
      if (Exit.isFailure(staged)) {
        if (isRecoverableCacheFailure(staged.cause)) return
        return yield* Effect.failCause(staged.cause)
      }
      const committed = yield* Effect.result(
        Effect.uninterruptible(
          Effect.gen(function* () {
            yield* fs.rename(stagedPath, target)
            tempPath = undefined
          }),
        ),
      )
      if (Result.isFailure(committed)) {
        if (isScanAbortedError(committed.failure)) return yield* Effect.fail(committed.failure)
      }
    }),
  )
})
