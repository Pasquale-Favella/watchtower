import { useHotkey } from '@tanstack/react-hotkeys'

import { TooltipProvider } from '@/shared/components/ui/tooltip'
import { SidebarInset, SidebarProvider, useSidebar } from '@/shared/components/ui/sidebar'
import { motionClass } from '@/shared/lib/motion'
import { DEFAULT_PERIOD_OPTIONS } from '@/shared/lib/settings-constants'
import {
  displayShortcutForAction, sectionsRangeLabel, shortcutForAction,
} from '@/app/shortcuts'
import { useShellStore } from '@/app/stores/shell-store'
import { useScanStore } from '@/app/stores/scan-store'
import { AppSidebar } from '@/app/components/app-sidebar'
import { TopBar } from '@/app/components/TopBar'
import { OverviewView } from '@/features/overview/OverviewView'
import { SessionsView } from '@/features/sessions/SessionsView'
import { SessionView } from '@/features/sessions/SessionView'
import { PullRequestsView } from '@/features/pull-requests/PullRequestsView'
import { SpendView } from '@/features/spend/SpendView'
import { OptimizeView } from '@/features/optimize/OptimizeView'
import { ModelsView } from '@/features/models/ModelsView'
import { CompareView } from '@/features/compare/CompareView'
import { SettingsView } from '@/features/settings/SettingsView'

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

/** The section switch (ADR 0011): each feature view reads its own store
 * + the shared scope selector; no props threaded. Settings is full-bleed
 * (its own header and nav rail), so it is handled by ShellLayout, not here. */
export function ContentRegion() {
  const section = useShellStore(s => s.section)
  const openSession = useShellStore(s => s.openSession)

  let view: React.JSX.Element | null = null
  if (section === 'overview') {
    view = <OverviewView />
  } else if (section === 'sessions' && openSession) {
    view = <div className="w-full max-w-[1180px]"><SessionView /></div>
  } else if (section === 'sessions') {
    view = <SessionsView />
  } else if (section === 'pullRequests') {
    view = <PullRequestsView />
  } else if (section === 'spend') {
    view = <SpendView />
  } else if (section === 'optimize') {
    view = <OptimizeView />
  } else if (section === 'models') {
    view = <ModelsView />
  } else if (section === 'compare') {
    view = <CompareView />
  }

  return (
    <div className={motionClass('flex min-h-0 flex-1 flex-col items-center overflow-y-auto gap-4 px-5 pt-4 pb-4', 'section-fade')}>
      {view}
    </div>
  )
}

/** The footer — reads scanning/unparsed from the scan store and the shortcut
 * hints from the registry (ADR 0011). */
export function StatusBar() {
  const scanning = useScanStore(s => s.scanning)
  const unparsedTotal = useScanStore(s => s.unparsedTotal)
  const sectionsRange = sectionsRangeLabel()

  return (
    <div className="flex items-center gap-3.5 border-t border-border px-4 py-2 text-[10.5px] text-muted-foreground">
      {sectionsRange && <span><kbd className="mr-1 rounded border border-border px-1 font-mono text-muted-foreground">{sectionsRange}</kbd>Navigate</span>}
      <span><kbd className="mr-1 rounded border border-border px-1 font-mono text-muted-foreground">{displayShortcutForAction('settings')}</kbd>Settings</span>
      <span>
        <kbd className="mr-1 rounded border border-border px-1 font-mono text-muted-foreground">{displayShortcutForAction('refresh')}</kbd>
        {scanning ? 'Refreshing…' : 'Refresh'}
      </span>
      {unparsedTotal > 0 && (
        <span
          className="text-amber-600 dark:text-amber-400"
          title="Rows skipped because a field failed the extraction schema (provider schema drift) — surfaced so drift is visible, not silent"
        >
          {unparsedTotal} unparsed {unparsedTotal === 1 ? 'row' : 'rows'} skipped
        </span>
      )}
      <span className="ml-auto">{DEFAULT_PERIOD_OPTIONS.length} periods · desktop-transpose</span>
    </div>
  )
}

/** The decomposed shell JSX (ADR 0011): composed components reading from
 * co-located stores. Settings is the one full-bleed exception — its own header
 * and nav rail replace the TopBar/StatusBar strip, exactly as before. */
export function ShellLayout() {
  const settingsMode = useShellStore(s => s.section === 'settings')

  return (
    <TooltipProvider delay={0}>
      <SidebarProvider className="h-screen">
        <SidebarToggleShortcut />
        <AppSidebar />
        <SidebarInset className="min-h-0">
          <ScanIndicator />
          {settingsMode ? <SettingsView /> : (
            <>
              <TopBar />
              <ContentRegion />
              <StatusBar />
            </>
          )}
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
