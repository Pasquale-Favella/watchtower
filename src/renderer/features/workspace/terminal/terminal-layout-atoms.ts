import * as Atom from 'effect/reactivity/Atom'
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry'

import { TERMINAL_MAX_PER_GROUP, type TerminalId } from '@/shared/schemas/terminal.js'

import {
  addTerminalGroup,
  browserTerminalStorage,
  initialTerminalLayout,
  layoutTerminals,
  nextTerminalId,
  readTerminalDrawerState,
  removeTerminal,
  splitTerminal,
  TERMINAL_DRAWER_DEFAULT_HEIGHT,
  type TerminalDrawerEntry,
  type TerminalDrawerState,
  type TerminalSplitDirection,
  writeTerminalDrawerEntry,
} from './terminal-storage.js'

export const terminalLayoutsAtom = Atom.keepAlive(Atom.make<TerminalDrawerState>({}))
const hydrated = new WeakSet<AtomRegistry.AtomRegistry>()
export function hydrateTerminalLayouts(registry: AtomRegistry.AtomRegistry): void {
  if (hydrated.has(registry)) return
  hydrated.add(registry)
  registry.set(terminalLayoutsAtom, readTerminalDrawerState(browserTerminalStorage()))
}

export function terminalLayoutKey(ownerKey: string, groupId = 'drawer'): string {
  return groupId === 'drawer' ? ownerKey : `${ownerKey}::panel::${groupId}`
}
export function ownerTerminalIds(state: TerminalDrawerState, ownerKey: string): TerminalId[] {
  return Object.entries(state)
    .filter(([key]) => key === ownerKey || key.startsWith(`${ownerKey}::panel::`))
    .flatMap(([, entry]) => [...(entry.terminals ?? [])])
}
const emptyEntry = (): TerminalDrawerEntry => ({
  open: false,
  height: TERMINAL_DRAWER_DEFAULT_HEIGHT,
  terminals: [],
  activeTerminal: null,
  groups: [],
  updatedAt: Date.now(),
})

export type LayoutAction =
  | { readonly kind: 'init' | 'create' }
  | { readonly kind: 'split'; readonly direction: TerminalSplitDirection }
  | { readonly kind: 'select' | 'close'; readonly id: TerminalId }
  | { readonly kind: 'height'; readonly height: number }
  | { readonly kind: 'open'; readonly open: boolean }

export const updateTerminalLayoutAtom = Atom.writable(
  get => get(terminalLayoutsAtom),
  (context, input: { readonly ownerKey: string; readonly groupId?: string; readonly action: LayoutAction }) => {
    const state = context.get(terminalLayoutsAtom)
    const key = terminalLayoutKey(input.ownerKey, input.groupId)
    const previous = state[key]
    if (input.action.kind === 'init' && previous?.terminals && previous.terminals.length > 0) return
    const entry = previous ?? emptyEntry()
    let layout = initialTerminalLayout({ ...entry, terminals: entry.terminals ?? [] })
    const action = input.action
    if (action.kind === 'init' || action.kind === 'create' || action.kind === 'split') {
      const activeGroup = layout.groups.find(group => layout.active !== null && group.terminals.includes(layout.active))
      if (action.kind === 'split' && activeGroup && activeGroup.terminals.length >= TERMINAL_MAX_PER_GROUP) return
      const id = nextTerminalId(ownerTerminalIds(state, input.ownerKey))
      if (!id) return
      layout = action.kind === 'split' ? splitTerminal(layout, id, action.direction) : addTerminalGroup(layout, id)
    } else if (action.kind === 'select') {
      if (layout.active === action.id || !layoutTerminals(layout).includes(action.id)) return
      layout = { ...layout, active: action.id }
    } else if (action.kind === 'close') layout = removeTerminal(layout, action.id)
    const patch = {
      terminals: [...layoutTerminals(layout)],
      groups: layout.groups.map(group => ({ ...group, terminals: [...group.terminals] })),
      activeTerminal: layout.active,
      ...(action.kind === 'height' ? { height: action.height } : {}),
      ...(action.kind === 'open' ? { open: action.open } : {}),
    }
    const next = writeTerminalDrawerEntry(browserTerminalStorage(), key, { ...entry, ...patch })
    context.set(terminalLayoutsAtom, { ...state, [key]: next })
  },
)
