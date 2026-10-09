import { basename } from 'node:path'

import { Effect, Result, Stream } from 'effect'
import { createReadStream, readFileSync, statSync } from 'fs'
import { readFile, stat } from 'fs/promises'

import { type AppPaths, overrideFor } from '../env.js'
import { logFileName, queueLogRecord } from './file-errors.js'
import { throwIfScanAborted } from './scan-control.js'

// Hard cap well below V8's 512 MB string limit. Callers that need line-by-line
// processing should use readSessionLines(), which avoids materializing the
// whole file and can return large lines as Buffers.
export const MAX_SESSION_FILE_BYTES = 128 * 1024 * 1024
export const LARGE_STREAM_LINE_BYTES = 32 * 1024

// Line-by-line streaming has bounded memory (one line at a time) and is not
// constrained by V8's string limit, so it can safely handle multi-GB session
// files. Heavy Codex sessions routinely reach several GB (image-heavy compacted
// turns), so the cap is generous and exists only to guard against truly
// pathological inputs. When a file IS skipped, notice() surfaces it (always on,
// not verbose-gated) so a dropped session never silently understates usage.
export const MAX_STREAM_SESSION_FILE_BYTES = 4 * 1024 * 1024 * 1024

/**
 * The one verbose-gate read in this module, through the `AppPaths` seam
 * (`overrideFor`, so an unthreaded caller reads the same `process.env` value it
 * always did). The `=== '1'` comparison is deliberately strict equality:
 * 'true' or 'yes' never enabled it, and that has not changed. Callers inside
 * this module call it with no argument, so they compile and behave as before.
 */
function verbose(paths?: AppPaths): boolean {
  return overrideFor(paths, 'WATCHTOWER_VERBOSE') === '1'
}

function warn(msg: string): void {
  if (verbose()) process.stderr.write(`watchtower: ${msg}\n`)
}

/** Basename a path for verbose diagnostics — absolute paths embed usernames
 * and never reach even opt-in console output (#131). */
function shortPath(filePath: string): string {
  return basename(filePath)
}

// Always surfaced (not verbose-gated): dropping an entire session file silently
// understates reported usage with no signal, so oversize skips queue a log
// record (basename + code, drained into the Operational log after the scan)
// instead of writing the console.
function notice(filePath: string, code: string): void {
  queueLogRecord({
    logEvent: 'scan.file-error',
    level: 'warn',
    fields: { op: 'scan', file: logFileName(filePath), code },
  })
}

export const readSessionFileEffect = Effect.fn('readSessionFile')(function* (
  filePath: string,
  encoding: BufferEncoding = 'utf-8',
  options: { readonly signal?: AbortSignal } = {},
): Effect.fn.Return<string | null, Error> {
  const checkAbort = Effect.try({ try: () => throwIfScanAborted(options.signal), catch: toError })
  yield* checkAbort
  const statResult = yield* Effect.uninterruptible(
    Effect.result(Effect.tryPromise({ try: () => stat(filePath), catch: toError })),
  )
  yield* checkAbort
  if (Result.isFailure(statResult)) {
    warn(`stat failed for ${shortPath(filePath)}: ${errorCode(statResult.failure)}`)
    return null
  }
  const size = statResult.success.size
  if (size > MAX_SESSION_FILE_BYTES) {
    warn(`skipped oversize file ${shortPath(filePath)} (${size} bytes > cap ${MAX_SESSION_FILE_BYTES})`)
    return null
  }

  const readResult = yield* Effect.uninterruptible(
    Effect.result(
      Effect.tryPromise({ try: () => readFile(filePath, { encoding, signal: options.signal }), catch: toError }),
    ),
  )
  yield* checkAbort
  if (Result.isFailure(readResult)) {
    warn(`read failed for ${shortPath(filePath)}: ${errorCode(readResult.failure)}`)
    return null
  }
  return readResult.success
})

/** Remove this Promise edge when the remaining provider/helper callers use native Effects. */
export function readSessionFile(
  filePath: string,
  encoding: BufferEncoding = 'utf-8',
  options: { readonly signal?: AbortSignal } = {},
): Promise<string | null> {
  return Effect.runPromise(readSessionFileEffect(filePath, encoding, options))
}

export function readSessionFileSync(filePath: string): string | null {
  let size: number
  try {
    size = statSync(filePath).size
  } catch (err) {
    warn(`stat failed for ${shortPath(filePath)}: ${(err as NodeJS.ErrnoException).code ?? 'unknown'}`)
    return null
  }

  if (size > MAX_SESSION_FILE_BYTES) {
    warn(`skipped oversize file ${shortPath(filePath)} (${size} bytes > cap ${MAX_SESSION_FILE_BYTES})`)
    return null
  }

  try {
    return readFileSync(filePath, 'utf-8')
  } catch (err) {
    warn(`read failed for ${shortPath(filePath)}: ${(err as NodeJS.ErrnoException).code ?? 'unknown'}`)
    return null
  }
}

export type SessionLine = string | Buffer

type ReadSessionLinesOptions = {
  largeLineAsBuffer?: boolean
  largeLineThresholdBytes?: number
  startByteOffset?: number
  byteOffsetTracker?: { lastCompleteLineOffset: number }
  maxBytes?: number
  signal?: AbortSignal
}

export function readSessionLines(filePath: string, shouldSkipHead?: (head: string) => boolean): AsyncGenerator<string>
export function readSessionLines(
  filePath: string,
  shouldSkipHead: ((head: string) => boolean) | undefined,
  options: ReadSessionLinesOptions & { largeLineAsBuffer?: false },
): AsyncGenerator<string>
export function readSessionLines(
  filePath: string,
  shouldSkipHead?: (head: string) => boolean,
  options?: ReadSessionLinesOptions & { largeLineAsBuffer: true },
): AsyncGenerator<SessionLine>
export async function* readSessionLines(
  filePath: string,
  shouldSkipHead?: (head: string) => boolean,
  options: ReadSessionLinesOptions = {},
): AsyncGenerator<SessionLine> {
  throwIfScanAborted(options.signal)
  let size: number
  try {
    size = (await stat(filePath)).size
  } catch (err) {
    throwIfScanAborted(options.signal)
    warn(`stat failed for ${shortPath(filePath)}: ${(err as NodeJS.ErrnoException).code ?? 'unknown'}`)
    return
  }
  throwIfScanAborted(options.signal)

  const maxBytes = options.maxBytes ?? MAX_STREAM_SESSION_FILE_BYTES
  if (size > maxBytes) {
    notice(filePath, 'oversize')
    return
  }

  const stream = createReadStream(filePath, {
    ...(options.startByteOffset !== undefined ? { start: options.startByteOffset } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })
  const closed = new Promise<void>(resolve => stream.once('close', () => resolve()))
  try {
    yield* splitNativeSessionLines(stream, filePath, shouldSkipHead, options)
  } catch (err) {
    throwIfScanAborted(options.signal)
    warn(`stream read failed for ${shortPath(filePath)}: ${(err as NodeJS.ErrnoException).code ?? 'unknown'}`)
  } finally {
    stream.destroy()
    await closed
  }
}

/**
 * Effect-native counterpart for workflows that already run in a Stream.
 * The ReadStream is acquired only when pulled and remains owned by the stream
 * scope until its async iterator has stopped and the native `close` event has
 * drained. Unlike `readSessionLines`, this does not build on that legacy
 * AsyncGenerator boundary.
 */
export function readSessionLinesStream(
  filePath: string,
  shouldSkipHead?: (head: string) => boolean,
  options: ReadSessionLinesOptions = {},
): Stream.Stream<SessionLine, Error> {
  const scoped = Stream.unwrap(
    Effect.gen(function* () {
      yield* Effect.try({ try: () => throwIfScanAborted(options.signal), catch: toError })
      const statResult = yield* Effect.uninterruptible(
        Effect.result(Effect.tryPromise({ try: () => stat(filePath), catch: toError })),
      )
      if (Result.isFailure(statResult)) {
        if (options.signal?.aborted) {
          yield* Effect.try({ try: () => throwIfScanAborted(options.signal), catch: toError })
        }
        warn(`stat failed for ${shortPath(filePath)}: ${errorCode(statResult.failure)}`)
        return Stream.empty
      }
      const size = statResult.success.size
      yield* Effect.try({ try: () => throwIfScanAborted(options.signal), catch: toError })

      const maxBytes = options.maxBytes ?? MAX_STREAM_SESSION_FILE_BYTES
      if (size > maxBytes) {
        notice(filePath, 'oversize')
        return Stream.empty
      }

      const owned = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            (() => {
              const stream = createReadStream(filePath, {
                ...(options.startByteOffset !== undefined ? { start: options.startByteOffset } : {}),
                ...(options.signal ? { signal: options.signal } : {}),
              })
              const iterator = splitNativeSessionLines(stream, filePath, shouldSkipHead, options)[
                Symbol.asyncIterator
              ]()
              return { stream, iterator }
            })(),
          catch: toError,
        }),
        resource =>
          Effect.promise(async () => {
            if (!resource.stream.closed) {
              const closed = new Promise<void>(resolve => resource.stream.once('close', resolve))
              resource.stream.destroy()
              await closed
            }
            await resource.iterator.return?.(undefined)
          }),
      )
      return Stream.unfold(owned.iterator, iterator =>
        Effect.tryPromise({ try: () => iterator.next(), catch: toError }).pipe(
          Effect.map(next => (next.done ? undefined : ([next.value, iterator] as const))),
        ),
      )
    }),
  )
  return Stream.scoped(scoped)
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'unknown'
}

async function* splitNativeSessionLines(
  stream: ReturnType<typeof createReadStream>,
  filePath: string,
  shouldSkipHead: ((head: string) => boolean) | undefined,
  options: ReadSessionLinesOptions,
): AsyncGenerator<SessionLine> {
  const SKIP_HEAD = 2048
  const largeLineThreshold = options.largeLineThresholdBytes ?? LARGE_STREAM_LINE_BYTES
  const formatLine = (buf: Buffer, lineLen: number, head?: string): SessionLine => {
    if (options.largeLineAsBuffer && lineLen > largeLineThreshold) return buf
    return head !== undefined && lineLen <= SKIP_HEAD ? head : buf.toString('utf-8')
  }
  let parts: Buffer[] = []
  let len = 0
  let skipping = false
  let headChecked = false
  let chunkBase = options.startByteOffset ?? 0
  const tracker = options.byteOffsetTracker

  try {
    for await (const raw of stream) {
      throwIfScanAborted(options.signal)
      const chunk = raw as Buffer
      let pos = 0
      while (pos < chunk.length) {
        throwIfScanAborted(options.signal)
        const nl = chunk.indexOf(0x0a, pos)
        if (skipping) {
          if (nl === -1) pos = chunk.length
          else {
            if (tracker) tracker.lastCompleteLineOffset = chunkBase + nl + 1
            skipping = false
            pos = nl + 1
          }
          continue
        }
        if (nl !== -1) {
          if (pos < nl) {
            parts.push(chunk.subarray(pos, nl))
            len += nl - pos
          }
          pos = nl + 1
          if (tracker) tracker.lastCompleteLineOffset = chunkBase + pos
          if (len === 0) {
            parts = []
            headChecked = false
            continue
          }
          const buf = parts.length === 1 ? parts[0]! : Buffer.concat(parts, len)
          const lineLen = len
          parts = []
          len = 0
          headChecked = false
          if (shouldSkipHead) {
            const head = lineLen > SKIP_HEAD ? buf.subarray(0, SKIP_HEAD).toString('utf-8') : buf.toString('utf-8')
            if (shouldSkipHead(head)) continue
            yield formatLine(buf, lineLen, head)
          } else yield formatLine(buf, lineLen)
        } else {
          const slice = chunk.subarray(pos)
          parts.push(slice)
          len += slice.length
          pos = chunk.length
          if (shouldSkipHead && !headChecked && len >= SKIP_HEAD) {
            headChecked = true
            const headBuf =
              parts.length === 1 ? parts[0]!.subarray(0, SKIP_HEAD) : Buffer.concat(parts, len).subarray(0, SKIP_HEAD)
            if (shouldSkipHead(headBuf.toString('utf-8'))) {
              skipping = true
              parts = []
              len = 0
            }
          }
        }
      }
      chunkBase += chunk.length
    }
    throwIfScanAborted(options.signal)
    if (!skipping && len > 0) {
      const buf = parts.length === 1 ? parts[0]! : Buffer.concat(parts, len)
      const lineLen = len
      if (shouldSkipHead) {
        const head = lineLen > SKIP_HEAD ? buf.subarray(0, SKIP_HEAD).toString('utf-8') : buf.toString('utf-8')
        if (!shouldSkipHead(head)) yield formatLine(buf, lineLen, head)
      } else yield formatLine(buf, lineLen)
    }
  } catch (error) {
    throwIfScanAborted(options.signal)
    warn(`stream read failed for ${shortPath(filePath)}: ${errorCode(error)}`)
  }
}
