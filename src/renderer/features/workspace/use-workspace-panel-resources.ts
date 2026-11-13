import { RegistryContext } from '@effect/atom-react'
import { useCallback, useContext, useEffect, useRef, useState } from 'react'

import type { TaskId } from '@/shared/schemas/workspace.js'

import {
  bindWorkspacePreviewAtom,
  subscribeWorkspacePreviewTabs,
  workspacePreviewTabsSessionAtom,
} from './browser-preview/preview-atoms.js'
import { useWorkspacePreviewCommands } from './browser-preview/use-workspace-preview.js'
import {
  reconcileWorkspacePreviewTabs,
  type RightPanelSurface,
  surfaceKind,
  surfaceResource,
} from './right-panel/right-panel-state.js'
import type { RightPanelControls } from './right-panel/use-right-panel.js'
import { useWorkspaceOperation } from './use-workspace-operation.js'

export function useWorkspacePanelResources(ownerKey: string, panel: RightPanelControls, taskId?: TaskId) {
  const registry = useContext(RegistryContext)
  const browser = useWorkspacePreviewCommands()
  const bind = useWorkspaceOperation(bindWorkspacePreviewAtom)
  const panelRef = useRef(panel)
  const nativeTabIds = useRef({ ownerKey, ids: new Set<string>() })
  useEffect(() => {
    panelRef.current = panel
  })
  const addSurface = panel.addSurface
  const [urls, setUrls] = useState<Readonly<Record<string, string>>>({})
  const [titles, setTitles] = useState<Readonly<Record<string, string>>>({})
  const openBrowser = useCallback(
    (url?: string) => {
      const surface = addSurface('browser')
      if (url) setUrls(current => ({ ...current, [surface]: url }))
      return surface
    },
    [addSurface],
  )
  const setTitle = useCallback((surface: RightPanelSurface, title: string) => {
    setTitles(current => (current[surface] === title ? current : { ...current, [surface]: title }))
  }, [])
  const bindTask = useCallback((nextTaskId: TaskId) => bind({ ownerKey, taskId: nextTaskId }), [bind, ownerKey])
  useEffect(() => {
    if (!taskId) return
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | undefined
    const attempt = async () => {
      try {
        await bindTask(taskId)
      } catch {
        if (!cancelled) retry = setTimeout(() => void attempt(), 1000)
      }
    }
    void attempt()
    return () => {
      cancelled = true
      if (retry) clearTimeout(retry)
    }
  }, [bindTask, taskId])
  useEffect(() => {
    if (nativeTabIds.current.ownerKey !== ownerKey) nativeTabIds.current = { ownerKey, ids: new Set() }
    const unsubscribe = subscribeWorkspacePreviewTabs(ownerKey, states => {
      const update = reconcileWorkspacePreviewTabs(panelRef.current.surfaces, states, nativeTabIds.current.ids)
      for (const tabId of update.openTabIds) panelRef.current.addSurface('browser', tabId)
      for (const surface of update.closeSurfaces) panelRef.current.closeSurface(surface)
      nativeTabIds.current.ids = new Set(update.currentOpenTabIds)
    })
    const unmount = registry.mount(workspacePreviewTabsSessionAtom(ownerKey))
    return () => {
      unmount()
      unsubscribe()
    }
  }, [ownerKey, registry])
  const closeBrowser = async (surface: RightPanelSurface): Promise<void> => {
    if (surfaceKind(surface) === 'browser') await browser.close(ownerKey, surfaceResource(surface))
  }
  return { urls, titles, openBrowser, setTitle, closeBrowser, bindTask }
}
