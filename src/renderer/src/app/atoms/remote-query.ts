import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import type * as Scope from 'effect/Scope'

interface Selection<Request, Value, Error> {
  readonly request: Request
  readonly key: string
  readonly resultAtom: Atom.Atom<AsyncResult.AsyncResult<Value, Error>>
  readonly refreshAtom: Atom.Writable<number, number>
}

export interface RemoteQuerySlotOptions<Request, Value, Error, Services, RuntimeError> {
  readonly runtime: Atom.AtomRuntime<Services, RuntimeError>
  readonly fetch: (
    request: Request,
    previous: Option.Option<Value>,
  ) => Effect.Effect<Value, Error, Services | Scope.Scope>
  readonly key: (request: Request) => string
  readonly reactivityKeys?: ReadonlyArray<unknown>
}

export interface RemoteQuerySlot<Request, Value, Error> {
  /** Selecting a request activates the slot. Setting `null` clears it. */
  readonly requestAtom: Atom.Writable<Request | null, Request | null>
  /** An Effect-backed AsyncResult, lazy until selected and first read. */
  readonly resultAtom: Atom.Atom<AsyncResult.AsyncResult<Value, Error>>
  /** Re-runs the selected request while preserving same-identity prior data. */
  readonly refreshAtom: Atom.Writable<AsyncResult.AsyncResult<Value, Error>, void>
  /** Clears the active request and hides any result from its previous identity. */
  readonly resetAtom: Atom.Writable<Request | null, void>
  /** Mounts the single slot so it stays active without component readers. */
  readonly pin: (registry: AtomRegistry.AtomRegistry) => () => void
}

/** Builds one bounded query slot. Each new identity owns a fresh query descriptor. */
export const createRemoteQuerySlot = <Request, Value, Error, Services, RuntimeError>(
  options: RemoteQuerySlotOptions<Request, Value, Error, Services, RuntimeError>,
): RemoteQuerySlot<Request, Value, Error | RuntimeError> => {
  type SlotError = Error | RuntimeError
  type CurrentSelection = Selection<Request, Value, SlotError>
  const selectionAtom = Atom.keepAlive(Atom.make<CurrentSelection | undefined>(undefined))

  const makeSelection = (request: Request, key: string): CurrentSelection => {
    const refreshAtom = Atom.make(0)
    const resultAtom = options.runtime.atom<Value, Error>(get => {
      get(refreshAtom)
      const previous = Option.flatMap(get.self<AsyncResult.AsyncResult<Value, SlotError>>(), AsyncResult.value)
      return options.fetch(request, previous)
    })
    return {
      request,
      key,
      refreshAtom,
      resultAtom:
        options.reactivityKeys === undefined
          ? resultAtom
          : options.runtime.factory.withReactivity(options.reactivityKeys)(resultAtom),
    }
  }

  const requestAtom = Atom.keepAlive(
    Atom.writable(
      get => get(selectionAtom)?.request ?? null,
      (context, request: Request | null) => {
        if (request === null) {
          context.set(selectionAtom, undefined)
          return
        }

        const current = context.get(selectionAtom)
        const key = options.key(request)
        if (current?.key === key) return

        context.set(selectionAtom, makeSelection(request, key))
      },
    ),
  )

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
        context.set(selection.refreshAtom, context.get(selection.refreshAtom) + 1)
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
