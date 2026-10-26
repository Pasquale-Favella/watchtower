import * as Atom from 'effect/reactivity/Atom'

export interface QuerySelection<Request> {
  readonly request: Request
  readonly key: string
}

export interface QuerySelectionState<Request, Selection extends QuerySelection<Request>> {
  readonly selectionAtom: Atom.Writable<Selection | undefined, Selection | undefined>
  readonly requestAtom: Atom.Writable<Request | null, Request | null>
}

/** Shared one-current-selection identity state for bridge and AtomRpc query slots. */
export function createQuerySelectionState<Request, Selection extends QuerySelection<Request>>(
  keyOf: (request: Request) => string,
  makeSelection: (request: Request, key: string) => Selection,
): QuerySelectionState<Request, Selection> {
  const selectionAtom = Atom.keepAlive(Atom.make<Selection | undefined>(undefined))
  const requestAtom = Atom.keepAlive(
    Atom.writable(
      get => get(selectionAtom)?.request ?? null,
      (context, request: Request | null) => {
        if (request === null) {
          context.set(selectionAtom, undefined)
          return
        }
        const key = keyOf(request)
        if (context.get(selectionAtom)?.key === key) return
        context.set(selectionAtom, makeSelection(request, key))
      },
    ),
  )
  return { selectionAtom, requestAtom }
}
