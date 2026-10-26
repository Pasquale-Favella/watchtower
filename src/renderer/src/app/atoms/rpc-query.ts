import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry'

import { createQuerySelectionState } from './query-slot.js'

interface Selection<Request, Value, Error> {
  readonly request: Request
  readonly key: string
  readonly resultAtom: Atom.Atom<AsyncResult.AsyncResult<Value, Error>>
  readonly refreshSignal: Atom.Writable<number, number>
}

export interface RpcQuerySlotOptions<Request, Value, Error> {
  readonly key: (request: Request) => string
  /** Must return an AtomRpc.query atom, preserving the RPC boundary's typed result. */
  readonly query: (request: Request, selectionId: string) => Atom.Atom<AsyncResult.AsyncResult<Value, Error>>
}

export interface RpcQuerySlot<Request, Value, Error> {
  readonly requestAtom: Atom.Writable<Request | null, Request | null>
  readonly resultAtom: Atom.Atom<AsyncResult.AsyncResult<Value, Error>>
  readonly refreshAtom: Atom.Writable<AsyncResult.AsyncResult<Value, Error>, void>
  readonly resetAtom: Atom.Writable<Request | null, void>
  readonly pin: (registry: AtomRegistry.AtomRegistry) => () => void
}

/** Clears the current result, then reselects its request as a fresh query member. */
export function restartRpcQuery<Request, Value, Error>(
  registry: AtomRegistry.AtomRegistry,
  query: RpcQuerySlot<Request, Value, Error>,
): void {
  const request = registry.get(query.requestAtom)
  registry.set(query.resetAtom, undefined)
  if (request !== null) registry.set(query.requestAtom, request)
}

let nextSelectionId = 0

/** A bounded, single-selection slot backed by native AtomRpc query atoms. */
export function createRpcQuerySlot<Request, Value, Error>(
  options: RpcQuerySlotOptions<Request, Value, Error>,
): RpcQuerySlot<Request, Value, Error> {
  const makeSelection = (request: Request, key: string): Selection<Request, Value, Error> => {
    const refreshSignal = Atom.make(0)
    const selectionId = `selection-${++nextSelectionId}`
    const sourceAtom = options.query(request, selectionId)
    return {
      request,
      key,
      refreshSignal,
      resultAtom: Atom.makeRefreshOnSignal(refreshSignal)(sourceAtom),
    }
  }
  const { selectionAtom, requestAtom } = createQuerySelectionState(options.key, makeSelection)

  const resultAtom = Atom.keepAlive(
    Atom.readable(get => {
      const selection = get(selectionAtom)
      return selection === undefined ? AsyncResult.initial() : get(selection.resultAtom)
    }),
  )

  const refreshAtom = Atom.writable(
    get => get(resultAtom),
    context => {
      const selection = context.get(selectionAtom)
      if (selection !== undefined) {
        context.set(selection.refreshSignal, context.get(selection.refreshSignal) + 1)
      }
    },
  )

  const resetAtom = Atom.writable(
    get => get(requestAtom),
    context => context.set(selectionAtom, undefined),
  )

  return {
    requestAtom,
    resultAtom,
    refreshAtom,
    resetAtom,
    pin: registry => {
      const unmount = registry.mount(resultAtom)
      let pinned = true
      return () => {
        if (!pinned) return
        pinned = false
        unmount()
      }
    },
  }
}
