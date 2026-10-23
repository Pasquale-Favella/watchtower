import { useAtomValue } from '@effect/atom-react'
import { Outlet } from '@tanstack/react-router'

import { scanStateAtom } from '@/app/atoms/scan'
import { preferencesAtom } from '@/features/settings/preferences-atoms'
import { SidebarInset, SidebarProvider } from '@/shared/components/ui/sidebar'
import { TooltipProvider } from '@/shared/components/ui/tooltip'

import { AppSidebar } from './components/app-sidebar'
import { CommandPalette } from './components/CommandPalette'
import { Onboarding } from './components/Onboarding'
import { ScanIndicator } from './components/ScanIndicator'
import { SidebarToggleShortcut } from './components/SidebarToggleShortcut'
import { Splash } from './components/splash/Splash'
import { useAppBootstrap } from './hooks/use-app-bootstrap'
import { useAppHotkeys } from './hooks/use-app-hotkeys'

/** The root route component — the app frame (ADR 0014). Runs the bootstrap,
 * theme, and hotkey hooks; shows the Splash until the store hydrates; then
 * renders the persistent shell chrome (tooltip/sidebar providers, the
 * sidebar, the scan bar) around the router's `Outlet` — the dashboard strip
 * and settings — plus the onboarding tour. Every piece of data reads from a
 * store. */
export function AppRoot() {
  useAppBootstrap()
  useAppHotkeys()

  const hydrated = useAtomValue(scanStateAtom).hydrated
  const onboarded = useAtomValue(preferencesAtom).onboarded

  if (!hydrated) {
    return <Splash />
  }

  return (
    <>
      <TooltipProvider delay={0}>
        <SidebarProvider className="h-screen">
          <SidebarToggleShortcut />
          <CommandPalette />
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
