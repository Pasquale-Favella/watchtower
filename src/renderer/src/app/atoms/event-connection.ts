import * as Atom from 'effect/reactivity/Atom'

export type EventConnection = 'inactive' | 'pending' | 'ready' | 'failed'
export const eventConnectionAtom = Atom.keepAlive(Atom.make<EventConnection>('inactive'))
export const eventRetrySignalAtom = Atom.keepAlive(Atom.make(0))
export const retryRendererEventsAtom = Atom.writable(
  get => get(eventConnectionAtom),
  context => {
    context.set(eventConnectionAtom, 'pending')
    context.set(eventRetrySignalAtom, context.get(eventRetrySignalAtom) + 1)
  },
)
