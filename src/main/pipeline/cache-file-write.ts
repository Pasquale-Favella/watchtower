import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as FileSystem from 'effect/FileSystem'
import * as PlatformError from 'effect/PlatformError'

import { isScanAbortedError, throwIfScanAborted } from './scan-control.js'

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause), { cause })
}

function abortCheck(signal?: AbortSignal): Effect.Effect<void, Error> {
  return Effect.try({ try: () => throwIfScanAborted(signal), catch: toError })
}

function isExpectedPlatformCloseCause(cause: Cause.Cause<Error>): boolean {
  return (
    cause.reasons.length > 0 &&
    cause.reasons.every(reason => Cause.isDieReason(reason) && PlatformError.isPlatformError(reason.defect))
  )
}

/** True only for typed, non-abort cache failures that callers may safely ignore. */
export function isRecoverableCacheFailure(cause: Cause.Cause<Error>): boolean {
  return (
    cause.reasons.length > 0 &&
    cause.reasons.every(reason => Cause.isFailReason(reason) && !isScanAbortedError(reason.error))
  )
}

/** Write and close a cache temp file before the caller attempts its atomic rename. */
export function writeCacheTempFileEffect(
  fs: FileSystem.FileSystem,
  path: string,
  payload: string,
  signal?: AbortSignal,
): Effect.Effect<void, Error> {
  let operationExit: Exit.Exit<void, Error> | undefined
  return Effect.exit(
    Effect.uninterruptible(
      Effect.scoped(
        Effect.gen(function* () {
          const opened = yield* Effect.exit(fs.open(path, { flag: 'w', mode: 0o600 }))
          if (Exit.isFailure(opened)) {
            operationExit = opened
            return
          }
          operationExit = yield* Effect.exit(
            Effect.gen(function* () {
              yield* abortCheck(signal)
              yield* opened.value.writeAll(new TextEncoder().encode(payload))
              yield* abortCheck(signal)
              yield* opened.value.sync
              yield* abortCheck(signal)
            }),
          )
        }),
      ),
    ),
  ).pipe(
    Effect.flatMap(scopeExit => {
      if (Exit.isSuccess(scopeExit)) {
        if (operationExit && Exit.isFailure(operationExit)) return Effect.failCause(operationExit.cause)
        return Effect.void
      }

      if (isExpectedPlatformCloseCause(scopeExit.cause)) {
        const closeCause = Cause.fromReasons(
          scopeExit.cause.reasons.map(reason =>
            Cause.isDieReason(reason) ? Cause.makeFailReason(toError(reason.defect)) : reason,
          ),
        )
        if (operationExit && Exit.isFailure(operationExit)) {
          if (
            operationExit.cause.reasons.some(reason => Cause.isFailReason(reason) && isScanAbortedError(reason.error))
          ) {
            return Effect.failCause(operationExit.cause)
          }
          return Effect.failCause(Cause.combine(operationExit.cause, closeCause))
        }
        return Effect.failCause(closeCause)
      }

      return operationExit && Exit.isFailure(operationExit)
        ? Effect.failCause(Cause.combine(operationExit.cause, scopeExit.cause))
        : Effect.failCause(scopeExit.cause)
    }),
  )
}
