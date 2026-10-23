import * as Atom from 'effect/reactivity/Atom'

/** Advances after this window has invalidated queries for an authoritative config event. */
export const configInvalidationRevisionAtom = Atom.keepAlive(Atom.make(0))
