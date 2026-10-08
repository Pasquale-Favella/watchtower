import { Effect, Result } from 'effect'
import { readdir } from 'fs/promises'

import { isScanAbortedError, scanAbortError } from './scan-control.js'

export const checkScanAbort = Effect.fnUntraced(function* (signal?: AbortSignal): Effect.fn.Return<void, Error> {
  if (signal?.aborted) return yield* Effect.fail(scanAbortError(signal))
})

/** Only a native IO leaf belongs here. Its pending work settles before interruption ends. */
export const scanIo = Effect.fnUntraced(function* <A>(
  operation: () => Promise<A>,
  signal?: AbortSignal,
): Effect.fn.Return<A, Error> {
  yield* checkScanAbort(signal)
  const result = yield* Effect.uninterruptible(
    Effect.result(
      Effect.tryPromise({
        try: operation,
        catch: cause => (cause instanceof Error ? cause : new Error(String(cause), { cause })),
      }),
    ),
  )
  yield* checkScanAbort(signal)
  if (Result.isFailure(result)) return yield* Effect.fail(result.failure)
  return result.success
})

export const readDirectoryOrEmpty = Effect.fnUntraced(function* (
  path: string,
  signal?: AbortSignal,
): Effect.fn.Return<string[], Error> {
  return yield* scanIo(() => readdir(path), signal).pipe(
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed([]))),
  )
})
