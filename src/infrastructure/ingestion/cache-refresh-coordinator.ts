import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'

import type { Env } from '../config/environment.js'
import { acquireCacheRefreshLockEffect, type RefreshLockHandle } from './cache-refresh-lock.js'
import type { ScanAbortedError } from '../../core/ingestion/reconciliation/scan-control.js'
import type { SessionCache } from './session-cache.js'
import type { ProjectSummary } from '../../core/domain/observations/types.js'

export type CacheRefreshParseOptions = {
  readonly readOnly?: boolean
  readonly refreshLock?: RefreshLockHandle
}

type CacheRefreshCoordinatorOptions = {
  readonly priorSnapshot: SessionCache
  readonly parse: (
    cache: SessionCache,
    options: CacheRefreshParseOptions,
  ) => Effect.Effect<ProjectSummary[], Error, Env | FileSystem.FileSystem>
  readonly loadLatest: () => Effect.Effect<SessionCache, Error, FileSystem.FileSystem>
  readonly checkAbort: () => Effect.Effect<void, ScanAbortedError>
  readonly isRefreshFallbackError: (error: Error) => boolean
}

/** Own the warm-cache lock, authoritative reload, fallback parse, and release. */
export const coordinateCacheRefreshEffect = Effect.fnUntraced(function* (
  options: CacheRefreshCoordinatorOptions,
): Effect.fn.Return<ProjectSummary[], Error, Env | FileSystem.FileSystem> {
  const { priorSnapshot, parse, loadLatest, checkAbort, isRefreshFallbackError } = options
  return yield* Effect.uninterruptibleMask(restore =>
    restore(acquireCacheRefreshLockEffect()).pipe(
      Effect.flatMap(owned =>
        restore(
          Effect.gen(function* () {
            yield* checkAbort()
            if (owned.outcome === 'timed-out' || owned.outcome === 'unavailable') {
              return yield* parse(priorSnapshot, { readOnly: true })
            }
            if (owned.outcome === 'completed-by-other') {
              const latest = yield* loadLatest()
              yield* checkAbort()
              return yield* parse(latest, { readOnly: true })
            }

            // Reload only after ownership is canonical. This closes the lost-update
            // window between the pre-gate read and the holder's completed publication.
            const latest = yield* loadLatest()
            yield* checkAbort()
            return yield* parse(latest, { refreshLock: owned.handle }).pipe(
              Effect.catch(error => {
                if (!isRefreshFallbackError(error)) return Effect.fail(error)
                return Effect.gen(function* () {
                  yield* checkAbort()
                  const newest = yield* loadLatest()
                  yield* checkAbort()
                  return yield* parse(newest, { readOnly: true })
                })
              }),
            )
          }),
        ).pipe(Effect.onExit(() => (owned.outcome === 'acquired' ? owned.handle.releaseEffect : Effect.void))),
      ),
    ),
  )
})
