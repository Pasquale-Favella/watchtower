import { useCallback, useEffect, useState } from 'react'

import {
  browserStorage,
  DEFAULT_RIGHT_PANEL_PREFERENCE,
  readRightPanelPreferences,
  type RightPanelPreference,
  type RightPanelTab,
  writeRightPanelPreferences,
} from './right-panel-state.js'

export interface RightPanelControls {
  readonly open: boolean
  readonly tab: RightPanelTab
  readonly toggle: () => void
  readonly setOpen: (open: boolean) => void
  readonly setTab: (tab: RightPanelTab) => void
}

/**
 * Open state and tab for the changes panel, remembered per Task key. Mod+Alt+B toggles the panel for
 * the current Task. A null key, such as before the first Task exists, has no remembered state.
 */
export function useRightPanel(taskKey: string | null): RightPanelControls {
  const [preferences, setPreferences] = useState(() => readRightPanelPreferences(browserStorage()))
  const key = taskKey ?? ''
  const current = (key === '' ? undefined : preferences[key]) ?? DEFAULT_RIGHT_PANEL_PREFERENCE

  useEffect(() => {
    writeRightPanelPreferences(browserStorage(), preferences)
  }, [preferences])

  const change = useCallback(
    (update: (previous: RightPanelPreference) => RightPanelPreference) => {
      if (key === '') return
      setPreferences(previous => ({ ...previous, [key]: update(previous[key] ?? DEFAULT_RIGHT_PANEL_PREFERENCE) }))
    },
    [key],
  )
  const setOpen = useCallback((open: boolean) => change(previous => ({ ...previous, open })), [change])
  const setTab = useCallback((tab: RightPanelTab) => change(previous => ({ ...previous, tab })), [change])
  const toggle = useCallback(() => change(previous => ({ ...previous, open: !previous.open })), [change])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.altKey || event.shiftKey || event.code !== 'KeyB') return
      // Windows reports AltGr as Ctrl+Alt; typing an AltGr character must not toggle the panel.
      if (event.getModifierState('AltGraph')) return
      event.preventDefault()
      toggle()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggle])

  return { open: current.open, tab: current.tab, toggle, setOpen, setTab }
}
