import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { appLifecycleReadinessAtom } from '../src/renderer/src/app/atoms/rpc-lifecycle.js'
import { initialScanState, scanStateAtom } from '../src/renderer/src/app/atoms/scan.js'
import { setRouter } from '../src/renderer/src/app/navigation.js'
import { appEventsReadyAtom, subscribeToIpc } from '../src/renderer/src/app/stores/subscribe.js'
import { coachStateAtom } from '../src/renderer/src/features/coach-skills/atoms.js'

function captureApi(overrides: Record<string, unknown> = {}) {
  const listeners: Record<string, (payload?: unknown) => void> = {}
  const api = {
    onCoachEvent: (listener: (payload: unknown) => void) => {
      listeners.onCoachEvent = listener
      return () => {}
    },
    onNavigate: (listener: (payload: unknown) => void) => {
      listeners.onNavigate = listener
      return () => {}
    },
    ...overrides,
  }
  vi.stubGlobal('window', { api })
  return { api, listeners }
}

function flushEvents(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

let registry: AtomRegistry.AtomRegistry
beforeEach(() => {
  registry = AtomRegistry.make()
  registry.set(scanStateAtom, initialScanState())
})

afterEach(() => {
  registry.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('legacy app subscriptions', () => {
  it('keeps only Coach and navigation on the legacy stream', async () => {
    const { listeners } = captureApi()
    const teardown = subscribeToIpc(registry)
    await flushEvents()

    expect(registry.get(appEventsReadyAtom)).toBe('ready')
    expect(Object.keys(listeners).sort()).toEqual(['onCoachEvent', 'onNavigate'])
    expect(registry.get(appLifecycleReadinessAtom).state).toBe('inactive')
    teardown()
    await flushEvents()
  })

  it('validates Coach events and leaves malformed payloads unapplied', async () => {
    const { listeners } = captureApi()
    registry.set(coachStateAtom, { ...registry.get(coachStateAtom), running: true })
    const teardown = subscribeToIpc(registry)
    await flushEvents()

    listeners.onCoachEvent?.({ runId: 'run-1', event: { kind: 'text', delta: 'Hello', extra: 'discarded' } })
    await flushEvents()
    expect(registry.get(coachStateAtom).pendingEvents['run-1']).toEqual([
      { runId: 'run-1', event: { kind: 'text', delta: 'Hello' } },
    ])

    listeners.onCoachEvent?.({ runId: 'run-1', event: { kind: 'text', delta: 42 } })
    await flushEvents()
    expect(registry.get(coachStateAtom).pendingEvents['run-1']).toHaveLength(1)
    teardown()
    await flushEvents()
  })

  it('does not block scan state when the Coach/navigation legacy wiring fails', async () => {
    captureApi({
      onNavigate: () => {
        throw new Error('legacy bridge unavailable')
      },
    })
    const teardown = subscribeToIpc(registry)
    await vi.waitFor(() => expect(registry.get(appEventsReadyAtom)).toBe('failed'))
    expect(registry.get(scanStateAtom)).toEqual(initialScanState())
    expect(registry.get(appLifecycleReadinessAtom).state).toBe('inactive')
    teardown()
    await flushEvents()
  })

  it('opens a Section from a valid legacy navigation event and drops unknown values', async () => {
    const navigate = vi.fn()
    setRouter(navigate)
    const { listeners } = captureApi()
    const teardown = subscribeToIpc(registry)
    await flushEvents()

    listeners.onNavigate?.('optimize')
    await flushEvents()
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/optimize')
    listeners.onNavigate?.('/etc/passwd')
    await flushEvents()
    expect(navigate).toHaveBeenCalledOnce()

    teardown()
    await flushEvents()
    setRouter(() => {})
  })

  it('shares the Coach/navigation event owner until its last release', async () => {
    const listeners: Record<string, (payload?: unknown) => void> = {}
    const unsub = vi.fn(() => {})
    vi.stubGlobal('window', {
      api: {
        onCoachEvent: (listener: (payload: unknown) => void) => {
          listeners.onCoachEvent = listener
          return unsub
        },
        onNavigate: (listener: (payload: unknown) => void) => {
          listeners.onNavigate = listener
          return unsub
        },
      },
    })
    const teardown = subscribeToIpc(registry)
    const releaseSecondOwner = subscribeToIpc(registry)
    await flushEvents()
    expect(Object.keys(listeners)).toHaveLength(2)
    teardown()
    await flushEvents()
    expect(unsub).not.toHaveBeenCalled()
    releaseSecondOwner()
    await flushEvents()
    expect(unsub).toHaveBeenCalledTimes(2)
  })
})
