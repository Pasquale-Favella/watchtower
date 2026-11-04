import { useCallback, useEffect, useState } from 'react'

import { isMac } from '@/renderer/features/workspace/platform-labels.js'

import { isTerminalFocusTarget } from '../terminal/terminal-keys.js'
import {
  browserStorage,
  closeAllSurfaces,
  closeOtherSurfaces,
  closeSurface,
  closeSurfacesToRight,
  DEFAULT_RIGHT_PANEL_PREFERENCE,
  moveSurface,
  moveSurfaceTo,
  openSurface,
  readRightPanelPreferences,
  resourceSurface,
  type RightPanelPreference,
  type RightPanelSurface,
  toggleSurface,
  writeRightPanelPreferences,
} from './right-panel-state.js'

export interface RightPanelControls {
  readonly open: boolean
  readonly surfaces: ReadonlyArray<RightPanelSurface>
  readonly active: RightPanelSurface | null
  readonly maximized: boolean
  readonly toggle: () => void
  readonly setOpen: (open: boolean) => void
  readonly openSurface: (surface: RightPanelSurface) => void
  readonly addSurface: (
    kind: 'browser' | 'terminal' | 'device' | 'pull-request' | 'side-chat',
    resourceId?: string,
  ) => RightPanelSurface
  readonly openFile: (path: string) => RightPanelSurface
  readonly activate: (surface: RightPanelSurface) => void
  readonly closeSurface: (surface: RightPanelSurface) => void
  readonly closeOthers: (surface: RightPanelSurface) => void
  readonly closeToRight: (surface: RightPanelSurface) => void
  readonly closeAll: () => void
  readonly move: (surface: RightPanelSurface, offset: -1 | 1) => void
  readonly moveTo: (surface: RightPanelSurface, index: number) => void
  readonly transferTo: (taskKey: string) => void
  readonly toggleMaximized: () => void
  /** Bumped by Mod+T so the panel opens its add-surface menu. */
  readonly addMenuRequest: number
}

/** True for Mod+key with no other modifier. Windows reports AltGr as Ctrl+Alt, so Alt excludes it. */
function isModKey(event: KeyboardEvent, code: string): boolean {
  const modifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  return modifier && !event.altKey && !event.shiftKey && event.code === code
}

/**
 * Open state, tabs and maximize for the changes panel, remembered per Task key. Shortcuts for the
 * current Task: Mod+Alt+B toggles the panel, Mod+D toggles the diff, Mod+T opens the add-surface menu.
 * Mod+D and Mod+T yield to a focused terminal. A null key, such as before the first Task exists, has
 * no remembered state.
 */
export function useRightPanel(taskKey: string | null): RightPanelControls {
  const [preferences, setPreferences] = useState(() => readRightPanelPreferences(browserStorage()))
  const [addMenuRequest, setAddMenuRequest] = useState(0)
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
  const setOpen = useCallback(
    (open: boolean) => change(previous => ({ ...previous, open, maximized: open && previous.maximized })),
    [change],
  )
  const toggle = useCallback(
    () => change(previous => ({ ...previous, open: !previous.open, maximized: !previous.open && previous.maximized })),
    [change],
  )
  const controls = {
    openSurface: useCallback((surface: RightPanelSurface) => change(p => openSurface(p, surface)), [change]),
    addSurface: useCallback(
      (
        kind: 'browser' | 'terminal' | 'device' | 'pull-request' | 'side-chat',
        resourceId: string = crypto.randomUUID(),
      ) => {
        const surface = resourceSurface(kind, resourceId)
        change(p => openSurface(p, surface))
        return surface
      },
      [change],
    ),
    openFile: useCallback(
      (path: string) => {
        const surface = resourceSurface('file', path)
        change(p => openSurface(p, surface))
        return surface
      },
      [change],
    ),
    activate: useCallback((surface: RightPanelSurface) => change(p => openSurface(p, surface)), [change]),
    closeSurface: useCallback((surface: RightPanelSurface) => change(p => closeSurface(p, surface)), [change]),
    closeOthers: useCallback((surface: RightPanelSurface) => change(p => closeOtherSurfaces(p, surface)), [change]),
    closeToRight: useCallback((surface: RightPanelSurface) => change(p => closeSurfacesToRight(p, surface)), [change]),
    closeAll: useCallback(() => change(closeAllSurfaces), [change]),
    move: useCallback(
      (surface: RightPanelSurface, offset: -1 | 1) => change(p => moveSurface(p, surface, offset)),
      [change],
    ),
    moveTo: useCallback(
      (surface: RightPanelSurface, index: number) => change(p => moveSurfaceTo(p, surface, index)),
      [change],
    ),
    transferTo: useCallback(
      (taskKey: string) => {
        if (!key || taskKey === key) return
        const latest = readRightPanelPreferences(browserStorage())
        if (latest[taskKey]) return
        writeRightPanelPreferences(browserStorage(), { ...latest, [taskKey]: current })
      },
      [current, key],
    ),
    toggleMaximized: useCallback(() => change(p => ({ ...p, open: true, maximized: !p.maximized })), [change]),
  }

  const open = current.open
  useEffect(() => {
    if (!key) return
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.altKey && !event.shiftKey && event.code === 'KeyB') {
        // Windows reports AltGr as Ctrl+Alt; typing an AltGr character must not toggle the panel.
        if (event.getModifierState('AltGraph')) return
        event.preventDefault()
        toggle()
        return
      }
      if (event.repeat || isTerminalFocusTarget(event.target)) return
      if (isModKey(event, 'KeyD')) {
        event.preventDefault()
        change(p => toggleSurface(p, 'diff'))
      } else if (open && isModKey(event, 'KeyT')) {
        event.preventDefault()
        setAddMenuRequest(value => value + 1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [change, key, open, toggle])

  return {
    open,
    surfaces: current.surfaces,
    active: current.active,
    maximized: current.open && current.maximized,
    toggle,
    setOpen,
    ...controls,
    addMenuRequest,
  }
}
