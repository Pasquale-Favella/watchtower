import { RegistryContext, useAtomSet, useAtomValue } from '@effect/atom-react'
import * as Option from 'effect/Option'
import * as Predicate from 'effect/Predicate'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import type * as Atom from 'effect/reactivity/Atom'
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { RpcClientError } from 'effect/rpc/RpcClientError'
import { useContext, useEffect } from 'react'

import type { RpcQuerySlot } from '../atoms/rpc-query.js'

const windowPins = new WeakMap<AtomRegistry.AtomRegistry, Map<object, () => void>>()

function pinWindowResource(registry: AtomRegistry.AtomRegistry, key: object, acquire: () => () => void): void {
  let pins = windowPins.get(registry)
  if (!pins) {
    pins = new Map()
    windowPins.set(registry, pins)
  }
  if (!pins.has(key)) pins.set(key, acquire())
}

/** Owns an activated workflow until the renderer root disposes its window. */
export function pinWindowAtom<A>(registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<A>): void {
  pinWindowResource(registry, atom, () => registry.mount(atom))
}

export function releaseWindowQueries(registry: AtomRegistry.AtomRegistry): void {
  const pins = windowPins.get(registry)
  if (!pins) return
  windowPins.delete(registry)
  for (const release of pins.values()) release()
}

export interface QuerySnapshot<Value> {
  readonly data: Value | null
  readonly error: string | null
  readonly status: 'loading' | 'ready'
}

export function querySnapshot<Value, Error>(result: AsyncResult.AsyncResult<Value, Error>): QuerySnapshot<Value> {
  let message: string | null = null
  if (result._tag === 'Failure') {
    const error = AsyncResult.error(result)
    if (Option.isSome(error) && error.value instanceof RpcClientError)
      message = 'Application connection unavailable. Reconnecting.'
    else
      message =
        Option.isSome(error) && Predicate.isError(error.value) ? error.value.message : 'Unable to load data. Try again.'
  }
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: message,
    status: result._tag === 'Initial' ? 'loading' : 'ready',
  }
}

/** Pins a feature's current slot until its window closes, without retaining old request identities. */
export function useRemoteQuery<Request, Value, Error>(
  slot: RpcQuerySlot<Request, Value, Error>,
  request: Request | null,
  key: (request: Request) => string,
): QuerySnapshot<Value> {
  const registry = useContext(RegistryContext)
  const selected = useAtomValue(slot.requestAtom)
  const result = useAtomValue(slot.resultAtom)
  const select = useAtomSet(slot.requestAtom)
  useEffect(() => {
    pinWindowResource(registry, slot, () => slot.pin(registry))
    select(request)
  }, [registry, request, select, slot])
  if (request === null || selected === null || key(selected) !== key(request))
    return querySnapshot(AsyncResult.initial())
  return querySnapshot(result)
}
