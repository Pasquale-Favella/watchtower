import { randomBytes } from 'crypto'
import { Effect, Fiber, Schema, Semaphore } from 'effect'
import { mkdir, open, readFile, stat, unlink, utimes, writeFile } from 'fs/promises'
import { join } from 'path'

import { resolveCacheDir } from '../env.js'

const LOCK_FILE = 'session-refresh.lock'
const TAKEOVER_FILE = `${LOCK_FILE}.takeover`
const DEFAULT_HEARTBEAT_MS = 10_000
const DEFAULT_STALE_MS = 90_000
const DEFAULT_WAIT_MS = 30_000
const DEFAULT_POLL_MS = 100
const WINDOWS_RETRIES = 3
const LockRecordSchema = Schema.Struct({ pid: Schema.Number, token: Schema.String, at: Schema.Number })

type LockRecord = { pid: number; token: string; at: number }

export type RefreshLockClock = {
  monotonicNow: () => number
  wallNow: () => number
}

export type RefreshLockOptions = {
  cacheDir?: string
  clock?: RefreshLockClock
  heartbeatMs?: number
  staleMs?: number
  waitMs?: number
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
}

export type RefreshLockHandle = {
  token: string
  release: () => Promise<void>
  verifyStillOwner: () => Promise<boolean>
  releaseEffect: Effect.Effect<void, Error>
  verifyStillOwnerEffect: Effect.Effect<boolean, Error>
}

export type RefreshLockOutcome =
  | { outcome: 'acquired'; handle: RefreshLockHandle }
  | { outcome: 'completed-by-other' }
  | { outcome: 'timed-out' }
  | { outcome: 'unavailable' }

export type RefreshLockResult = RefreshLockOutcome

const defaultClock: RefreshLockClock = {
  monotonicNow: () => Number(process.hrtime.bigint()) / 1_000_000,
  wallNow: () => Date.now(),
}

const singleFlight = Semaphore.makeUnsafe(1)

const io = <A>(operation: () => Promise<A>): Effect.Effect<A, Error> =>
  Effect.tryPromise({
    try: operation,
    catch: cause => (cause instanceof Error ? cause : new Error(String(cause))),
  })

function isBusyError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EPERM' || code === 'EBUSY'
}

function isExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST'
}

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

type MutationResult = 'created' | 'exists' | 'unavailable'
type Observation = { record: LockRecord; mtimeMs: number }
type ObservationResult = Observation | 'missing' | 'changing' | 'unavailable'
type GuardedResult<A> = { guard: 'created'; value: A } | { guard: 'exists' | 'unavailable' }

const sleepFor = (options: RefreshLockOptions, ms: number): Effect.Effect<void, Error> => {
  const sleep = options.sleep
  return sleep ? io(() => sleep(ms)) : Effect.sleep(`${Math.max(0, ms)} millis`)
}

const retryWindowsMutation = (
  operation: () => Promise<void>,
  options: RefreshLockOptions,
): Effect.Effect<boolean, Error> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < WINDOWS_RETRIES; attempt++) {
      const result = yield* Effect.uninterruptible(io(operation)).pipe(
        Effect.as('done' as const),
        Effect.catch(error => {
          if (isMissingError(error)) return Effect.succeed('done' as const)
          if (isBusyError(error) && attempt < WINDOWS_RETRIES - 1) return Effect.succeed('retry' as const)
          return Effect.succeed('stop' as const)
        }),
      )
      if (result === 'done') return true
      if (result === 'stop') return false
      yield* sleepFor(options, 10 * (attempt + 1))
    }
    return false
  })

const bestEffortUnlink = (path: string, options: RefreshLockOptions): Effect.Effect<void, never> =>
  retryWindowsMutation(() => unlink(path), options).pipe(
    Effect.catch(() => Effect.succeed(false)),
    Effect.asVoid,
  )

const createExclusive = (path: string, body: string): Effect.Effect<MutationResult, Error> =>
  Effect.acquireUseRelease(
    io(() => open(path, 'wx', 0o600)),
    handle => io(() => handle.writeFile(body, { encoding: 'utf-8' })).pipe(Effect.uninterruptible),
    handle => io(() => handle.close()),
  ).pipe(
    Effect.as('created' as const),
    Effect.catch(error => Effect.succeed(isExistsError(error) ? ('exists' as const) : ('unavailable' as const))),
  )

const observe = (path: string, options: RefreshLockOptions): Effect.Effect<ObservationResult, Error> =>
  Effect.gen(function* () {
    let sawChange = false
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = yield* Effect.gen(function* () {
        const before = yield* io(() => stat(path))
        const raw = yield* io(() => readFile(path, 'utf-8'))
        const after = yield* io(() => stat(path))
        if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) {
          sawChange = true
          return 'changing' as const
        }
        const json = yield* Effect.try({
          try: () => JSON.parse(raw),
          catch: () => new Error('invalid lock JSON'),
        }).pipe(Effect.catch(() => Effect.succeed(null)))
        if (json === null) return 'invalid' as const
        const parsed = Schema.decodeUnknownResult(LockRecordSchema)(json)
        if (parsed._tag === 'Success') return { record: parsed.success, mtimeMs: after.mtimeMs }
        return 'invalid' as const
      }).pipe(
        Effect.catch(error => {
          if (isMissingError(error)) return Effect.succeed('missing' as const)
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'EACCES' || code === 'EPERM') return Effect.succeed('unavailable' as const)
          return Effect.succeed('invalid' as const)
        }),
      )
      if (result === 'missing' || result === 'unavailable') return result
      if (result !== 'changing' && result !== 'invalid') return result
      yield* sleepFor(options, 1)
    }
    return sawChange ? 'changing' : 'unavailable'
  })

function sameObservation(a: Observation, b: Observation): boolean {
  return a.record.token === b.record.token && a.mtimeMs === b.mtimeMs
}

/** Native Effect workflow for the warm cache transaction's cross-process lock. */
export const acquireCacheRefreshLockEffect = Effect.fn('acquireCacheRefreshLockEffect')(function* (
  options: RefreshLockOptions = {},
): Effect.fn.Return<RefreshLockOutcome, Error> {
  let ownsPermit = false
  const leave = Effect.suspend(() => {
    if (!ownsPermit) return Effect.void
    ownsPermit = false
    return singleFlight.release(1).pipe(Effect.asVoid)
  })

  let acquiredHandle: RefreshLockHandle | undefined
  const acquire: Effect.Effect<RefreshLockOutcome, Error> = Effect.gen(function* () {
    const cacheDir = options.cacheDir ?? resolveCacheDir()
    const clock = options.clock ?? defaultClock
    const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
    const staleMs = options.staleMs ?? DEFAULT_STALE_MS
    const waitMs = options.waitMs ?? DEFAULT_WAIT_MS
    const pollMs = options.pollMs ?? DEFAULT_POLL_MS
    const lockPath = join(cacheDir, LOCK_FILE)
    const takeoverPath = join(cacheDir, TAKEOVER_FILE)
    const token = randomBytes(16).toString('hex')
    const body = (): string => JSON.stringify({ pid: process.pid, token, at: clock.wallNow() })

    const acquireTakeoverGuard = (): Effect.Effect<MutationResult, Error> =>
      Effect.gen(function* () {
        const created = yield* createExclusive(takeoverPath, body())
        if (created !== 'exists') return created
        const staleGuard = yield* observe(takeoverPath, options)
        if (staleGuard === 'missing') return yield* createExclusive(takeoverPath, body())
        if (staleGuard === 'changing') return 'exists'
        if (staleGuard === 'unavailable') return 'unavailable'
        if (Math.max(0, clock.wallNow() - staleGuard.mtimeMs) <= staleMs) return 'exists'
        const reverified = yield* observe(takeoverPath, options)
        if (reverified === 'missing') return yield* createExclusive(takeoverPath, body())
        if (reverified === 'changing') return 'exists'
        if (reverified === 'unavailable') return 'unavailable'
        if (!sameObservation(staleGuard, reverified)) return 'exists'
        if (!(yield* retryWindowsMutation(() => unlink(takeoverPath), options))) return 'unavailable'
        return yield* createExclusive(takeoverPath, body())
      })

    const withTakeoverGuard = <A>(operation: () => Effect.Effect<A, Error>): Effect.Effect<GuardedResult<A>, Error> =>
      Effect.uninterruptibleMask(restore =>
        acquireTakeoverGuard().pipe(
          Effect.flatMap((guard): Effect.Effect<GuardedResult<A>, Error> => {
            if (guard !== 'created') return Effect.succeed({ guard })
            return restore(operation()).pipe(
              Effect.map(value => ({ guard: 'created' as const, value })),
              Effect.ensuring(bestEffortUnlink(takeoverPath, options)),
            )
          }),
        ),
      )

    const ownerOperations = Semaphore.makeUnsafe(1)
    const serializeOwnerOp = <A>(effect: Effect.Effect<A, Error>): Effect.Effect<A, Error> =>
      ownerOperations.withPermit(effect)

    const removeIfOwned = (): Effect.Effect<boolean, Error> =>
      Effect.uninterruptibleMask(restore =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 20; attempt++) {
            const result = yield* withTakeoverGuard(() =>
              Effect.gen(function* () {
                const current = yield* observe(lockPath, options)
                if (current === 'missing') return true
                if (current === 'changing' || current === 'unavailable') return false
                if (current.record.token !== token) return true
                return yield* retryWindowsMutation(() => unlink(lockPath), options)
              }),
            )
            if (result.guard === 'unavailable') return false
            if (result.guard === 'created') return result.value
            yield* restore(sleepFor(options, pollMs))
          }
          return false
        }),
      )

    const verifyStillOwnerEffect = serializeOwnerOp(
      withTakeoverGuard(() =>
        Effect.gen(function* () {
          const current = yield* observe(lockPath, options)
          return (
            current !== 'missing' &&
            current !== 'changing' &&
            current !== 'unavailable' &&
            current.record.token === token
          )
        }),
      ).pipe(Effect.map(result => result.guard === 'created' && result.value)),
    )

    let released = false
    let heartbeatFiber: Fiber.Fiber<void, never> | undefined
    const releaseEffect = Effect.suspend(() => {
      if (released) return Effect.void
      released = true
      const stopHeartbeat = heartbeatFiber ? Fiber.interrupt(heartbeatFiber).pipe(Effect.asVoid) : Effect.void
      return Effect.uninterruptible(
        stopHeartbeat.pipe(
          Effect.flatMap(() => removeIfOwned().pipe(Effect.asVoid)),
          Effect.ensuring(leave),
        ),
      )
    })

    const heartbeatTick = serializeOwnerOp(
      withTakeoverGuard(() =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (released) return
            const current = yield* observe(lockPath, options)
            if (
              current === 'missing' ||
              current === 'changing' ||
              current === 'unavailable' ||
              current.record.token !== token
            )
              return
            yield* io(() => writeFile(lockPath, body(), { encoding: 'utf-8' }))
            const now = new Date(clock.wallNow())
            yield* io(() => utimes(lockPath, now, now))
          }),
        ),
      ).pipe(Effect.asVoid),
    ).pipe(Effect.catch(() => Effect.void))

    const handle = (): Effect.Effect<RefreshLockHandle, Error> =>
      Effect.gen(function* () {
        const heartbeat = Effect.forever(
          Effect.sleep(`${heartbeatMs} millis`).pipe(Effect.flatMap(() => heartbeatTick)),
        ).pipe(Effect.catch(() => Effect.void))
        heartbeatFiber = yield* Effect.forkDetach(heartbeat)
        const verifyPromise = (): Promise<boolean> => Effect.runPromise(verifyStillOwnerEffect)
        const releasePromise = (): Promise<void> => Effect.runPromise(releaseEffect)
        const result: RefreshLockHandle = {
          token,
          verifyStillOwner: verifyPromise,
          release: releasePromise,
          verifyStillOwnerEffect,
          releaseEffect,
        }
        acquiredHandle = result
        return result
      })

    const tryCreateOwner = (): Effect.Effect<RefreshLockOutcome | null, Error> =>
      Effect.uninterruptible(
        createExclusive(lockPath, body()).pipe(
          Effect.flatMap((result): Effect.Effect<RefreshLockOutcome | null, Error> => {
            if (result === 'created')
              return handle().pipe(Effect.map(handle => ({ outcome: 'acquired' as const, handle })))
            return Effect.succeed(result === 'unavailable' ? { outcome: 'unavailable' as const } : null)
          }),
        ),
      )

    const tryTakeover = (stale: Observation): Effect.Effect<RefreshLockOutcome | null, Error> =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const guard = yield* acquireTakeoverGuard()
          if (guard === 'unavailable') return { outcome: 'unavailable' as const }
          if (guard === 'exists') return null
          return yield* Effect.gen(function* () {
            const current = yield* observe(lockPath, options)
            if (current === 'unavailable') return { outcome: 'unavailable' as const }
            if (current === 'changing' || current === 'missing' || !sameObservation(stale, current)) return null
            if (Math.max(0, clock.wallNow() - current.mtimeMs) <= staleMs) return null
            if (!(yield* retryWindowsMutation(() => unlink(lockPath), options)))
              return { outcome: 'unavailable' as const }
            const successor = yield* createExclusive(lockPath, body())
            if (successor === 'created') {
              const owned = yield* handle()
              return { outcome: 'acquired' as const, handle: owned }
            }
            if (successor === 'unavailable') return { outcome: 'unavailable' as const }
            return null
          }).pipe(Effect.ensuring(bestEffortUnlink(takeoverPath, options)))
        }),
      )

    yield* io(() => mkdir(cacheDir, { recursive: true }))
    const immediate = yield* tryCreateOwner()
    if (immediate) return immediate

    const deadline = clock.monotonicNow() + waitMs
    while (clock.monotonicNow() < deadline) {
      const observation = yield* observe(lockPath, options)
      if (observation === 'unavailable') return { outcome: 'unavailable' as const }
      if (observation === 'changing') {
        yield* sleepFor(options, pollMs)
        continue
      }
      if (observation === 'missing') {
        const guard = yield* observe(takeoverPath, options)
        if (guard === 'unavailable') return { outcome: 'unavailable' as const }
        if (guard === 'changing') {
          yield* sleepFor(options, pollMs)
          continue
        }
        if (guard === 'missing') return { outcome: 'completed-by-other' as const }
        yield* sleepFor(options, pollMs)
        continue
      }
      const age = Math.max(0, clock.wallNow() - observation.mtimeMs)
      if (age > staleMs) {
        const takeover = yield* tryTakeover(observation)
        if (takeover) return takeover
      }
      yield* sleepFor(options, pollMs)
    }
    return { outcome: 'timed-out' as const }
  })

  const result: Effect.Effect<RefreshLockOutcome, Error> = Effect.uninterruptibleMask(restore =>
    restore(singleFlight.take(1)).pipe(
      Effect.flatMap(() => {
        ownsPermit = true
        return restore(acquire).pipe(
          Effect.catch(() => Effect.succeed({ outcome: 'unavailable' as const })),
          Effect.onInterrupt(() => (acquiredHandle ? acquiredHandle.releaseEffect : leave)),
          Effect.ensuring(Effect.suspend(() => (acquiredHandle ? Effect.void : leave))),
        )
      }),
    ),
  )
  return yield* result
})

/** Promise adapter for callers that have not moved to Effect yet. */
export function acquireCacheRefreshLock(options: RefreshLockOptions = {}): Promise<RefreshLockOutcome> {
  return Effect.runPromise(acquireCacheRefreshLockEffect(options))
}
