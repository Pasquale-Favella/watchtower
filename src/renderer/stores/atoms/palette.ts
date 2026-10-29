import * as Atom from 'effect/reactivity/Atom'

export const paletteOpenAtom = Atom.keepAlive(Atom.make(false))

export const setPaletteOpenAtom = Atom.writable(
  get => get(paletteOpenAtom),
  (context, open: boolean) => context.set(paletteOpenAtom, open),
)

export const togglePaletteAtom = Atom.writable(
  get => get(paletteOpenAtom),
  context => context.set(paletteOpenAtom, !context.get(paletteOpenAtom)),
)
