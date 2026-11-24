import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Ref from 'effect/Ref'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'
import { describe, expect, it } from 'vitest'

import { consumeCoalescedAgentEvents } from '@/core/application/execution/coalesced-event-consumer.js'
import type { AgentDriverEvent } from '@/shared/schemas/execution.js'

describe('coalesced agent event consumer', () => {
  it('preserves order, flushes before critical events, and leaves oversized deltas intact', async () => {
    const input: ReadonlyArray<AgentDriverEvent> = [
      { kind: 'textDelta', text: 'hello ', itemId: 'message' },
      { kind: 'textDelta', text: 'world', itemId: 'message' },
      { kind: 'toolStarted', toolCallId: 'tool', name: 'read' },
      { kind: 'reasoningDelta', text: 'thinking' },
      { kind: 'textDelta', text: '猫🙂'.repeat(3) },
      { kind: 'turnCompleted' },
    ]
    const output: AgentDriverEvent[] = []

    await Effect.runPromise(
      consumeCoalescedAgentEvents(Stream.fromIterable(input), event => Effect.sync(() => output.push(event) > 0), {
        maxBufferedBytes: 16,
      }),
    )

    expect(output).toEqual([
      { kind: 'textDelta', text: 'hello world', itemId: 'message' },
      { kind: 'toolStarted', toolCallId: 'tool', name: 'read' },
      { kind: 'reasoningDelta', text: 'thinking' },
      { kind: 'textDelta', text: '猫🙂'.repeat(3) },
      { kind: 'turnCompleted' },
    ])
  })

  it('flushes pending text at its age limit while the upstream stream is idle', async () => {
    const committed = await Effect.runPromise(Ref.make<ReadonlyArray<AgentDriverEvent>>([]))
    const pulls = await Effect.runPromise(Ref.make(0))
    const releases = await Effect.runPromise(Ref.make(0))
    const secondPull = await Effect.runPromise(Deferred.make<undefined>())
    const source = Stream.concat(
      Stream.make({ kind: 'textDelta', text: 'pending' } as AgentDriverEvent),
      Stream.fromEffect(
        Effect.acquireRelease(
          Ref.update(pulls, count => count + 1).pipe(Effect.flatMap(() => Deferred.succeed(secondPull, undefined))),
          () => Ref.update(releases, count => count + 1),
        ),
      ).pipe(Stream.flatMap(() => Stream.never)),
    )

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            consumeCoalescedAgentEvents(
              source,
              event => Ref.update(committed, events => [...events, event]).pipe(Effect.as(true)),
              { maxBufferedAgeMs: 50 },
            ),
          )
          yield* Deferred.await(secondPull)
          yield* Effect.yieldNow
          yield* TestClock.adjust(50)
          const events = yield* Ref.get(committed)
          yield* Fiber.interrupt(fiber)
          return { events, pulls: yield* Ref.get(pulls), releases: yield* Ref.get(releases) }
        }).pipe(Effect.provide(TestClock.layer())),
      ),
    )

    expect(result).toEqual({ events: [{ kind: 'textDelta', text: 'pending' }], pulls: 1, releases: 1 })
  })

  it('awaits each slow commit before starting the next one', async () => {
    const committed = await Effect.runPromise(Ref.make<ReadonlyArray<AgentDriverEvent>>([]))
    const firstCommit = await Effect.runPromise(Deferred.make<undefined>())
    const finishFirstCommit = await Effect.runPromise(Deferred.make<undefined>())
    const sourceEvents: ReadonlyArray<AgentDriverEvent> = [
      { kind: 'nativeNotice', message: 'first' },
      { kind: 'nativeNotice', message: 'second' },
    ]
    const source = Stream.fromIterable(sourceEvents)

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            consumeCoalescedAgentEvents(source, event =>
              Ref.update(committed, events => [...events, event]).pipe(
                Effect.flatMap(() =>
                  event.kind === 'nativeNotice' && event.message === 'first'
                    ? Deferred.succeed(firstCommit, undefined).pipe(
                        Effect.flatMap(() => Deferred.await(finishFirstCommit)),
                      )
                    : Effect.succeed(undefined),
                ),
                Effect.as(true),
              ),
            ),
          )
          yield* Deferred.await(firstCommit)
          const whileFirstCommitPending = yield* Ref.get(committed)
          yield* Deferred.succeed(finishFirstCommit, undefined)
          yield* Fiber.join(fiber)
          return { whileFirstCommitPending, afterCommit: yield* Ref.get(committed) }
        }),
      ),
    )

    expect(result).toEqual({
      whileFirstCommitPending: [{ kind: 'nativeNotice', message: 'first' }],
      afterCommit: [
        { kind: 'nativeNotice', message: 'first' },
        { kind: 'nativeNotice', message: 'second' },
      ],
    })
  })

  it('flushes pending text before propagating an upstream failure', async () => {
    const error = new Error('stream failed')
    const output: AgentDriverEvent[] = []
    const source = Stream.concat(
      Stream.make({ kind: 'reasoningDelta', text: 'before failure' } as AgentDriverEvent),
      Stream.fail(error),
    )

    await expect(
      Effect.runPromise(consumeCoalescedAgentEvents(source, event => Effect.sync(() => (output.push(event), true)))),
    ).rejects.toBe(error)
    expect(output).toEqual([{ kind: 'reasoningDelta', text: 'before failure' }])
  })

  it('stops after a terminal commit returns false', async () => {
    const output: AgentDriverEvent[] = []
    const input: ReadonlyArray<AgentDriverEvent> = [
      { kind: 'turnCompleted' },
      { kind: 'nativeNotice', message: 'after completion' },
    ]
    const source = Stream.fromIterable(input)

    await Effect.runPromise(
      consumeCoalescedAgentEvents(source, event =>
        Effect.sync(() => {
          output.push(event)
          return false
        }),
      ),
    )

    expect(output).toEqual([{ kind: 'turnCompleted' }])
  })

  it('rejects invalid coalescing configuration with a typed error', async () => {
    await expect(
      Effect.runPromise(consumeCoalescedAgentEvents(Stream.empty, () => Effect.succeed(true), { maxBufferedAgeMs: 0 })),
    ).rejects.toMatchObject({ _tag: 'CoalescedEventConsumerConfigError' })
  })
})
