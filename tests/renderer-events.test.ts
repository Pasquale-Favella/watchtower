import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Stream from 'effect/Stream'
import { describe, expect, it, vi } from 'vitest'

import { navigationEvents } from '../src/renderer/src/shared/lib/navigation-events.js'
import type { Section } from '../src/shared/schemas/navigation.js'

function navigationBridge() {
  let receive!: (value: unknown) => void
  let attached!: () => void
  const ready = new Promise<void>(resolve => {
    attached = resolve
  })
  const unsubscribe = vi.fn()
  return {
    ready,
    unsubscribe,
    emit: (value: unknown) => receive(value),
    api: {
      onNavigate: (listener: (value: Section) => void) => {
        receive = value => listener(value as Section)
        attached()
        return unsubscribe
      },
    },
  }
}

describe('scoped native shell navigation events', () => {
  it('drops malformed Sections and releases the listener after the consumer completes', async () => {
    const bridge = navigationBridge()
    const consumer = Effect.runFork(Stream.runCollect(navigationEvents(() => bridge.api).pipe(Stream.take(1))))
    await bridge.ready
    bridge.emit('/etc/passwd')
    bridge.emit('models')
    expect(await Effect.runPromise(Fiber.join(consumer))).toEqual(['models'])
    expect(bridge.unsubscribe).toHaveBeenCalledOnce()
  })

  it('releases the listener on interruption', async () => {
    const bridge = navigationBridge()
    const consumer = Effect.runFork(Stream.runDrain(navigationEvents(() => bridge.api)))
    await bridge.ready
    await Effect.runPromise(Fiber.interrupt(consumer))
    expect(bridge.unsubscribe).toHaveBeenCalledOnce()
  })

  it('reports unavailable shell registration as a typed failure', async () => {
    const result = await Effect.runPromiseExit(
      Stream.runDrain(
        navigationEvents(() => {
          throw new Error('private path')
        }),
      ),
    )
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure')
      expect(Cause.findError(result.cause)).toMatchObject({
        _tag: 'Success',
        success: { _tag: 'NavigationEventError', reason: 'unavailable' },
      })
    expect(String(result)).not.toContain('private path')
  })

  it('fails visibly and releases its bounded listener when a synchronous producer overruns it', async () => {
    const bridge = navigationBridge()
    const consumer = Effect.runFork(Stream.runCollect(navigationEvents(() => bridge.api, undefined, 1)))
    await bridge.ready
    for (let index = 0; index < 100; index++) bridge.emit('models')
    const result = await Effect.runPromiseExit(Fiber.join(consumer))
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure')
      expect(Cause.findError(result.cause)).toMatchObject({
        _tag: 'Success',
        success: { _tag: 'NavigationEventError', reason: 'overflow' },
      })
    expect(bridge.unsubscribe).toHaveBeenCalledOnce()
  })
})
