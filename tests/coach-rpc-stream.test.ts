import * as Cause from 'effect/Cause'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as RpcTest from 'effect/rpc/RpcTest'
import * as Stream from 'effect/Stream'
import { describe, expect, it, vi } from 'vitest'

import type { NativeCoachRunnerCapabilities } from '../src/platform/electron/main/coach/ipc.js'
import { makeMainRuntime } from '../src/platform/electron/main/main-runtime.js'
import { coachHandlers } from '../src/platform/electron/main/rpc/coach-handlers.js'
import { CoachRpcError, CoachRpcGroup, type CoachRunFrame } from '../src/shared/rpc/coach.js'
import type { CoachEvent } from '../src/shared/schemas/agents.js'

const request = { harnessKind: 'claude', prompt: 'hello' }

function setup(overrides: Partial<NativeCoachRunnerCapabilities> = {}) {
  const capabilities: NativeCoachRunnerCapabilities = {
    list: Effect.succeed([]),
    refresh: Effect.succeed([]),
    inspect: () => Effect.succeed({ ok: false, error: 'unavailable' }),
    start: () => Effect.succeed({ ok: false, error: 'not configured' }),
    cancel: () => Effect.void,
    reset: Effect.void,
    ...overrides,
  }
  const handlers = coachHandlers(capabilities)
  return { capabilities, handlers }
}

const event = (runId: string, coachEvent: CoachEvent): CoachRunFrame => ({
  _tag: 'Event',
  runId,
  event: coachEvent,
})

async function runWithMainServices<A, E>(
  effect: Effect.Effect<A, E, import('../src/platform/electron/main/main-runtime.js').MainServices>,
): Promise<A> {
  const runtime = makeMainRuntime(
    { clientVersion: 'test', appPath: '/app', onHarnessChange: () => {} },
    { detect: async () => [] },
  )
  try {
    return await runtime.runPromise(effect)
  } finally {
    await Effect.runPromise(runtime.disposeEffect)
  }
}

describe('Coach ordered RPC stream', () => {
  it('sends Started before early notices and closes after exactly one terminal event', async () => {
    const start = vi.fn((_request: unknown, emit: (runId: string, event: CoachEvent) => void) =>
      Effect.sync(() => {
        emit('run-1', { kind: 'notice', message: 'early' })
        emit('run-1', { kind: 'text', delta: 'answer' })
        emit('run-1', { kind: 'status', state: 'done' })
        emit('run-1', { kind: 'text', delta: 'late' })
        return { ok: true, runId: 'run-1' } as const
      }),
    )
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CoachRpcGroup)
      return yield* Stream.runCollect(client['coach:run'](request))
    }).pipe(Effect.scoped, Effect.provide(setup({ start }).handlers))

    const frames = await runWithMainServices(program)
    expect(frames).toEqual([
      { _tag: 'Started', runId: 'run-1' },
      event('run-1', { kind: 'notice', message: 'early' }),
      event('run-1', { kind: 'text', delta: 'answer' }),
      event('run-1', { kind: 'status', state: 'done' }),
    ])
    expect(start).toHaveBeenCalledOnce()
  })

  it('returns a safe typed failure when startup fails before an id exists', async () => {
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CoachRpcGroup)
      return yield* Effect.exit(Stream.runCollect(client['coach:run'](request)))
    }).pipe(
      Effect.scoped,
      Effect.provide(
        setup({
          start: () => Effect.fail(new Error('secret C:\\private\\ledger.db')),
        }).handlers,
      ),
    )
    const result = await runWithMainServices(program)
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      const error = Cause.findError(result.cause)
      expect(error).toMatchObject({
        _tag: 'Success',
        success: new CoachRpcError({ code: 'start-failed', message: 'Unable to start the Coach run.' }),
      })
      expect(JSON.stringify(result)).not.toContain('private')
    }
  })

  it('reports overflow, stops publishing, and cancels the backend run', async () => {
    const cancel = vi.fn(() => Effect.void)
    const start = (_request: unknown, emit: (runId: string, event: CoachEvent) => void) =>
      Effect.sync(() => {
        for (let index = 0; index < 140; index++) emit('run-overflow', { kind: 'text', delta: String(index) })
        return { ok: true, runId: 'run-overflow' } as const
      })
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CoachRpcGroup)
      return yield* Stream.runCollect(client['coach:run'](request))
    }).pipe(Effect.scoped, Effect.provide(setup({ start, cancel }).handlers))

    const frames = await runWithMainServices(program)
    expect(frames[0]).toEqual({ _tag: 'Started', runId: 'run-overflow' })
    expect(frames.at(-1)).toEqual(
      event('run-overflow', {
        kind: 'error',
        message: 'Coach output exceeded the stream limit. Retry your message.',
      }),
    )
    expect(frames).toHaveLength(130)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('reports an oversized event without publishing its payload', async () => {
    const cancel = vi.fn(() => Effect.void)
    const oversized = 'x'.repeat(1024 * 1024 + 1)
    const start = (_request: unknown, emit: (runId: string, event: CoachEvent) => void) =>
      Effect.sync(() => {
        emit('run-large', { kind: 'text', delta: oversized })
        return { ok: true, runId: 'run-large' } as const
      })
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CoachRpcGroup)
      return yield* Stream.runCollect(client['coach:run'](request))
    }).pipe(Effect.scoped, Effect.provide(setup({ start, cancel }).handlers))

    const frames = await runWithMainServices(program)
    expect(frames).toEqual([
      { _tag: 'Started', runId: 'run-large' },
      event('run-large', {
        kind: 'error',
        message: 'Coach output exceeded the stream limit. Retry your message.',
      }),
    ])
    expect(JSON.stringify(frames)).not.toContain(oversized)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('overflows when queued events exceed the byte budget', async () => {
    const cancel = vi.fn(() => Effect.void)
    const chunk = 'x'.repeat(900_000)
    const start = (_request: unknown, emit: (runId: string, event: CoachEvent) => void) =>
      Effect.sync(() => {
        emit('run-byte-overflow', { kind: 'text', delta: chunk })
        emit('run-byte-overflow', { kind: 'tool', tool: 'large', output: chunk })
        emit('run-byte-overflow', { kind: 'text', delta: chunk })
        return { ok: true, runId: 'run-byte-overflow' } as const
      })
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CoachRpcGroup)
      return yield* Stream.runCollect(client['coach:run'](request))
    }).pipe(Effect.scoped, Effect.provide(setup({ start, cancel }).handlers))

    const frames = await runWithMainServices(program)
    expect(frames[0]).toEqual({ _tag: 'Started', runId: 'run-byte-overflow' })
    expect(frames.slice(1, -1).map(frame => frame._tag === 'Event' && frame.event.kind)).toEqual(['text', 'tool'])
    expect(frames.at(-1)).toEqual(
      event('run-byte-overflow', {
        kind: 'error',
        message: 'Coach output exceeded the stream limit. Retry your message.',
      }),
    )
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('releases queued-byte accounting as events are dequeued', async () => {
    const chunk = 'x'.repeat(900_000)
    let emitLate: ((runId: string, event: CoachEvent) => void) | undefined
    const start = (_request: unknown, emit: (runId: string, event: CoachEvent) => void) =>
      Effect.sync(() => {
        emitLate = emit
        emit('run-drain', { kind: 'text', delta: chunk })
        return { ok: true, runId: 'run-drain' } as const
      })
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CoachRpcGroup)
      let drained = false
      let textEvents = 0
      return yield* Stream.runCollect(
        client['coach:run'](request).pipe(
          Stream.tap(frame =>
            Effect.sync(() => {
              if (frame._tag === 'Event' && frame.event.kind === 'text') {
                textEvents += 1
                if (!drained) {
                  drained = true
                  emitLate?.('run-drain', { kind: 'text', delta: chunk })
                  emitLate?.('run-drain', { kind: 'text', delta: chunk })
                }
                if (textEvents === 3) emitLate?.('run-drain', { kind: 'status', state: 'done' })
              }
            }),
          ),
        ),
      )
    }).pipe(Effect.scoped, Effect.provide(setup({ start }).handlers))

    const frames = await runWithMainServices(program)
    expect(frames.filter(frame => frame._tag === 'Event' && frame.event.kind === 'text')).toHaveLength(3)
    expect(frames.at(-1)).toEqual(event('run-drain', { kind: 'status', state: 'done' }))
  })

  it('awaits cancellation after a terminal event and accepts a later duplicate cancel', async () => {
    const cancelStarted = Effect.runSync(Deferred.make<undefined>())
    const stopGate = Effect.runSync(Deferred.make<undefined>())
    const cancelReturned = Effect.runSync(Deferred.make<undefined>())
    const cancel = vi.fn(() =>
      Effect.gen(function* () {
        yield* Deferred.succeed(cancelStarted, undefined)
        yield* Deferred.await(stopGate)
      }),
    )
    const start = (_request: unknown, emit: (runId: string, event: CoachEvent) => void) =>
      Effect.sync(() => {
        emit('run-terminal', { kind: 'status', state: 'done' })
        return { ok: true, runId: 'run-terminal' } as const
      })
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CoachRpcGroup)
      const streamStarted = yield* Deferred.make<undefined>()
      const continueStream = yield* Deferred.make<undefined>()
      const streamFiber = yield* Effect.forkChild(
        Stream.runCollect(
          client['coach:run'](request).pipe(
            Stream.tap(frame =>
              frame._tag === 'Started'
                ? Effect.gen(function* () {
                    yield* Deferred.succeed(streamStarted, undefined)
                    yield* Deferred.await(continueStream)
                  })
                : Effect.void,
            ),
          ),
        ),
      )
      yield* Deferred.await(streamStarted)
      const cancelFiber = yield* Effect.forkChild(
        client['coach:cancel']({ runId: 'run-terminal' }).pipe(
          Effect.tap(() => Deferred.succeed(cancelReturned, undefined)),
        ),
      )
      yield* Deferred.await(cancelStarted)
      const acknowledgedBeforeStop = yield* Deferred.isDone(cancelReturned)
      yield* Deferred.succeed(stopGate, undefined)
      yield* Fiber.join(cancelFiber)
      yield* Deferred.succeed(continueStream, undefined)
      yield* Fiber.join(streamFiber)
      yield* client['coach:cancel']({ runId: 'run-terminal' })
      return acknowledgedBeforeStop
    }).pipe(Effect.scoped, Effect.provide(setup({ start, cancel }).handlers))

    const acknowledgedBeforeStop = await runWithMainServices(program)
    expect(acknowledgedBeforeStop).toBe(false)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('cancels on observer interruption and rejects cancellation of another connection run', async () => {
    const ready = Effect.runSync(Deferred.make<undefined>())
    const cancel = vi.fn(() => Effect.void)
    const start = () => Effect.succeed({ ok: true, runId: 'run-owned' } as const)
    const configured = setup({ start, cancel })
    const disconnectProgram = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CoachRpcGroup)
      const fiber = yield* Effect.forkChild(
        Stream.runForEach(client['coach:run'](request), frame =>
          frame._tag === 'Started' ? Deferred.succeed(ready, undefined) : Effect.void,
        ),
      )
      yield* Deferred.await(ready)
      yield* Fiber.interrupt(fiber)
      return yield* Effect.exit(client['coach:cancel']({ runId: 'foreign-run' }))
    }).pipe(Effect.scoped, Effect.provide(configured.handlers))

    const result = await runWithMainServices(disconnectProgram)
    expect(cancel).toHaveBeenCalledWith('run-owned')
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      const error = Cause.findError(result.cause)
      expect(error).toMatchObject({
        _tag: 'Success',
        success: new CoachRpcError({
          code: 'unauthorized',
          message: 'The Coach run is not owned by this connection.',
        }),
      })
    }
  })

  it('interrupts a pending start and cancels its allocated run id on disconnect', async () => {
    const gate = Effect.runSync(Deferred.make<undefined>())
    const ready = Effect.runSync(Deferred.make<undefined>())
    const cancel = vi.fn(() => Effect.void)
    const start = (
      _request: unknown,
      _emit: (runId: string, event: CoachEvent) => void,
      onRunId?: (runId: string) => void,
    ) => {
      onRunId?.('run-pending')
      return Effect.as(Deferred.await(gate), { ok: true, runId: 'run-pending' } as const)
    }
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CoachRpcGroup)
      const fiber = yield* Effect.forkChild(
        Stream.runForEach(client['coach:run'](request), frame =>
          frame._tag === 'Started' ? Deferred.succeed(ready, undefined) : Effect.void,
        ),
      )
      yield* Effect.sleep('10 millis')
      yield* Fiber.interrupt(fiber)
    }).pipe(Effect.scoped, Effect.provide(setup({ start, cancel }).handlers))

    await runWithMainServices(program)
    expect(cancel).toHaveBeenCalledWith('run-pending')
    expect(Effect.runSync(Deferred.isDone(ready))).toBe(false)
  })

  it('terminates an owned stream on reset and drops late backend events', async () => {
    const runStarted = Effect.runSync(Deferred.make<undefined>())
    const reset = vi.fn(() => Effect.void)
    const resetEffect = Effect.suspend(() => reset())
    let lateEmit: ((runId: string, event: CoachEvent) => void) | undefined
    const start = (_request: unknown, emit: (runId: string, event: CoachEvent) => void) =>
      Effect.sync(() => {
        lateEmit = emit
        return { ok: true, runId: 'run-reset' } as const
      })
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CoachRpcGroup)
      const fiber = yield* Effect.forkChild(
        Stream.runCollect(
          client['coach:run'](request).pipe(
            Stream.tap(frame => (frame._tag === 'Started' ? Deferred.succeed(runStarted, undefined) : Effect.void)),
          ),
        ),
      )
      yield* Deferred.await(runStarted)
      yield* client['coach:reset']()
      lateEmit?.('run-reset', { kind: 'text', delta: 'late' })
      return yield* Fiber.join(fiber)
    }).pipe(Effect.scoped, Effect.provide(setup({ start, reset: resetEffect }).handlers))

    const frames = await runWithMainServices(program)
    expect(reset).toHaveBeenCalledOnce()
    expect(frames).toEqual([
      { _tag: 'Started', runId: 'run-reset' },
      event('run-reset', { kind: 'error', message: 'cancelled' }),
    ])
  })
})
