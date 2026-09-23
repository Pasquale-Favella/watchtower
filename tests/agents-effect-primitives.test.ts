/**
 * Effect primitives contract for the Coach harness layer (ADR 0030).
 *
 * Each test pins a primitive that F0–F4 build on, against fakes mirroring the
 * current seam shapes (runtime.ts / detect.ts):
 *  1. probe timeouts that degrade to `{ ok: false }` instead of hanging;
 *  2. parallel detect with per-probe timeout + bounded concurrency;
 *  3. Scope-based instance teardown (deterministic, LIFO, isolated scopes);
 *  4. run interrupt with a drain barrier and an always-reaped child.
 */
import { Deferred, Effect, Exit, Fiber, Option, Ref, Schedule, Scope, Stream } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// Fakes mirroring the current seam shapes (runtime.ts / detect.ts)
// ---------------------------------------------------------------------------

type ProbeError =
  { readonly _tag: 'SpawnFailed'; readonly message: string } | { readonly _tag: 'AuthWall'; readonly message: string }

/** Fake agent handshake: resolves after `latencyMs`, or never when hung. */
const fakeHandshake = (latencyMs: number | 'never', modelCount = 3): Effect.Effect<readonly string[], ProbeError> =>
  latencyMs === 'never'
    ? Effect.never
    : Effect.delay(Effect.succeed(Array.from({ length: modelCount }, (_, i) => `model-${i}`)), latencyMs)

describe('effect: probe with timeout (pain 1 — inspect() hangs forever today)', () => {
  it('a hung handshake becomes a TimeoutException, not a hung picker', async () => {
    const result = await Effect.runPromise(
      fakeHandshake('never').pipe(
        Effect.timeout(100), // <- inspect() has NO equivalent today
        Effect.exit,
      ),
    )
    expect(Exit.isFailure(result)).toBe(true)
  })

  it('timeoutOption maps a hung probe to the { ok:false } inspect arm — never throws', async () => {
    const outcome = await Effect.runPromise(
      fakeHandshake('never').pipe(
        // The runner's contract: failed probe => pickers absent, chat unblocked.
        Effect.timeoutOption(100),
        Effect.map(o => (o._tag === 'Some' ? { ok: true as const, models: o.value } : { ok: false as const })),
      ),
    )
    expect(outcome).toEqual({ ok: false })
  })

  it('transient probe failures retry on a schedule, then surface typed errors', async () => {
    let attempts = 0
    const flaky = Effect.suspend(() => {
      attempts += 1
      return attempts < 3
        ? Effect.fail<readonly string[], ProbeError>({ _tag: 'SpawnFailed', message: 'ENOENT (transient)' })
        : Effect.succeed(['model-0'] as const)
    })
    const models = await Effect.runPromise(flaky.pipe(Effect.retry(Schedule.recurs(3)), Effect.timeout(1000)))
    expect(models).toEqual(['model-0'])
    expect(attempts).toBe(3)
  })

  it('canonical deterministic timeout form: fork clock-advance alongside the probe', async () => {
    const probe = fakeHandshake(5000).pipe(Effect.timeoutOption(100))
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(probe)
        yield* TestClock.adjust(200)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(Option.isNone(result)).toBe(true)
  })
})

describe('effect: parallel detect with per-probe timeout (pain 2 — sequential loop today)', () => {
  it('14 specs probe concurrently; one hung probe cannot block the rest', async () => {
    const specs = Array.from({ length: 14 }, (_, i) => `harness-${i}`)
    const startedAt = Date.now()
    const snapshots = await Effect.runPromise(
      Effect.all(
        specs.map(kind =>
          fakeHandshake(kind === 'harness-7' ? 'never' : 50).pipe(
            Effect.timeoutOption(200),
            Effect.map(models => ({
              kind,
              status: models._tag === 'Some' ? ('ready' as const) : ('error' as const),
            })),
          ),
        ),
        { concurrency: 14 }, // <- detectHarnesses() is a sequential for-loop today
      ),
    )
    const elapsed = Date.now() - startedAt
    expect(snapshots).toHaveLength(14)
    expect(snapshots.find(s => s.kind === 'harness-7')?.status).toBe('error')
    expect(snapshots.filter(s => s.status === 'ready')).toHaveLength(13)
    // Sequential would take ~700ms+; concurrent takes ~ the timeout bound.
    expect(elapsed).toBeLessThan(650)
  })
})

describe('effect: Scope-based instance registry (pain 3 — manual cleanup() today)', () => {
  it('Scope.close kills the child deterministically, LIFO, even on failure', async () => {
    const events: string[] = []
    const order = await Effect.runPromise(
      Scope.make().pipe(
        Effect.flatMap(scope =>
          Effect.acquireRelease(
            Effect.acquireRelease(
              Effect.sync(() => events.push('spawn child')),
              () => Effect.sync(() => events.push('kill child')),
            ),
            () => Effect.sync(() => events.push('release slot')),
          ).pipe(
            Scope.provide(scope),
            Effect.andThen(Effect.fail('boom')),
            Effect.exit,
            Effect.andThen(Scope.close(scope, Exit.succeed('done'))),
            Effect.andThen(Effect.sync(() => [...events])),
          ),
        ),
      ),
    )
    expect(order).toEqual(['spawn child', 'release slot', 'kill child'])
  })

  it('two instances of one driver get isolated scopes (personal/work)', async () => {
    const events: string[] = []
    const acquire = (id: string, scope: Scope.Scope) =>
      Effect.acquireRelease(
        Effect.sync(() => events.push(`spawn ${id}`)),
        () => Effect.sync(() => events.push(`kill ${id}`)),
      ).pipe(Scope.provide(scope))
    // Two independent scopes = two CODEX_HOME-style isolated instances.
    const { scopeA, scopeB } = await Effect.runPromise(Effect.all({ scopeA: Scope.make(), scopeB: Scope.make() }))
    await Effect.runPromise(acquire('codex_personal', scopeA))
    await Effect.runPromise(acquire('codex_work', scopeB))
    // Closing A's scope reaps ONLY A's child — B keeps running. The manual
    // cleanup()-in-finally pattern cannot express this without bespoke maps.
    await Effect.runPromise(Scope.close(scopeA, Exit.succeed('done')))
    expect(events).toEqual(['spawn codex_personal', 'spawn codex_work', 'kill codex_personal'])
    await Effect.runPromise(Scope.close(scopeB, Exit.succeed('done')))
    expect(events).toEqual(['spawn codex_personal', 'spawn codex_work', 'kill codex_personal', 'kill codex_work'])
  })
})

describe('effect: interrupt + drain barrier (pain 4 — iterator.return() juggling today)', () => {
  it('interrupting a run still flushes buffered events before settle', async () => {
    // ONE program, ONE runtime: fork + sleep + interrupt + barrier all in the
    // same scope (cross-runPromise fork parenting proved unreliable under test).
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const drained: string[] = []
          const killCount = yield* Ref.make(0)
          const drain = yield* Deferred.make<undefined>()
          const fiber = yield* Effect.forkChild(
            Stream.range(0, 10).pipe(
              Stream.mapEffect(i =>
                Effect.delay(
                  Effect.sync(() => `event-${i}`),
                  20,
                ),
              ),
              Stream.tap(event => Effect.sync(() => drained.push(event))),
              Stream.runDrain,
              Effect.ensuring(
                // Drain barrier: buffered/derived events flush BEFORE the child dies.
                Deferred.succeed(drain, undefined).pipe(Effect.andThen(Ref.update(killCount, n => n + 1))),
              ),
            ),
          )
          yield* Effect.sleep(80) // let a couple of events through (timing-tolerant)
          yield* Fiber.interrupt(fiber) // <- cancel
          yield* Deferred.await(drain) // <- barrier run() lacks today
          return { drained: [...drained], kills: yield* Ref.get(killCount) }
        }),
      ),
    )
    expect(result.drained.length).toBeGreaterThanOrEqual(2)
    expect(result.drained.length).toBeLessThan(11) // range(0,10) is inclusive
    expect(result.kills).toBe(1) // child always reaped
  }, 15000)
})
