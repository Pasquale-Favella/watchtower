import * as Atom from 'effect/reactivity/Atom'

/** Advances after this window has invalidated queries for an authoritative config event. */
export const configInvalidationRevisionAtom = Atom.keepAlive(Atom.make(0))

/** Highest ledger generation whose reset invalidation this window has applied. */
export const appliedLedgerGenerationAtom = Atom.keepAlive(Atom.make(0))
