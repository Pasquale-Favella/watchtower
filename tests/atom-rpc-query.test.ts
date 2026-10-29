import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import * as AtomRpc from 'effect/reactivity/AtomRpc'
import * as Reactivity from 'effect/reactivity/Reactivity'
import * as Rpc from 'effect/rpc/Rpc'
import * as RpcGroup from 'effect/rpc/RpcGroup'
import * as RpcTest from 'effect/rpc/RpcTest'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import { createRpcQuerySlot, restartRpcQuery } from '../src/renderer/src/app/atoms/rpc-query.js'

const Query = Rpc.make('fixture:query', {
  payload: { request: Schema.String },
  success: Schema.String,
})
const Group = RpcGroup.make(Query)
type QueryClient = ReturnType<typeof makeClient>

const makeClient = (
  runtime: Atom.RegistryRuntimeFactory,
  handler: (request: string) => Effect.Effect<string>,
  lifecycle: { readonly acquired?: () => void; readonly released?: () => void } = {},
) => {
  const handlers = Group.toLayer(
    Group.of({
      'fixture:query': ({ request }) => handler(request),
    }),
  )
  return AtomRpc.Service<object>()('test/AtomRpc', {
    group: Group,
    protocol: Layer.empty,
    runtime,
    makeEffect: Effect.acquireRelease(
      Effect.sync(() => lifecycle.acquired?.()),
      () => Effect.sync(() => lifecycle.released?.()),
    ).pipe(Effect.andThen(RpcTest.makeClient(Group, { flatten: true })), Effect.provide(handlers)),
  })
}

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

const waitForCount = async (read: () => number, expected: number) => {
  const deadline = Date.now() + 1000
  while (read() < expected && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 0))
  expect(read()).toBe(expected)
}

const fixtureSlot = (client: QueryClient) =>
  createRpcQuerySlot<string, string, unknown>({
    key: request => request,
    query: (request, selectionId) =>
      client.query('fixture:query', { request }, { serializationKey: selectionId, reactivityKeys: ['fixture'] }),
  })

describe('native AtomRpc query slot', () => {
  it('does not query until a selected slot is mounted, then releases its current member', async () => {
    const registry = AtomRegistry.make()
    const runtimeFactory = Atom.context()
    let calls = 0
    const slot = fixtureSlot(makeClient(runtimeFactory, request => Effect.sync(() => `${request}:${++calls}`)))
    const unpin = slot.pin(registry)

    expect(registry.get(slot.resultAtom)._tag).toBe('Initial')
    expect(calls).toBe(0)
    registry.set(slot.requestAtom, 'A')
    await waitFor(registry, slot.resultAtom, result => result._tag === 'Success' && result.value === 'A:1')
    expect(calls).toBe(1)

    registry.set(slot.requestAtom, null)
    expect(registry.get(slot.resultAtom)._tag).toBe('Initial')
    expect(calls).toBe(1)
    unpin()
    registry.dispose()
  })

  it('uses a fresh family member for A/B/A and ignores late superseded replies', async () => {
    const registry = AtomRegistry.make()
    const runtimeFactory = Atom.context()
    const replies: Array<(value: string) => void> = []
    const calls: string[] = []
    const interrupted: string[] = []
    const client = makeClient(runtimeFactory, request =>
      Effect.callback<string>(resume => {
        calls.push(request)
        replies.push(value => resume(Effect.succeed(value)))
        return Effect.sync(() => {
          interrupted.push(request)
        })
      }),
    )
    const slot = fixtureSlot(client)
    const unpin = slot.pin(registry)

    registry.set(slot.requestAtom, 'A')
    await waitForCount(() => replies.length, 1)
    replies[0]('A-old')
    await waitFor(registry, slot.resultAtom, result => result._tag === 'Success' && result.value === 'A-old')

    registry.set(slot.requestAtom, 'B')
    expect(registry.get(slot.resultAtom)._tag).toBe('Initial')
    await waitForCount(() => replies.length, 2)
    registry.set(slot.requestAtom, 'A')
    expect(registry.get(slot.resultAtom)._tag).toBe('Initial')
    await waitForCount(() => interrupted.length, 1)
    expect(interrupted).toEqual(['B'])
    await waitForCount(() => replies.length, 3)
    replies[1]('B-late')
    expect(registry.get(slot.resultAtom)._tag).toBe('Initial')
    replies[2]('A-fresh')
    await waitFor(registry, slot.resultAtom, result => result._tag === 'Success' && result.value === 'A-fresh')

    expect(calls).toEqual(['A', 'B', 'A'])
    unpin()
    registry.dispose()
  })

  it('keeps same-query data on a failed refresh and invalidates through shared Reactivity', async () => {
    const registry = AtomRegistry.make()
    const runtimeFactory = Atom.context()
    const runtime = runtimeFactory(Layer.empty)
    let calls = 0
    const client = makeClient(runtimeFactory, request =>
      Effect.sync(() => {
        calls += 1
        if (calls === 2) throw new Error('refresh failed')
        return `${request}:${calls}`
      }),
    )
    const slot = fixtureSlot(client)
    const unpin = slot.pin(registry)
    registry.set(slot.requestAtom, 'A')
    await waitFor(registry, slot.resultAtom, result => result._tag === 'Success' && result.value === 'A:1')

    registry.set(slot.refreshAtom, undefined)
    const failed = await waitFor(registry, slot.resultAtom, result => result._tag === 'Failure' && !result.waiting)
    expect(failed._tag === 'Failure' && Option.getOrThrow(failed.previousSuccess).value).toBe('A:1')

    registry.set(slot.requestAtom, 'A')
    expect(calls).toBe(2)
    const invalidate = runtime.fn(() => Reactivity.invalidate(['fixture']))
    registry.set(invalidate, undefined)
    await waitFor(registry, slot.resultAtom, result => result._tag === 'Success' && result.value === 'A:3')

    unpin()
    registry.dispose()
  })

  it('isolates clients by registry and releases each scoped client when disposed', async () => {
    let acquisitions = 0
    const makeRegistry = () => {
      const registry = AtomRegistry.make()
      const runtime = Atom.context()
      const client = makeClient(runtime, request => Effect.sync(() => `${request}:${++acquisitions}`))
      const slot = fixtureSlot(client)
      const unpin = slot.pin(registry)
      registry.set(slot.requestAtom, 'same')
      return { registry, slot, unpin }
    }
    const first = makeRegistry()
    const second = makeRegistry()
    await waitFor(first.registry, first.slot.resultAtom, result => result._tag === 'Success')
    await waitFor(second.registry, second.slot.resultAtom, result => result._tag === 'Success')
    expect(first.registry.get(first.slot.resultAtom)).not.toEqual(second.registry.get(second.slot.resultAtom))
    expect(acquisitions).toBe(2)
    first.unpin()
    second.unpin()
    first.registry.dispose()
    second.registry.dispose()
  })

  it('acquires one native client for multiple slots and releases it with the registry', async () => {
    const registry = AtomRegistry.make()
    const runtime = Atom.context()
    let acquired = 0
    let released = 0
    const client = makeClient(runtime, request => Effect.succeed(request.toUpperCase()), {
      acquired: () => acquired++,
      released: () => released++,
    })
    const first = fixtureSlot(client)
    const second = fixtureSlot(client)
    first.pin(registry)
    second.pin(registry)
    registry.set(first.requestAtom, 'one')
    registry.set(second.requestAtom, 'two')

    await waitFor(registry, first.resultAtom, result => result._tag === 'Success')
    await waitFor(registry, second.resultAtom, result => result._tag === 'Success')
    expect(acquired).toBe(1)
    registry.dispose()
    await waitForCount(() => released, 1)
  })

  it('reset followed by the same request creates a fresh selection', async () => {
    const registry = AtomRegistry.make()
    let calls = 0
    const slot = fixtureSlot(makeClient(Atom.context(), request => Effect.sync(() => `${request}:${++calls}`)))
    const unpin = slot.pin(registry)
    registry.set(slot.requestAtom, 'A')
    await waitFor(registry, slot.resultAtom, result => result._tag === 'Success' && result.value === 'A:1')
    restartRpcQuery(registry, slot)
    await waitFor(registry, slot.resultAtom, result => result._tag === 'Success' && result.value === 'A:2')
    unpin()
    registry.dispose()
  })

  it('reset leaves an unopened slot idle and rejects a pending refresh result', async () => {
    const registry = AtomRegistry.make()
    const runtimeFactory = Atom.context()
    const replies: Array<(value: string) => void> = []
    const client = makeClient(runtimeFactory, request =>
      Effect.callback<string>(resume => {
        replies.push(value => resume(Effect.succeed(`${request}:${value}`)))
      }),
    )
    const slot = fixtureSlot(client)
    const unpin = slot.pin(registry)

    restartRpcQuery(registry, slot)
    expect(registry.get(slot.requestAtom)).toBeNull()
    expect(replies).toHaveLength(0)

    registry.set(slot.requestAtom, 'A')
    await waitForCount(() => replies.length, 1)
    replies[0]('initial')
    await waitFor(registry, slot.resultAtom, result => result._tag === 'Success' && result.value === 'A:initial')
    registry.set(slot.refreshAtom, undefined)
    await waitForCount(() => replies.length, 2)

    Atom.batch(() => restartRpcQuery(registry, slot))
    expect(registry.get(slot.requestAtom)).toBe('A')
    expect(registry.get(slot.resultAtom)._tag).toBe('Initial')
    await waitForCount(() => replies.length, 3)
    replies[1]('late refresh')
    expect(registry.get(slot.resultAtom)._tag).toBe('Initial')
    replies[2]('fresh after reset')
    await waitFor(
      registry,
      slot.resultAtom,
      result => result._tag === 'Success' && result.value === 'A:fresh after reset',
    )

    unpin()
    registry.dispose()
  })

  it('keeps the active refresh when an older concurrent refresh resolves first', async () => {
    const registry = AtomRegistry.make()
    const runtimeFactory = Atom.context()
    const replies: Array<(value: string) => void> = []
    const client = makeClient(runtimeFactory, request =>
      Effect.callback<string>(resume => {
        replies.push(value => resume(Effect.succeed(`${request}:${value}`)))
      }),
    )
    const slot = fixtureSlot(client)
    const unpin = slot.pin(registry)
    registry.set(slot.requestAtom, 'A')
    await waitForCount(() => replies.length, 1)
    replies[0]('initial')
    await waitFor(registry, slot.resultAtom, result => result._tag === 'Success' && result.value === 'A:initial')

    registry.set(slot.refreshAtom, undefined)
    await waitForCount(() => replies.length, 2)
    registry.set(slot.refreshAtom, undefined)
    await waitForCount(() => replies.length, 3)
    replies[1]('old')
    expect(registry.get(slot.resultAtom)).toMatchObject({ _tag: 'Success', value: 'A:initial', waiting: true })
    replies[2]('new')
    await waitFor(registry, slot.resultAtom, result => result._tag === 'Success' && result.value === 'A:new')

    unpin()
    registry.dispose()
  })
})
