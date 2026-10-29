import { randomBytes } from 'crypto'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Schema from 'effect/Schema'
import { stat } from 'fs/promises'
import { join } from 'path'

import { type ParsedProviderCall, parsedProviderCallSchema } from '@/shared/schemas/providers.js'
import { resolveCacheDir } from '@/infrastructure/config/environment.js'
import { isRecoverableCacheFailure, writeCacheTempFileEffect } from '@/infrastructure/ingestion/cache-file-write.js'
import { isScanAbortedError, throwIfScanAborted } from '@/core/ingestion/reconciliation/scan-control.js'

// v4: attribute MCP calls emitted as event_msg/mcp_tool_call_end (issue #478).
// Recent Codex sessions cached under v3 dropped these, so force a re-parse.
// v5: also attribute CLI-wrapped MCP calls (`mcp-cli call server tool`) that
// Codex logs as a plain exec_command (issue #478 follow-up). Force a re-parse
// so sessions cached under v4 pick up the CLI-MCP attribution.
// v6: rich-session-capture — per-call locAdded/locRemoved/editFailed from
// patch_apply_end. Sessions cached under v5 lack these fields; re-parse to add.
// v8: PR evidence — bounded `assistantText` on calls whose assistant message
// referenced a PR (e.g. the agent printing the URL it just created). Sessions
// cached under v7 lack the field; re-parse to add.
const CODEX_CACHE_VERSION = 8
const CACHE_FILE = 'codex-results.json'

export type FileFingerprint = { mtimeMs: number; sizeBytes: number }

const finiteNumber = Schema.Number.pipe(Schema.check(Schema.isFinite()))
const fileEntrySchema = Schema.Struct({
  mtimeMs: finiteNumber,
  sizeBytes: finiteNumber,
  project: Schema.String,
  calls: Schema.mutable(Schema.Array(parsedProviderCallSchema)),
})
const resultCacheSchema = Schema.Struct({
  version: Schema.Literal(CODEX_CACHE_VERSION),
  files: Schema.mutableKey(Schema.Record(Schema.String, Schema.mutableKey(fileEntrySchema))),
})
const resultCacheJsonSchema = Schema.fromJsonString(resultCacheSchema)
type FileEntry = typeof fileEntrySchema.Type
type ResultCache = typeof resultCacheSchema.Type

function getCacheDir(): string {
  return resolveCacheDir()
}

function getCachePath(): string {
  return join(getCacheDir(), CACHE_FILE)
}

let memCache: ResultCache | null = null

function abortCheck(signal?: AbortSignal): Effect.Effect<void, Error> {
  return Effect.try({ try: () => throwIfScanAborted(signal), catch: toError })
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

const loadCacheEffect = Effect.fnUntraced(function* (
  signal?: AbortSignal,
): Effect.fn.Return<ResultCache, Error, FileSystem.FileSystem> {
  yield* abortCheck(signal)
  if (memCache) return memCache
  const fs = yield* FileSystem.FileSystem
  const raw = yield* Effect.uninterruptible(fs.readFileString(getCachePath(), 'utf-8')).pipe(
    Effect.catch(() => Effect.succeed(null as string | null)),
  )
  yield* abortCheck(signal)
  const decoded =
    raw === null
      ? null
      : yield* Schema.decodeUnknownEffect(resultCacheJsonSchema)(raw).pipe(Effect.catch(() => Effect.succeed(null)))
  // Cache corruption is recoverable: reject the entire snapshot and reparse
  // sources instead of treating malformed calls as an empty successful cache.
  yield* abortCheck(signal)
  memCache = decoded ?? { version: CODEX_CACHE_VERSION, files: {} }
  return memCache
})

function getEntry(cache: ResultCache, filePath: string, fp: FileFingerprint): FileEntry | null {
  if (!Object.hasOwn(cache.files, filePath)) return null
  const entry = cache.files[filePath]
  if (entry && entry.mtimeMs === fp.mtimeMs && entry.sizeBytes === fp.sizeBytes) return entry
  return null
}

export type CodexCacheLookup = { calls: ParsedProviderCall[] | null; fingerprint: FileFingerprint | null }

function fingerprintEffect(filePath: string): Effect.Effect<FileFingerprint, Error> {
  return Effect.uninterruptible(
    Effect.tryPromise({
      try: () => stat(filePath).then(s => ({ mtimeMs: s.mtimeMs, sizeBytes: s.size })),
      catch: toError,
    }),
  )
}

/** Native lookup returns the stat fingerprint so a cold parser reuses it. */
export const lookupCachedCodexResultsEffect = Effect.fn('lookupCachedCodexResultsEffect')(function* (
  filePath: string,
  signal?: AbortSignal,
): Effect.fn.Return<CodexCacheLookup, Error, FileSystem.FileSystem> {
  yield* abortCheck(signal)
  const fingerprint = yield* fingerprintEffect(filePath).pipe(
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(null))),
  )
  yield* abortCheck(signal)
  if (!fingerprint) return { calls: null, fingerprint: null }
  const cache = yield* loadCacheEffect(signal)
  yield* abortCheck(signal)
  const entry = getEntry(cache, filePath, fingerprint)
  return { calls: entry?.calls ?? null, fingerprint }
})

export const getCachedCodexProjectEffect = Effect.fn('getCachedCodexProjectEffect')(function* (
  filePath: string,
  signal?: AbortSignal,
): Effect.fn.Return<string | null, Error, FileSystem.FileSystem> {
  yield* abortCheck(signal)
  const fingerprint = yield* fingerprintEffect(filePath).pipe(
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(null))),
  )
  yield* abortCheck(signal)
  if (!fingerprint) return null
  const cache = yield* loadCacheEffect(signal)
  yield* abortCheck(signal)
  return getEntry(cache, filePath, fingerprint)?.project ?? null
})

export const writeCachedCodexResultsEffect = Effect.fn('writeCachedCodexResultsEffect')(function* (
  filePath: string,
  project: string,
  calls: ParsedProviderCall[],
  fingerprint: FileFingerprint,
  signal?: AbortSignal,
): Effect.fn.Return<void, Error, FileSystem.FileSystem> {
  yield* abortCheck(signal)
  const cache = yield* loadCacheEffect(signal)
  yield* abortCheck(signal)
  cache.files[filePath] = {
    mtimeMs: fingerprint.mtimeMs,
    sizeBytes: fingerprint.sizeBytes,
    project,
    calls,
  }
})

export const flushCodexCacheEffect = Effect.fn('flushCodexCacheEffect')(
  function* (
    signal: AbortSignal | undefined,
  ): Effect.fn.Return<void, Error, import('effect/Scope').Scope | FileSystem.FileSystem> {
    yield* abortCheck(signal)
    if (!memCache) return
    const fs = yield* FileSystem.FileSystem
    const original = memCache
    const originalFiles = { ...original.files }
    const cache = { ...original, files: { ...originalFiles } }
    const missing = new Set<string>()
    let tempPath: string | undefined
    const cleanup = Effect.gen(function* () {
      if (tempPath) {
        const current = tempPath
        tempPath = undefined
        yield* Effect.uninterruptible(fs.remove(current, { force: true })).pipe(Effect.catch(() => Effect.void))
      }
    })
    yield* Effect.addFinalizer(() => cleanup)
    for (const path of Object.keys(cache.files)) {
      yield* abortCheck(signal)
      const exists = yield* fingerprintEffect(path).pipe(
        Effect.map(() => true),
        Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(false))),
      )
      if (!exists) missing.add(path)
    }
    if (missing.size > 0) {
      cache.files = Object.fromEntries(Object.entries(cache.files).filter(([path]) => !missing.has(path)))
    }
    yield* abortCheck(signal)
    const dir = getCacheDir()
    yield* Effect.uninterruptible(fs.makeDirectory(dir, { recursive: true }))
    yield* abortCheck(signal)
    const finalPath = getCachePath()
    const temporaryPath = `${finalPath}.${randomBytes(8).toString('hex')}.tmp`
    tempPath = temporaryPath
    const encoded = yield* Schema.encodeUnknownEffect(resultCacheSchema)(cache)
    const payload = JSON.stringify(encoded)
    yield* abortCheck(signal)
    yield* writeCacheTempFileEffect(fs, temporaryPath, payload, signal)
    yield* abortCheck(signal)
    const temporary = tempPath
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* fs.rename(temporary, finalPath)
        tempPath = undefined
      }),
    )
    yield* abortCheck(signal)
    if (memCache === original) {
      const concurrentWrites = Object.fromEntries(
        Object.entries(original.files).filter(([path, entry]) => originalFiles[path] !== entry),
      )
      memCache = { ...cache, files: { ...cache.files, ...concurrentWrites } }
    } else if (memCache) {
      const unchangedEntriesEvicted = new Set(
        [...missing].filter(path => memCache?.files[path] === original.files[path]),
      )
      if (unchangedEntriesEvicted.size > 0) {
        memCache = {
          ...memCache,
          files: Object.fromEntries(
            Object.entries(memCache.files).filter(([path]) => !unchangedEntriesEvicted.has(path)),
          ),
        }
      }
    }
  },
  Effect.catchCause(cause => (isRecoverableCacheFailure(cause) ? Effect.void : Effect.failCause(cause))),
)
