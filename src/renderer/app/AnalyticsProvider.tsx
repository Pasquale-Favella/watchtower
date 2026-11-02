import { Outlet } from '@tanstack/react-router'

import { CommandPalette } from '@/renderer/components/shell/CommandPalette'
import { ScanIndicator } from '@/renderer/components/shell/ScanIndicator'
import { useAppHotkeys } from '@/renderer/stores/hooks/use-app-hotkeys'

/** Analytics-only window shortcuts and scan status. Workspace sits outside this route. */
export function AnalyticsProvider() {
  useAppHotkeys()

  return (
    <>
      <CommandPalette />
      <ScanIndicator />
      <Outlet />
    </>
  )
}
