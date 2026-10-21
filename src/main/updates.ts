import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import type * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Queue from 'effect/Queue'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'

import { type UpdateStatus, updateStatusSchema } from '../shared/schemas/updates.js'

export class UpdateError extends Schema.TaggedError<UpdateError>()('UpdateError', {
  code: Schema.Literals(['check-failed', 'download-failed', 'invalid-update']),
}) {}

/** The library adapter owns transport, checksums, signatures and cancellation. */
export interface UpdateDriver {
  readonly check: Effect.Effect<{ version: string; available: boolean }, UpdateError>
  readonly download: Effect.Effect<void, UpdateError>
  readonly subscribeProgress: (notify: (percent: number) => void) => () => void
  readonly install: () => void
}

export interface UpdateSource {
  readonly driver: UpdateDriver | null
  readonly unavailableReason: string | null
}

export interface UpdatesOptions {
  readonly currentVersion: string
  readonly source: Effect.Effect<UpdateSource, never, FileSystem.FileSystem>
  readonly onChange: (status: UpdateStatus) => void
  readonly requestInstall: (install: () => void) => void
}

export class AppUpdates extends Context.Service<
  AppUpdates,
  {
    readonly status: Effect.Effect<UpdateStatus>
    readonly check: Effect.Effect<UpdateStatus>
    readonly download: Effect.Effect<UpdateStatus>
    readonly install: Effect.Effect<UpdateStatus>
  }
>()('watchtower/main/AppUpdates') {}

interface UpdateState {
  readonly status: UpdateStatus
  readonly flight: Deferred.Deferred<UpdateStatus> | null
}

interface UpdateDecision {
  readonly deferred: Deferred.Deferred<UpdateStatus> | null
  readonly start: boolean
}

export function updatesLayer(options: UpdatesOptions): Layer.Layer<AppUpdates, never, FileSystem.FileSystem> {
  return Layer.effect(
    AppUpdates,
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const { driver, unavailableReason } = yield* options.source
      const state = yield* Ref.make<UpdateState>({
        status: {
          revision: 0,
          currentVersion: options.currentVersion,
          latestVersion: null,
          updateAvailable: false,
          tag: null,
          phase: driver ? 'idle' : 'unsupported',
          installSupported: driver !== null,
          progress: null,
          message: unavailableReason,
        },
        flight: null,
      })
      const status = Ref.get(state).pipe(Effect.map(state => state.status))

      const publish = Effect.fn('AppUpdates.publish')(function* (next: UpdateStatus) {
        const validated = yield* Schema.decodeUnknownEffect(updateStatusSchema)(next).pipe(Effect.orDie)
        const published = yield* Ref.modify(state, current => {
          const status = { ...validated, revision: current.status.revision + 1 }
          return [status, { ...current, status }]
        })
        yield* Effect.sync(() => options.onChange(published))
        return published
      })

      if (driver) {
        const progress = yield* Queue.sliding<number>(1)
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            driver.subscribeProgress(percent => {
              Queue.offerUnsafe(progress, percent)
            }),
          ),
          unsubscribe => Effect.sync(unsubscribe),
        )
        yield* Effect.forkScoped(
          Effect.gen(function* () {
            while (true) {
              const percent = yield* Queue.take(progress)
              const current = yield* status
              if (current.phase === 'downloading' && Number.isFinite(percent)) {
                yield* publish({ ...current, progress: Math.min(100, Math.max(0, percent)) })
              }
            }
          }),
        )
      }

      const run = Effect.fn('AppUpdates.run')(function* (action: 'check' | 'download') {
        return yield* Effect.uninterruptibleMask(restore =>
          Effect.gen(function* () {
            if (!driver) return yield* status
            const deferred = yield* Deferred.make<UpdateStatus>()
            const decision = yield* Ref.modify(state, (current): readonly [UpdateDecision, UpdateState] => {
              if (current.flight) return [{ deferred: current.flight, start: false }, current] as const
              const phase = current.status.phase
              if (
                phase === 'ready' ||
                phase === 'installing' ||
                (action === 'download' && !current.status.updateAvailable)
              ) {
                return [{ deferred: null, start: false }, current]
              }
              const next: UpdateStatus = {
                ...current.status,
                revision: current.status.revision + 1,
                phase: action === 'check' ? 'checking' : 'downloading',
                progress: action === 'download' ? 0 : null,
                message: null,
              }
              return [
                { deferred, start: true },
                { status: next, flight: deferred },
              ] as const
            })
            if (!decision.deferred) return yield* status
            if (decision.start) {
              const work = Effect.gen(function* () {
                yield* Effect.sync(() => options.onChange(Ref.getUnsafe(state).status))
                if (action === 'check') {
                  const result = yield* driver.check
                  const current = yield* status
                  return yield* publish({
                    ...current,
                    latestVersion: result.version,
                    updateAvailable: result.available,
                    tag: result.available ? `v${result.version}` : null,
                    phase: result.available ? 'available' : 'current',
                    progress: null,
                  })
                }
                yield* driver.download
                const current = yield* status
                return yield* publish({ ...current, phase: 'ready', progress: 100 })
              }).pipe(
                Effect.catch(error =>
                  Effect.gen(function* () {
                    yield* Effect.logWarning('update.failed').pipe(
                      Effect.annotateLogs({
                        event: 'update.failed',
                        context: 'main',
                        op: `updates:${action}`,
                        code: error.code,
                      }),
                    )
                    const current = yield* status
                    return yield* publish({
                      ...current,
                      phase: 'error',
                      progress: null,
                      message:
                        action === 'check'
                          ? 'Unable to check for updates. Try again or open the release page.'
                          : 'Download failed. Try again or open the release page.',
                      ...(action === 'check' ? { updateAvailable: false, latestVersion: null, tag: null } : {}),
                    })
                  }),
                ),
                Effect.onExit(exit =>
                  Effect.gen(function* () {
                    yield* Ref.update(state, current => ({ ...current, flight: null }))
                    if (Exit.isSuccess(exit)) yield* Deferred.succeed(deferred, exit.value)
                    else yield* Deferred.failCause(deferred, exit.cause)
                  }),
                ),
              )
              yield* Effect.forkIn(Effect.interruptible(work), scope)
            }
            return yield* restore(Deferred.await(decision.deferred))
          }),
        )
      })

      const install = Effect.gen(function* () {
        const current = yield* status
        if (!driver || current.phase !== 'ready') return current
        const next = yield* publish({ ...current, phase: 'installing', message: null })
        yield* Effect.sync(() => options.requestInstall(driver.install))
        return next
      })
      return AppUpdates.of({ status, check: run('check'), download: run('download'), install })
    }),
  )
}
