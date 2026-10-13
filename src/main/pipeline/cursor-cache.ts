import { randomBytes } from 'crypto'
import { Effect, Result, Schema } from 'effect'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

import { type ParsedProviderCall, parsedProviderCallSchema } from '../../shared/schemas/providers.js'
import { resolveCursorCacheSuppressWrites } from '../env.js'
import { isScanAbortedError, scanAbortError, throwIfScanAborted } from './scan-control.js'

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

/** Owns an uninterruptible Node promise until its native leaf has settled. */
function nativeLeaf<A>(operation: () => Promise<A>, signal?: AbortSignal): Effect.Effect<A, Error> {
  return Effect.scoped(
    Effect.gen(function* () {
      const owned = yield* Effect.acquireRelease(
        Effect.sync(() => {
          let settled = false
          const promise = Promise.resolve()
            .then(() => {
              throwIfScanAborted(signal)
              return operation()
            })
            .finally(() => {
              settled = true
            })
          const drained = promise.then(
            () => undefined,
            () => undefined,
          )
          return { promise, drained, isSettled: () => settled }
        }),
        resource => Effect.promise(() => (resource.isSettled() ? Promise.resolve() : resource.drained)),
      )
      return yield* Effect.tryPromise({
        try: () => owned.promise,
        catch: cause => (signal?.aborted ? scanAbortError(signal) : toError(cause)),
      })
    }),
  )
}

function getDbFingerprint(
  dbPath: string,
  signal?: AbortSignal,
): Effect.Effect<{ mtimeMs: number; size: number } | null, Error> {
  return nativeLeaf(() => stat(dbPath).then(file => ({ mtimeMs: file.mtimeMs, size: file.size })), signal).pipe(
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(null))),
  )
}

export const readCachedResultsEffect = Effect.fn('readCachedResultsEffect')(function* (
  dbPath: string,
  requestedFloor: string,
  signal?: AbortSignal,
): Effect.fn.Return<ParsedProviderCall[] | null, Error> {
  yield* abortCheck(signal)
  const fingerprint = yield* getDbFingerprint(dbPath, signal)
  if (!fingerprint) return null
  const raw = yield* nativeLeaf(() => readFile(getCachePath(), 'utf-8'), signal).pipe(
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
): Effect.fn.Return<void, Error, import('effect/Scope').Scope> {
  yield* abortCheck(signal)
  if (suppressWrites ?? resolveCursorCacheSuppressWrites(process.env['WATCHTOWER_SUPPRESS_CACHE_WRITES'])) return
  const fingerprint = yield* getDbFingerprint(dbPath, signal)
  if (!fingerprint) return

  const dir = getCacheDir()
  yield* nativeLeaf(() => mkdir(dir, { recursive: true }), signal).pipe(
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
  let tempPath: string | undefined = `${target}.${randomBytes(8).toString('hex')}.tmp`
  const cleanup = Effect.gen(function* () {
    if (!tempPath) return
    const ownedPath = tempPath
    tempPath = undefined
    yield* nativeLeaf(() => unlink(ownedPath)).pipe(Effect.catch(() => Effect.void))
  })
  yield* Effect.addFinalizer(() => cleanup)
  const stagedPath = tempPath
  yield* nativeLeaf(
    () => writeFile(stagedPath, JSON.stringify(encoded), { encoding: 'utf-8', mode: 0o600 }),
    signal,
  ).pipe(Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.void)))
  yield* abortCheck(signal)
  yield* nativeLeaf(() => rename(stagedPath, target), signal).pipe(
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.void)),
  )
  tempPath = undefined
})

// Promise adapters remain for callers that have not migrated to the native
// Effect hook yet. Cursor parsing itself composes the effects above directly.
export async function readCachedResults(dbPath: string, requestedFloor: string): Promise<ParsedProviderCall[] | null> {
  return Effect.runPromise(readCachedResultsEffect(dbPath, requestedFloor))
}

export async function writeCachedResults(
  dbPath: string,
  calls: ParsedProviderCall[],
  lookbackFloor: string,
  suppressWrites?: boolean,
): Promise<void> {
  return Effect.runPromise(Effect.scoped(writeCachedResultsEffect(dbPath, calls, lookbackFloor, suppressWrites)))
}
