import { describe, expect, it, vi } from 'vitest'

import { closePanelSurfaces } from '../src/renderer/features/workspace/right-panel/close-panel-surfaces.js'
import {
  closeAllSurfaces,
  closeOtherSurfaces,
  closeSurface,
  closeSurfacesToRight,
  DEFAULT_RIGHT_PANEL_PREFERENCE,
  moveSurface,
  moveSurfaceTo,
  openSurface,
  readRightPanelPreferences,
  reconcileWorkspacePreviewTabs,
  resourceSurface,
  type RightPanelPreference,
  surfaceKind,
  surfaceLabel,
  surfaceResource,
  toggleSurface,
  transferRightPanelPreference,
  writeRightPanelPreferences,
} from '../src/renderer/features/workspace/right-panel/right-panel-state.js'
import type { WorkspacePreviewState } from '../src/shared/schemas/workspace-preview.js'

function storage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => {
      values.delete(key)
    },
    setItem: (key, value) => {
      values.set(key, value)
    },
  }
}

function opened(): RightPanelPreference {
  return {
    open: true,
    maximized: false,
    surfaces: ['diff', 'files', 'browser:first', 'terminal:group'],
    active: 'browser:first',
  }
}

function previewState(tabId: string, closed = false): WorkspacePreviewState {
  return {
    ownerKey: 'task-1',
    tabId,
    url: '',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    error: null,
    visible: false,
    closed,
    muted: false,
    zoomFactor: 1,
    popupUrl: null,
    popupSequence: 0,
    shortcut: null,
    shortcutSequence: 0,
  }
}

describe('panel resource tabs', () => {
  it('keeps persisted browser tabs until a native snapshot owns or closes them', () => {
    expect(reconcileWorkspacePreviewTabs(['browser:remembered'], [], new Set())).toMatchObject({
      openTabIds: [],
      closeSurfaces: [],
      currentOpenTabIds: new Set(),
    })

    expect(
      reconcileWorkspacePreviewTabs(
        ['browser:remembered', 'browser:managed'],
        [previewState('agent-tab')],
        new Set(['managed']),
      ),
    ).toMatchObject({
      openTabIds: ['agent-tab'],
      closeSurfaces: ['browser:managed'],
      currentOpenTabIds: new Set(['agent-tab']),
    })
  })

  it('removes a tab explicitly marked closed in a native snapshot', () => {
    expect(reconcileWorkspacePreviewTabs(['browser:closed'], [previewState('closed', true)], new Set())).toMatchObject({
      openTabIds: [],
      closeSurfaces: ['browser:closed'],
      currentOpenTabIds: new Set(),
    })
  })

  it('round-trips resource names without confusing file paths with tab identities', () => {
    const file = resourceSurface('file', 'src/folder with spaces/über:name.ts')
    expect(surfaceKind(file)).toBe('file')
    expect(surfaceResource(file)).toBe('src/folder with spaces/über:name.ts')
    expect(surfaceLabel(file)).toBe('über:name.ts')
    expect(surfaceResource('files')).toBe('')
  })

  it('focuses a singleton or existing resource without duplicating its tab', () => {
    const value = openSurface(opened(), 'files')
    expect(value.surfaces).toHaveLength(4)
    expect(value.active).toBe('files')
    const second = openSurface(value, 'browser:second')
    expect(second.surfaces.at(-1)).toBe('browser:second')
    expect(second.active).toBe('browser:second')
    expect(toggleSurface(second, 'browser:second').open).toBe(false)
    expect(toggleSurface({ ...second, open: false }, 'browser:second').open).toBe(true)
  })

  it('selects the next neighbor on close and preserves the active tab when closing another', () => {
    expect(closeSurface(opened(), 'browser:first').active).toBe('terminal:group')
    expect(closeSurface(opened(), 'files').active).toBe('browser:first')
    expect(closeSurface({ ...opened(), active: 'terminal:group' }, 'terminal:group').active).toBe('browser:first')
    expect(closeSurface({ ...opened(), surfaces: ['diff'], active: 'diff', maximized: true }, 'diff')).toEqual({
      open: false,
      surfaces: [],
      active: null,
      maximized: false,
    })
  })

  it('closes other tabs or tabs to the right without leaving a missing active tab', () => {
    expect(closeOtherSurfaces(opened(), 'files')).toMatchObject({ surfaces: ['files'], active: 'files' })
    expect(closeSurfacesToRight(opened(), 'files')).toMatchObject({ surfaces: ['diff', 'files'], active: 'files' })
    expect(closeAllSurfaces(opened())).toEqual({ open: false, maximized: false, surfaces: [], active: null })
  })

  it('reorders to a drop index while preserving activation and ignores absent or out-of-range targets', () => {
    expect(moveSurfaceTo(opened(), 'terminal:group', 1)).toMatchObject({
      surfaces: ['diff', 'terminal:group', 'files', 'browser:first'],
      active: 'browser:first',
    })
    expect(moveSurface(opened(), 'diff', -1)).toEqual(opened())
    expect(moveSurfaceTo(opened(), 'browser:missing', 0)).toEqual(opened())
    expect(moveSurfaceTo(opened(), 'diff', 40)).toEqual(opened())
  })
})

describe('panel restoration', () => {
  it('reads older tab preferences and normalizes duplicate tabs and missing selection', () => {
    const saved = storage()
    saved.setItem('watchtower.workspace.right-panel.v1', JSON.stringify({ task: { open: true, tab: 'files' } }))
    expect(readRightPanelPreferences(saved).task).toEqual({
      open: true,
      surfaces: ['files'],
      active: 'files',
      maximized: false,
    })
    writeRightPanelPreferences(saved, {
      task: { ...opened(), surfaces: ['diff', 'diff', 'browser:first'], active: 'files' },
    })
    expect(readRightPanelPreferences(saved).task).toMatchObject({ surfaces: ['diff', 'browser:first'], active: 'diff' })
  })

  it('ignores malformed resource IDs and storage failures', () => {
    const saved = storage()
    saved.setItem(
      'watchtower.workspace.right-panel.v2',
      JSON.stringify({ task: { ...opened(), surfaces: ['file:%zz'] } }),
    )
    expect(readRightPanelPreferences(saved)).toEqual({})
    saved.setItem('watchtower.workspace.right-panel.v2', 'invalid json')
    expect(readRightPanelPreferences(saved)).toEqual({})
    expect(readRightPanelPreferences(null)).toEqual({})
    expect(() => writeRightPanelPreferences(null, { task: opened() })).not.toThrow()
  })

  it('transfers the captured draft to a Task once and preserves later Task choices on retry', () => {
    const saved = storage()
    writeRightPanelPreferences(saved, { 'draft:one': opened(), other: DEFAULT_RIGHT_PANEL_PREFERENCE })
    transferRightPanelPreference(saved, 'draft:one', 'task:one')
    expect(readRightPanelPreferences(saved)['task:one']).toEqual(opened())
    const next = { ...opened(), active: 'files' as const }
    writeRightPanelPreferences(saved, { ...readRightPanelPreferences(saved), 'task:one': next })
    transferRightPanelPreference(saved, 'draft:one', 'task:one')
    expect(readRightPanelPreferences(saved)['task:one']).toEqual(next)
    expect(readRightPanelPreferences(saved).other).toEqual(DEFAULT_RIGHT_PANEL_PREFERENCE)
  })

  it('bounds retained layouts while keeping the latest keys', () => {
    const saved = storage()
    writeRightPanelPreferences(
      saved,
      Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`task-${index}`, opened()])),
    )
    const restored = readRightPanelPreferences(saved)
    expect(Object.keys(restored)).toHaveLength(100)
    expect(restored['task-0']).toBeUndefined()
    expect(restored['task-119']).toEqual(opened())
  })
})

describe('closing resource tabs', () => {
  it('changes nothing when a later confirmation is cancelled', async () => {
    const release = vi.fn()
    const remove = vi.fn()
    const confirmed = await closePanelSurfaces(['browser:first', 'terminal:group'], {
      confirm: surface => surface !== 'terminal:group',
      release,
      remove,
    })
    expect(confirmed).toBe(false)
    expect(release).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })

  it('collects all confirmations before releasing and removing tabs', async () => {
    const events: string[] = []
    const result = await closePanelSurfaces(['browser:first', 'terminal:group'], {
      confirm: surface => {
        events.push(`confirm:${surface}`)
        return true
      },
      release: surface => {
        events.push(`release:${surface}`)
      },
      remove: surface => {
        events.push(`remove:${surface}`)
      },
    })
    expect(result).toBe(true)
    expect(events).toEqual([
      'confirm:browser:first',
      'confirm:terminal:group',
      'release:browser:first',
      'remove:browser:first',
      'release:terminal:group',
      'remove:terminal:group',
    ])
  })

  it('does not remove a tab whose native cleanup failed', async () => {
    const remove = vi.fn()
    await expect(
      closePanelSurfaces(['browser:first'], { release: () => Promise.reject(new Error('unavailable')), remove }),
    ).rejects.toThrow('unavailable')
    expect(remove).not.toHaveBeenCalled()
  })
})
