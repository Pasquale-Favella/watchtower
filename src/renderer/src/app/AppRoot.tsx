import { Outlet } from '@tanstack/react-router'

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
import { useShellStore } from './hooks/use-shell-store'

/** Owns window bootstrap and renders Splash until ledger hydration completes. */
export function AppRoot() {
  useAppBootstrap()
  useAppHotkeys()

  const { hydrated, onboarded } = useShellStore()

  if (!hydrated) {
    return (
      <>
        <div className="fixed inset-x-0 top-0 z-50">
          <ApplicationConnectionNotice />
        </div>
        <Splash />
      </>
    )
  }

  return (
    <>
      <TooltipProvider delay={0}>
        <SidebarProvider className="h-screen">
          <SidebarToggleShortcut />
          <CommandPalette />
          <AppSidebar />
          <SidebarInset className="min-h-0">
            <ApplicationConnectionNotice />
            <ScanIndicator />
            <Outlet />
          </SidebarInset>
        </SidebarProvider>
      </TooltipProvider>
      {!onboarded && <Onboarding />}
    </>
  )
}

function ApplicationConnectionNotice() {
  const { connectionMessage: message } = useShellStore()
  if (!message) return null
  return (
    <p role="status" className="bg-background text-destructive border-b px-4 py-2 text-xs">
      {message}
    </p>
  )
}
