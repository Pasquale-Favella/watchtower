import { Outlet } from '@tanstack/react-router'

import { TooltipProvider } from '@/shared/components/ui/tooltip'
import { SidebarInset, SidebarProvider } from '@/shared/components/ui/sidebar'
import { useAppBootstrap } from './hooks/use-app-bootstrap'
import { useThemeEffect } from './hooks/use-theme-effect'
import { useAppHotkeys } from './hooks/use-app-hotkeys'
import { Splash } from './components/Splash'
import { Onboarding } from './components/Onboarding'
import { AppSidebar } from './components/app-sidebar'
import { ScanIndicator } from './components/ScanIndicator'
import { SidebarToggleShortcut } from './components/SidebarToggleShortcut'
import { useScanStore } from './stores/scan-store'
import { useSettingsStore } from '@/features/settings/store'

/** The root route component — the app frame (ADR 0014). Runs the bootstrap,
 * theme, and hotkey hooks; shows the Splash until the store hydrates; then
 * renders the persistent shell chrome (tooltip/sidebar providers, the
 * sidebar, the scan bar) around the router's `Outlet` — the dashboard strip
 * and settings — plus the onboarding tour. Every piece of data reads from a
 * store. */
export function AppRoot() {
  useAppBootstrap()
  useThemeEffect()
  useAppHotkeys()

  const hydrated = useScanStore(s => s.hydrated)
  const onboarded = useSettingsStore(s => s.onboarded)

  if (!hydrated) {
    return <Splash />
  }

  return (
    <>
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
      {!onboarded && <Onboarding />}
    </>
  )
}
