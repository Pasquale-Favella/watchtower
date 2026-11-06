import { useCallback, useState } from 'react'

import { useWorkspacePreviewCommands } from './browser-preview/use-workspace-preview.js'
import { type RightPanelSurface, surfaceKind, surfaceResource } from './right-panel/right-panel-state.js'
import type { RightPanelControls } from './right-panel/use-right-panel.js'

export function useWorkspacePanelResources(ownerKey: string, panel: RightPanelControls) {
  const browser = useWorkspacePreviewCommands()
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
  const closeBrowser = async (surface: RightPanelSurface): Promise<void> => {
    if (surfaceKind(surface) === 'browser') await browser.close(ownerKey, surfaceResource(surface))
  }
  return { urls, titles, openBrowser, setTitle, closeBrowser }
}
