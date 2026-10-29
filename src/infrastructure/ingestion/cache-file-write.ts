import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as FileSystem from 'effect/FileSystem'

import { mapPlatformCloseCause } from '@/infrastructure/platform/platform-file-errors.js'
import {
  hasScanAbortCause,
  isRecoverableScanFailureCause,
  throwIfScanAborted,
} from '@/core/ingestion/reconciliation/scan-control.js'

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause), { cause })
}

function abortCheck(signal?: AbortSignal): Effect.Effect<void, Error> {
  return Effect.try({ try: () => throwIfScanAborted(signal), catch: toError })
}

/** True only for typed, non-abort cache failures that callers may safely ignore. */
export function isRecoverableCacheFailure(cause: Cause.Cause<Error>): boolean {
  return isRecoverableScanFailureCause(cause, () => true)
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

      const closeCause = mapPlatformCloseCause(scopeExit.cause, toError)
      if (closeCause) {
        if (operationExit && Exit.isFailure(operationExit)) {
          if (hasScanAbortCause(operationExit.cause)) {
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
