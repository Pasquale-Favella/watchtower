import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import * as Reactivity from 'effect/reactivity/Reactivity'
import { describe, expect, it, vi } from 'vitest'

import { createRemoteQuerySlot, restartRemoteQuery } from '../src/renderer/src/app/atoms/remote-query.js'

const makeRuntime = () => Atom.context()(Layer.empty)

const waitFor = <A>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, unknown>>,
  matches: (result: AsyncResult.AsyncResult<A, unknown>) => boolean,
): Promise<AsyncResult.AsyncResult<A, unknown>> =>
  new Promise((resolve, reject) => {
    const subscription: { unsubscribe?: () => void } = {}
    let finishAfterSubscription = false
    const onValue = (result: AsyncResult.AsyncResult<A, unknown>) => {
      if (matches(result)) {
        if (subscription.unsubscribe === undefined) finishAfterSubscription = true
        else subscription.unsubscribe()
        resolve(result)
      } else if (result._tag === 'Failure' && !result.waiting) {
        if (subscription.unsubscribe === undefined) finishAfterSubscription = true
        else subscription.unsubscribe()
        reject(result.cause)
      }
    }
    subscription.unsubscribe = registry.subscribe(atom, onValue, { immediate: true })
    if (finishAfterSubscription) subscription.unsubscribe()
  })

const waitForSuccess = <A>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, unknown>>,
  expected: A,
) => waitFor(registry, atom, result => result._tag === 'Success' && Object.is(result.value, expected))

const waitForFailure = <A>(registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<AsyncResult.AsyncResult<A, unknown>>) =>
  waitFor(registry, atom, result => result._tag === 'Failure' && !result.waiting)

const waitForCount = async (getCount: () => number, expected: number): Promise<void> => {
  const deadline = Date.now() + 1000
  while (getCount() < expected && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  expect(getCount()).toBe(expected)
}

const deferredFetcher = () => {
  const resolvers: Array<(value: string) => void> = []
  const fetch = (request: string) =>
    Effect.callback<string, never>(resume => {
      resolvers.push(value => resume(Effect.succeed(`${request}:${value}`)))
    })
  return { fetch, resolvers }
}

describe('remote query slot', () => {
  it('discards cleared data and pending refreshes without activating unopened queries', async () => {
    const registry = AtomRegistry.make()
    const deferred = deferredFetcher()
    const slot = createRemoteQuerySlot({
      runtime: makeRuntime(),
      key: (request: string) => request,
      fetch: deferred.fetch,
    })
    const release = slot.pin(registry)
    Atom.batch(() => restartRemoteQuery(registry, slot))
    expect(registry.get(slot.requestAtom)).toBeNull()
    expect(deferred.resolvers).toHaveLength(0)

    registry.set(slot.requestAtom, 'A')
    await waitForCount(() => deferred.resolvers.length, 1)
    deferred.resolvers[0]('before clear')
    await waitForSuccess(registry, slot.resultAtom, 'A:before clear')
    registry.set(slot.refreshAtom, undefined)
    await waitForCount(() => deferred.resolvers.length, 2)

    Atom.batch(() => restartRemoteQuery(registry, slot))
    expect(registry.get(slot.requestAtom)).toBe('A')
    expect(registry.get(slot.resultAtom)._tag).toBe('Initial')
    await waitForCount(() => deferred.resolvers.length, 3)
    deferred.resolvers[1]('late pre-clear response')
    expect(registry.get(slot.resultAtom)._tag).toBe('Initial')
    deferred.resolvers[2]('after clear')
    await waitForSuccess(registry, slot.resultAtom, 'A:after clear')
    release()
    registry.dispose()
  })
  it('does not fetch before selection and reading, then pins its current member', async () => {
    const registry = AtomRegistry.make()
    let fetches = 0
    const slot = createRemoteQuerySlot({
      runtime: makeRuntime(),
      key: (request: string) => request,
      fetch: (request: string) => Effect.sync(() => `${request}:${++fetches}`),
    })

    const unpin = slot.pin(registry)
    expect(registry.get(slot.resultAtom)._tag).toBe('Initial')
    expect(fetches).toBe(0)
    registry.set(slot.requestAtom, 'A')

    await waitForSuccess(registry, slot.resultAtom, 'A:1')
    expect(registry.get(slot.resultAtom)).toMatchObject({ _tag: 'Success', value: 'A:1' })
    expect(fetches).toBe(1)
    registry.set(slot.requestAtom, null)
    expect(registry.get(slot.resultAtom)._tag).toBe('Initial')
    expect(fetches).toBe(1)
    unpin()
    registry.dispose()
  })

  it('does not show a cached result after A/B/A and ignores late completion from a superseded request', async () => {
    const registry = AtomRegistry.make()
    const deferred = deferredFetcher()
    const slot = createRemoteQuerySlot({
      runtime: makeRuntime(),
      key: (request: string) => request,
      fetch: deferred.fetch,
    })

    registry.set(slot.requestAtom, 'A')
    const unpin = slot.pin(registry)
    const firstA = waitForSuccess(registry, slot.resultAtom, 'A:old')
    await waitForCount(() => deferred.resolvers.length, 1)
    deferred.resolvers[0]('old')
    await firstA
    const activeNodeCount = registry.getNodes().size

    registry.set(slot.requestAtom, 'B')
    expect(registry.get(slot.resultAtom)._tag).toBe('Initial')
    await waitForCount(() => deferred.resolvers.length, 2)

    registry.set(slot.requestAtom, 'A')
    expect(registry.get(slot.resultAtom)._tag).toBe('Initial')
    const currentA = waitForSuccess(registry, slot.resultAtom, 'A:fresh')
    await waitForCount(() => deferred.resolvers.length, 3)
    deferred.resolvers[1]('late B')
    expect(registry.get(slot.resultAtom)._tag).toBe('Initial')
    deferred.resolvers[2]('fresh')
    await currentA
    await vi.waitFor(() => expect(registry.getNodes().size).toBe(activeNodeCount))
    unpin()
    registry.dispose()
  })

  it('preserves same-identity data during refresh and ignores an older refresh completion', async () => {
    const registry = AtomRegistry.make()
    const deferred = deferredFetcher()
    const slot = createRemoteQuerySlot({
      runtime: makeRuntime(),
      key: (request: string) => request,
      fetch: deferred.fetch,
    })

    registry.set(slot.requestAtom, 'A')
    const unpin = slot.pin(registry)
    const first = waitForSuccess(registry, slot.resultAtom, 'A:old')
    await waitForCount(() => deferred.resolvers.length, 1)
    deferred.resolvers[0]('old')
    await first

    registry.set(slot.refreshAtom, undefined)
    await waitForCount(() => deferred.resolvers.length, 2)
    expect(registry.get(slot.resultAtom)).toMatchObject({ _tag: 'Success', value: 'A:old', waiting: true })

    registry.set(slot.refreshAtom, undefined)
    await waitForCount(() => deferred.resolvers.length, 3)
    deferred.resolvers[1]('late')
    expect(registry.get(slot.resultAtom)).toMatchObject({ _tag: 'Success', value: 'A:old', waiting: true })

    const refreshed = waitForSuccess(registry, slot.resultAtom, 'A:new')
    deferred.resolvers[2]('new')
    await refreshed
    unpin()
    registry.dispose()
  })

  it('retains same-identity success through a typed refresh failure', async () => {
    const registry = AtomRegistry.make()
    const problem = { _tag: 'QueryFailed' }
    let calls = 0
    const slot = createRemoteQuerySlot({
      runtime: makeRuntime(),
      key: (request: string) => request,
      fetch: (request: string) => {
        calls += 1
        return calls === 1 ? Effect.succeed(`${request}:old`) : Effect.fail(problem)
      },
    })

    registry.set(slot.requestAtom, 'A')
    const unpin = slot.pin(registry)
    await waitForSuccess(registry, slot.resultAtom, 'A:old')
    registry.set(slot.refreshAtom, undefined)
    const failure = await waitForFailure(registry, slot.resultAtom)
    expect(failure._tag).toBe('Failure')
    if (failure._tag === 'Failure') {
      expect(Option.getOrThrow(failure.previousSuccess).value).toBe('A:old')
      const failureReason = Cause.findError(failure.cause)
      expect(failureReason).toMatchObject({ _tag: 'Success', success: problem })
    }
    unpin()
    registry.dispose()
  })

  it('reruns the source atom when its Reactivity key is invalidated', async () => {
    const registry = AtomRegistry.make()
    const runtime = makeRuntime()
    const deferred = deferredFetcher()
    const slot = createRemoteQuerySlot({
      runtime,
      key: (request: string) => request,
      fetch: deferred.fetch,
      reactivityKeys: ['overview'],
    })
    const invalidate = runtime.fn(() => Reactivity.invalidate(['overview']))

    registry.set(slot.requestAtom, 'A')
    const unpin = slot.pin(registry)
    await waitForCount(() => deferred.resolvers.length, 1)

    registry.set(invalidate, undefined)
    await waitForCount(() => deferred.resolvers.length, 2)
    deferred.resolvers[0]('late first')
    expect(registry.get(slot.resultAtom)._tag).toBe('Initial')

    const first = waitForSuccess(registry, slot.resultAtom, 'A:first')
    deferred.resolvers[1]('first')
    await first

    registry.set(invalidate, undefined)
    await waitForCount(() => deferred.resolvers.length, 3)
    expect(registry.get(slot.resultAtom)).toMatchObject({ _tag: 'Success', value: 'A:first', waiting: true })
    const second = waitForSuccess(registry, slot.resultAtom, 'A:second')
    deferred.resolvers[2]('second')
    await second
    unpin()
    registry.dispose()
  })

  it('releases the active query scope when the registry is disposed', async () => {
    const registry = AtomRegistry.make()
    let acquired = 0
    let finalized = 0
    const slot = createRemoteQuerySlot({
      runtime: makeRuntime(),
      key: (request: string) => request,
      fetch: (request: string) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            acquired += 1
            return request
          }),
          () =>
            Effect.sync(() => {
              finalized += 1
            }),
        ).pipe(Effect.andThen(Effect.never)),
    })

    registry.set(slot.requestAtom, 'A')
    slot.pin(registry)
    await waitForCount(() => acquired, 1)
    expect(finalized).toBe(0)
    registry.dispose()
    await waitForCount(() => finalized, 1)
  })
})
