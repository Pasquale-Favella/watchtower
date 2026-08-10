import { useHotkey } from '@tanstack/react-hotkeys'
import { Outlet } from '@tanstack/react-router'

import { TooltipProvider } from '@/shared/components/ui/tooltip'
import { SidebarInset, SidebarProvider, useSidebar } from '@/shared/components/ui/sidebar'
import { shortcutForAction } from '@/app/shortcuts'
import { useScanStore } from '@/app/stores/scan-store'
import { AppSidebar } from '@/app/components/app-sidebar'

/** The ⌘B / Ctrl+B sidebar toggle from the shortcuts registry (ADR 0001).
 * Lives inside SidebarProvider so it can reach the sidebar context. */
export function SidebarToggleShortcut() {
  const { toggleSidebar } = useSidebar()
  // The registry is the app's own static table, so 'toggleSidebar' is always present.
  const def = shortcutForAction('toggleSidebar')!
  useHotkey(def.hotkey, () => toggleSidebar(), { meta: { name: def.label, description: def.action } })
  return null
}

/** The 2px scanning bar — reads `scanning` straight from the scan store
 * (ADR 0011). */
export function ScanIndicator() {
  const scanning = useScanStore(s => s.scanning)
  return (
    <div
      className={`h-[2px] shrink-0 transition-colors ${scanning ? 'animate-pulse bg-primary' : 'bg-transparent'}`}
      role="status"
      aria-label={scanning ? 'Refreshing data in the background' : undefined}
    />
  )
}

/** The shell layout route (ADR 0014): the outer sidebar persists on every
 * route — the dashboard layout (sections) and settings both render as its
 * `Outlet`. */
export function ShellLayout() {
  return (
    <TooltipProvider delay={0}>
      <SidebarProvider className="h-screen">
        <SidebarToggleShortcut />
        <AppSidebar />
        <SidebarInset className="min-h-0">
          <ScanIndicator />
          <Outlet />
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
