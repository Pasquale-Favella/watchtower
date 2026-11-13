import * as Effect from 'effect/Effect'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { describe, expect, it } from 'vitest'

import { keepAliveFamily, readInspection } from '@/renderer/features/workspace/model-picker/inspection-family.js'

async function waitUntil(check: () => boolean) {
  const deadline = Date.now() + 2000
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  expect(check()).toBe(true)
}

/** Inspection responses that the test releases one at a time, in request order. */
function scriptedInspection() {
  const requests: Array<{ readonly succeed: (value: string) => void; readonly fail: () => void }> = []
  return {
    load: () =>
      Effect.tryPromise({
        try: () =>
          new Promise<string>((resolve, reject) => {
            requests.push({ succeed: resolve, fail: () => reject(new Error('unreachable agent')) })
          }),
        catch: cause => (cause instanceof Error ? cause : new Error(String(cause))),
      }),
    succeed: (value: string) => requests.shift()?.succeed(value),
    fail: () => requests.shift()?.fail(),
    started: () => requests.length,
  }
}

describe('keyed connection inspection cache', () => {
  it('retains one atom per connection id', () => {
    const scripted = scriptedInspection()
    const inspection = keepAliveFamily(() => Atom.make(scripted.load()))
    expect(inspection('codex-local')).toBe(inspection('codex-local'))
    expect(inspection('codex-local')).not.toBe(inspection('claude-local'))
  })

  it('reports pending with no value before the first inspection completes', () => {
    const registry = AtomRegistry.make()
    const scripted = scriptedInspection()
    const atom = keepAliveFamily(() => Atom.make(scripted.load()))('codex-local')
    registry.mount(atom)
    expect(readInspection(registry.get(atom))).toEqual({ value: null, pending: true, failed: false })
  })

  it('keeps the last value on screen while a refresh is in flight', async () => {
    const registry = AtomRegistry.make()
    const scripted = scriptedInspection()
    const atom = keepAliveFamily(() => Atom.make(scripted.load()))('codex-local')
    registry.mount(atom)
    scripted.succeed('first')
    await waitUntil(() => readInspection(registry.get(atom)).value === 'first')

    registry.refresh(atom)
    expect(readInspection(registry.get(atom))).toEqual({ value: 'first', pending: true, failed: false })

    scripted.succeed('second')
    await waitUntil(() => readInspection(registry.get(atom)).value === 'second')
    expect(readInspection(registry.get(atom))).toEqual({ value: 'second', pending: false, failed: false })
  })

  it('keeps the earlier value when a later refresh fails', async () => {
    const registry = AtomRegistry.make()
    const scripted = scriptedInspection()
    const atom = keepAliveFamily(() => Atom.make(scripted.load()))('codex-local')
    registry.mount(atom)
    scripted.succeed('first')
    await waitUntil(() => readInspection(registry.get(atom)).value === 'first')

    registry.refresh(atom)
    scripted.fail()
    await waitUntil(() => registry.get(atom)._tag === 'Failure' && !registry.get(atom).waiting)
    expect(readInspection(registry.get(atom))).toEqual({ value: 'first', pending: false, failed: false })
  })

  it('reports failure only when no earlier value exists', async () => {
    const registry = AtomRegistry.make()
    const scripted = scriptedInspection()
    const atom = keepAliveFamily(() => Atom.make(scripted.load()))('codex-local')
    registry.mount(atom)
    scripted.fail()
    await waitUntil(() => registry.get(atom)._tag === 'Failure')
    expect(readInspection(registry.get(atom))).toEqual({ value: null, pending: false, failed: true })
  })

  it('keeps a completed inspection after its last subscriber leaves, so switching back is instant', async () => {
    const registry = AtomRegistry.make()
    const scripted = scriptedInspection()
    const inspection = keepAliveFamily(() => Atom.make(scripted.load()))
    const unmount = registry.mount(inspection('codex-local'))
    scripted.succeed('cached')
    await waitUntil(() => readInspection(registry.get(inspection('codex-local'))).value === 'cached')
    unmount()

    expect(readInspection(registry.get(inspection('codex-local')))).toEqual({
      value: 'cached',
      pending: false,
      failed: false,
    })
    expect(scripted.started()).toBe(0)
  })
})
