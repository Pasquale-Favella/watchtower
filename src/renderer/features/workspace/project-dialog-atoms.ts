import * as Atom from 'effect/reactivity/Atom'

export const workspaceProjectDialogOpenAtom = Atom.keepAlive(Atom.make(false))
export const workspaceProjectDialogNoticeAtom = Atom.keepAlive(Atom.make<string | null>(null))
