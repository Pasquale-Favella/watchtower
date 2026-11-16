import * as Atom from 'effect/reactivity/Atom'
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry'

import { SETTINGS_PANES, type SettingsGroup, type SettingsPane } from './dialog-navigation.js'

interface SettingsDialogState {
  readonly open: boolean
  readonly group: SettingsGroup
  readonly pane: SettingsPane
}

export const settingsDialogAtom = Atom.keepAlive(
  Atom.make<SettingsDialogState>({ open: false, group: 'general', pane: 'general' }),
)

export const setSettingsOpenAtom = Atom.writable(
  get => get(settingsDialogAtom).open,
  (context, open: boolean) => context.set(settingsDialogAtom, { ...context.get(settingsDialogAtom), open }),
)

export const selectSettingsGroupAtom = Atom.writable(
  get => get(settingsDialogAtom).group,
  (context, group: SettingsGroup) => {
    const current = context.get(settingsDialogAtom)
    if (current.group === group) return
    context.set(settingsDialogAtom, { ...current, group, pane: SETTINGS_PANES[group][0].id })
  },
)

export const selectSettingsPaneAtom = Atom.writable(
  get => get(settingsDialogAtom).pane,
  (context, pane: SettingsPane) => {
    const current = context.get(settingsDialogAtom)
    if (SETTINGS_PANES[current.group].some(item => item.id === pane)) {
      context.set(settingsDialogAtom, { ...current, pane })
    }
  },
)

export function openSettings(registry: AtomRegistry.AtomRegistry): void {
  registry.set(setSettingsOpenAtom, true)
}
