import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { describe, expect, it, vi } from 'vitest'

import { createWorkspaceQueryPolling } from '../src/renderer/features/workspace/polling.js'
import { createRpcQuerySlot } from '../src/renderer/stores/atoms/rpc-query.js'

async function waitUntil(check: () => boolean) {
  const deadline = Date.now() + 2000
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  expect(check()).toBe(true)
}

function fixture() {
  let requests = 0
  const registry = AtomRegistry.make()
  const slot = createRpcQuerySlot({
    key: (request: string) => request,
    query: () => Atom.make(Effect.sync(() => ++requests)),
  })
  const polling = createWorkspaceQueryPolling(Atom.context()(Layer.empty), { targets: [slot], intervalMs: 20 })
  slot.pin(registry)
  registry.set(slot.requestAtom, 'projects')
  return { registry, slot, polling, requests: () => requests }
}

describe('mounted workspace query consumers', () => {
  it('stops refreshing a retained query when its last view unmounts', async () => {
    const { registry, slot, polling, requests } = fixture()
    try {
      const unmount = polling.retain(registry, slot)
      await waitUntil(() => requests() === 2)
      unmount()
      const atUnmount = requests()
      await new Promise(resolve => setTimeout(resolve, 80))
      expect(requests()).toBe(atUnmount)
    } finally {
      registry.dispose()
    }
  })
})

it('shares one fallback poll between two consumers of the same query', async () => {
  const { registry, slot, polling, requests } = fixture()
  try {
    const first = polling.retain(registry, slot)
    const second = polling.retain(registry, slot)
    await waitUntil(() => requests() === 2)
    first()
    await waitUntil(() => requests() === 3)
    second()
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(requests()).toBe(3)
  } finally {
    registry.dispose()
  }
})

it('resumes fallback refreshes when a retained query is remounted', async () => {
  const { registry, slot, polling, requests } = fixture()
  try {
    const first = polling.retain(registry, slot)
    await waitUntil(() => requests() === 2)
    first()
    await new Promise(resolve => setTimeout(resolve, 80))
    const remount = polling.retain(registry, slot)
    await waitUntil(() => requests() === 3)
    remount()
  } finally {
    registry.dispose()
  }
})

it('pauses polling while hidden and resumes when the mounted window becomes visible', async () => {
  const document = Object.assign(new EventTarget(), { visibilityState: 'hidden' })
  vi.stubGlobal('document', document)
  const { registry, slot, polling, requests } = fixture()
  try {
    const unmount = polling.retain(registry, slot)
    await waitUntil(() => requests() === 1)
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(requests()).toBe(1)
    document.visibilityState = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    await waitUntil(() => requests() === 2)
    document.visibilityState = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(requests()).toBe(2)
    unmount()
  } finally {
    registry.dispose()
    vi.unstubAllGlobals()
  }
})

it('refreshes event-driven queries only on events while a consumer remains mounted', async () => {
  const { registry, polling, requests } = fixture()
  let requestEvents = 0
  const eventDriven = createRpcQuerySlot({
    key: (request: string) => request,
    query: () => Atom.make(Effect.sync(() => ++requestEvents)),
  })
  eventDriven.pin(registry)
  registry.set(eventDriven.requestAtom, 'pending-runtime-requests')
  try {
    const unmount = polling.retain(registry, eventDriven)
    await waitUntil(() => requests() === 1 && requestEvents === 1)
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(requests()).toBe(1)
    expect(requestEvents).toBe(1)
    polling.refresh(registry, [eventDriven])
    await waitUntil(() => requestEvents === 2)
    unmount()
    polling.refresh(registry, [eventDriven])
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(requestEvents).toBe(2)
  } finally {
    registry.dispose()
  }
})
