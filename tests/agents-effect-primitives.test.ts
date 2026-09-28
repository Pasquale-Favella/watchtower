/**
 * Effect primitives contract for the Coach harness layer (ADR 0030, §4.3 slice).
 *
 * Each test pins a primitive that F0–F4 build on, against fakes mirroring the
 * current seam shapes (runtime.ts / detect.ts / snapshot.ts):
 *  1. probe timeouts that degrade to `{ ok: false }` instead of hanging;
 *  2. parallel detect with per-probe timeout + bounded concurrency;
 *  3. Scope-based instance teardown (deterministic, LIFO, isolated scopes);
 *  4. run interrupt with a drain barrier and an always-reaped child;
 *  5. §4.3: snapshot Scope + FiberHandle (probe batch ownership, Deferred
 *     flight coalescing) and MainLive flat composition (no second runtime).
 */
import { Deferred, Effect, Exit, Fiber, FiberHandle, Layer, Option, Ref, Schedule, Scope, Stream } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { describe, expect, it } from 'vitest'

import { HARNESS_HANDSHAKE_TIMEOUT_MS } from '../src/main/agents/harness-timeouts.js'
import { HarnessProbe } from '../src/main/agents/snapshot.js'
import { Env } from '../src/main/env.js'
import { HttpFetch } from '../src/main/pipeline/fetch-utils.js'

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

describe('effect: snapshot Scope + Deferred flight (§4.3 — replaces detectionPromise/generation)', () => {
  it('closing the store Scope interrupts hung probes and runs their finalizers', async () => {
    let finalized = 0
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const storeScope = yield* Scope.make()
        const probeHandle = yield* Scope.provide(storeScope)(FiberHandle.make<unknown, never>())
        const started = yield* Deferred.make<undefined>()
        const fiber = yield* FiberHandle.run(
          probeHandle,
          Effect.scoped(
            Effect.acquireRelease(Effect.succeed(undefined), () =>
              Effect.sync(() => {
                finalized += 1
              }),
            ).pipe(Effect.andThen(Effect.andThen(Deferred.succeed(started, undefined), Effect.never))),
          ),
        )
        yield* Deferred.await(started)
        yield* Scope.close(storeScope, Exit.succeed('done'))
        return yield* Fiber.await(fiber)
      }),
    )
    expect(Exit.isFailure(result)).toBe(true)
    expect(finalized).toBe(1)
  })

  it('a Deferred flight coalesces concurrent detections and shares failures', async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        let calls = 0
        const flight = yield* Deferred.make<string, string>()
        const detect = Effect.suspend(() => {
          calls += 1
          return calls === 1 ? Deferred.fail(flight, 'scan failed') : Deferred.succeed(flight, 'second')
        })
        const first = yield* Effect.forkChild(Effect.andThen(detect, Deferred.await(flight)))
        const second = yield* Effect.forkChild(Deferred.await(flight))
        const [left, right] = yield* Effect.all([Fiber.await(first), Fiber.await(second)])
        return { calls, left, right }
      }),
    )
    expect(outcome.calls).toBe(1)
    expect(Exit.isFailure(outcome.left)).toBe(true)
    expect(Exit.isFailure(outcome.right)).toBe(true)
  })
})

describe('effect: run teardown barrier (§4.3 — acquireRelease + timeoutOption + ignore)', () => {
  it('acquireRelease reaps the provider even when the handshake fails', async () => {
    const events: string[] = []
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.acquireRelease(
          Effect.sync(() => events.push('spawn agent')),
          () => Effect.sync(() => events.push('kill agent')),
        ).pipe(Effect.andThen(Effect.fail('auth wall')), Effect.exit),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(events).toEqual(['spawn agent', 'kill agent'])
  })

  it('a hung iterator.return is bounded by the cancel-drain timeout and ignored', async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.tryPromise({
            try: () => new Promise<never>(() => {}),
            catch: error => error,
          }).pipe(Effect.timeoutOption(20), Effect.ignore),
        )
        yield* TestClock.adjust(50)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(outcome).toBeUndefined()
  })

  it('a hung inspect handshake hits the inspect deadline instead of hanging', async () => {
    expect(HARNESS_HANDSHAKE_TIMEOUT_MS).toBe(15_000)
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.tryPromise({
            try: () => new Promise<unknown>(() => {}),
            catch: error => error,
          }).pipe(Effect.timeoutOption(HARNESS_HANDSHAKE_TIMEOUT_MS)),
        )
        yield* TestClock.adjust(HARNESS_HANDSHAKE_TIMEOUT_MS + 100)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(Option.isNone(outcome)).toBe(true)
  })
})

/** Fake fetch shared by both flat-composition cases: the capability seams only
 *  read `ok`/`status`/`json`, so the payload shape is irrelevant here. */
function fakeOkFetch(): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ rates: { EUR: 0.9 } }),
  })) as unknown as typeof fetch
}

/** The one probe request both cases drive through `HarnessProbe` (read-only, so
 *  a single shared value keeps the two cases byte-comparable). */
const codexProbeRequest: Parameters<HarnessProbe['Service']['probe']>[0] = {
  name: 'codex',
  kind: 'codex',
  displayName: 'Codex',
  bin: 'codex',
  scrubEnv: [],
}

describe('effect: MainLive flat composition (§4.3 — one runtime, test fakes)', () => {
  it('merged HttpFetch + HarnessProbe test layers provide both capabilities', async () => {
    const probeCalls: string[] = []
    const testLive = Layer.mergeAll(
      HttpFetch.layerWithFetch(fakeOkFetch()),
      HarnessProbe.layerWithProbe(info => {
        probeCalls.push(info.kind)
        return Effect.succeed({ status: 'ready' as const, auth: { status: 'unknown' as const } })
      }),
    )
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const http = yield* HttpFetch
        const probe = yield* HarnessProbe
        const response = yield* http.fetch('https://example.invalid/fx', {}, 1000)
        const result = yield* probe.probe(codexProbeRequest)
        return { ok: response.ok, status: result.status, kinds: probeCalls }
      }).pipe(Effect.provide(testLive)),
    )
    expect(rows).toEqual({ ok: true, status: 'ready', kinds: ['codex'] })
  })

  it('Env joins the flat merge: startup-immutable Config beside fetch + probe fakes', async () => {
    // Mirrors MainLive's flat shape with test fakes (no second runtime, zero
    // process.env mutation): Env.layerWithValues carries the full value shape.
    const testLive = Layer.mergeAll(
      HttpFetch.layerWithFetch(fakeOkFetch()),
      HarnessProbe.layerWithProbe(() =>
        Effect.succeed({ status: 'ready' as const, auth: { status: 'unknown' as const } }),
      ),
      Env.layerWithValues({
        vercelGatewayApiKey: 'test-gateway-key',
        pricingCacheTtlMs: Infinity,
        cursorCacheSuppressWrites: false,
        codexHome: '/fake/codex-home',
      }),
    )
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const env = yield* Env
        const http = yield* HttpFetch
        const probe = yield* HarnessProbe
        const response = yield* http.fetch('https://example.invalid/fx', {}, 1000)
        const result = yield* probe.probe(codexProbeRequest)
        return {
          gatewayKey: env.vercelGatewayApiKey,
          ttlMs: env.pricingCacheTtlMs,
          suppress: env.cursorCacheSuppressWrites,
          codexHome: env.codexHome,
          ok: response.ok,
          status: result.status,
        }
      }).pipe(Effect.provide(testLive)),
    )
    expect(rows).toEqual({
      gatewayKey: 'test-gateway-key',
      ttlMs: Infinity,
      suppress: false,
      codexHome: '/fake/codex-home',
      ok: true,
      status: 'ready',
    })
  })
})
