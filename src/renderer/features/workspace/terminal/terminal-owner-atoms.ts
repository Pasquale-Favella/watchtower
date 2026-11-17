import * as Atom from 'effect/reactivity/Atom'
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import * as Schema from 'effect/Schema'

import { type DraftTerminalTarget, draftTerminalTargetSchema } from '@/shared/schemas/terminal.js'

import { browserTerminalStorage } from './terminal-storage.js'

const KEY = 'watchtower.workspace.retained-draft-terminals.v1'
const mappingSchema = Schema.Record(Schema.String, draftTerminalTargetSchema)
export const retainedTerminalOwnersAtom = Atom.keepAlive(Atom.make<Readonly<Record<string, DraftTerminalTarget>>>({}))
const hydrated = new WeakSet<AtomRegistry.AtomRegistry>()
export function hydrateRetainedTerminalOwners(registry: AtomRegistry.AtomRegistry): void {
  if (hydrated.has(registry)) return
  hydrated.add(registry)
  try {
    const raw = browserTerminalStorage()?.getItem(KEY)
    if (raw) {
      const decoded = Schema.decodeUnknownOption(mappingSchema)(JSON.parse(raw))
      if (decoded._tag === 'Some') registry.set(retainedTerminalOwnersAtom, decoded.value)
    }
  } catch {
    /* A blocked store starts with no retained owner. */
  }
}
export const retainDraftTerminalOwnerAtom = Atom.writable(
  get => get(retainedTerminalOwnersAtom),
  (context, input: { readonly taskId: string; readonly draft: DraftTerminalTarget }) => {
    const next = { ...context.get(retainedTerminalOwnersAtom), [input.taskId]: input.draft }
    context.set(retainedTerminalOwnersAtom, next)
    try {
      browserTerminalStorage()?.setItem(KEY, JSON.stringify(next))
    } catch {
      /* The owner remains available in this window. */
    }
  },
)
