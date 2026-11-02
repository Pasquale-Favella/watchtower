import { Outlet } from '@tanstack/react-router'

import { AppSidebar } from '@/renderer/components/shell/app-sidebar'
import { Onboarding } from '@/renderer/components/shell/Onboarding'
import { SidebarToggleShortcut } from '@/renderer/components/shell/SidebarToggleShortcut'
import { Splash } from '@/renderer/components/shell/splash/Splash'
import { SidebarInset, SidebarProvider } from '@/renderer/components/ui/sidebar'
import { TooltipProvider } from '@/renderer/components/ui/tooltip'
import { useAppBootstrap } from '@/renderer/stores/hooks/use-app-bootstrap'
import { useSyncAppVerticalFromRoute } from '@/renderer/stores/hooks/use-app-vertical-store'
import { useShellStore } from '@/renderer/stores/hooks/use-shell-store'

/** Owns window bootstrap and renders Splash until ledger hydration completes. */
export function AppRoot() {
  useAppBootstrap()
  useSyncAppVerticalFromRoute()

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
          <AppSidebar />
          <SidebarInset className="min-h-0">
            <ApplicationConnectionNotice />
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
