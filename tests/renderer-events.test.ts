import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Stream from 'effect/Stream'
import { describe, expect, it } from 'vitest'

import { legacyRendererEvents } from '../src/renderer/src/shared/lib/renderer-events.js'

type Bridge = ReturnType<NonNullable<Parameters<typeof legacyRendererEvents>[1]>>

function eventBridge(expectedListeners: number) {
  const listeners = new Map<string, (value: unknown) => void>()
  let subscribed!: () => void
  const ready = new Promise<void>(resolve => {
    subscribed = resolve
  })
  let removals = 0
  function listen<A>(channel: string, callback: (value: A) => void): () => void {
    listeners.set(channel, callback as (value: unknown) => void)
    if (listeners.size === expectedListeners) subscribed()
    return () => {
      listeners.delete(channel)
      removals++
    }
  }
  const api: Bridge = {
    onProgress: callback => listen('progress', callback),
    onError: callback => listen('error', callback),
    onChanged: callback => listen('changed', callback),
    onIdle: callback => listen('idle', callback),
    onConfigChanged: callback => listen('config', callback),
    onCurrencyChanged: callback => listen('currency', callback),
    onCoachEvent: callback => listen('coach', callback),
    onNavigate: callback => listen('navigate', callback),
    orb: { onPlacement: callback => listen('placement', callback) },
  }
  return {
    api,
    ready,
    listeners,
    removals: () => removals,
    emit: (key: string, value?: unknown) => listeners.get(key)?.(value),
  }
}

describe('scoped renderer events', () => {
  it('keeps beacon subscriptions light, drops malformed payloads, and tears down every listener', async () => {
    const bridge = eventBridge(5)
    const fiber = Effect.runFork(
      Stream.runCollect(legacyRendererEvents('beacon', () => bridge.api).pipe(Stream.take(2))),
    )
    await bridge.ready
    expect([...bridge.listeners.keys()]).toEqual(['progress', 'error', 'changed', 'idle', 'placement'])
    bridge.emit('progress', { stage: 'invalid' })
    bridge.emit('idle')
    bridge.emit('error', 'provider unavailable')
    const events = await Effect.runPromise(Fiber.join(fiber))
    expect(events).toEqual([{ _tag: 'ScanIdle' }, { _tag: 'ScanError', message: 'provider unavailable' }])
    expect(bridge.listeners.size).toBe(0)
    expect(bridge.removals()).toBe(5)
  })

  it('retains only Coach and navigation app subscriptions and releases them on interruption', async () => {
    const bridge = eventBridge(2)
    const fiber = Effect.runFork(Stream.runDrain(legacyRendererEvents('app', () => bridge.api)))
    await bridge.ready
    expect(bridge.listeners.has('coach')).toBe(true)
    expect(bridge.listeners.has('navigate')).toBe(true)
    expect(bridge.listeners.has('placement')).toBe(false)
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(bridge.listeners.size).toBe(0)
    expect(bridge.removals()).toBe(2)
  })

  it('does not retain duplicate application lifecycle categories on the legacy stream', async () => {
    const bridge = eventBridge(2)
    const fiber = Effect.runFork(
      Stream.runDrain(legacyRendererEvents('app', () => bridge.api, 256, undefined, ['ConfigChanged'])),
    )
    await bridge.ready
    expect(bridge.listeners.has('config')).toBe(false)
    expect(bridge.listeners.has('currency')).toBe(false)
    expect(bridge.listeners.has('update')).toBe(false)
    expect(bridge.listeners.has('harnesses')).toBe(false)
    expect(bridge.listeners.size).toBe(2)
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(bridge.listeners.size).toBe(0)
    expect(bridge.removals()).toBe(2)
  })

  it('releases already registered listeners if later subscription setup fails', async () => {
    const bridge = eventBridge(2)
    const api = {
      ...bridge.api,
      onNavigate: () => {
        throw new Error('unavailable')
      },
    }
    const result = await Effect.runPromiseExit(Stream.runDrain(legacyRendererEvents('app', () => api)))
    expect(result._tag).toBe('Failure')
    expect(bridge.listeners.size).toBe(0)
    expect(bridge.removals()).toBe(1)
  })

  it('fails visibly and releases subscriptions when a synchronous producer overruns its buffer', async () => {
    const bridge = eventBridge(5)
    const fiber = Effect.runFork(Stream.runCollect(legacyRendererEvents('beacon', () => bridge.api, 1)))
    await bridge.ready
    for (let index = 0; index < 100; index++) bridge.emit('idle')
    const result = await Effect.runPromiseExit(Fiber.join(fiber))
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') {
      expect(Cause.findError(result.cause)).toMatchObject({
        _tag: 'Success',
        success: { _tag: 'RendererEventError', reason: 'overflow' },
      })
    }
    expect(bridge.listeners.size).toBe(0)
  })
})
