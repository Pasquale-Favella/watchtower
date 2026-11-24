import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { describe, expect, it } from 'vitest'

import {
  openSettings,
  selectSettingsGroupAtom,
  selectSettingsPaneAtom,
  setSettingsOpenAtom,
  settingsDialogAtom,
} from '../src/renderer/features/settings/dialog-atoms.js'
import { appVerticalAtom, syncAppVerticalFromRouteAtom } from '../src/renderer/stores/atoms/app-vertical.js'

describe('shared settings dialog', () => {
  it('opens independently of the current vertical and retains navigation when reopened', () => {
    const registry = AtomRegistry.make()
    openSettings(registry)
    registry.set(selectSettingsGroupAtom, 'analytics')
    registry.set(selectSettingsPaneAtom, 'pricing')
    registry.set(setSettingsOpenAtom, false)
    openSettings(registry)
    expect(registry.get(settingsDialogAtom)).toEqual({ open: true, group: 'analytics', pane: 'pricing' })
    expect(registry.get(appVerticalAtom)).toBe('workspace')
    registry.dispose()
  })

  it('keeps the selected pane inside its group and isolates window registries', () => {
    const first = AtomRegistry.make()
    const second = AtomRegistry.make()
    first.set(selectSettingsGroupAtom, 'workspace')
    first.set(selectSettingsPaneAtom, 'pricing')
    expect(first.get(settingsDialogAtom).pane).toBe('workspace')
    expect(second.get(settingsDialogAtom)).toEqual({ open: false, group: 'general', pane: 'general' })
    first.dispose()
    second.dispose()
  })

  it('does not change the active vertical while resolving the legacy settings route', () => {
    const registry = AtomRegistry.make()
    registry.set(syncAppVerticalFromRouteAtom, { pathname: '/settings' })
    expect(registry.get(appVerticalAtom)).toBe('workspace')
    registry.dispose()
  })
})
