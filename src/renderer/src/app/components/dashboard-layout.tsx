import { Outlet } from '@tanstack/react-router'

import { motionClass } from '@/shared/lib/motion'
import { DEFAULT_PERIOD_OPTIONS } from '@/shared/lib/settings-constants'
import { displayShortcutForAction, sectionsRangeLabel } from '@/app/shortcuts'
import { useScanStore } from '@/app/stores/scan-store'
import { TopBar } from '@/app/components/TopBar'

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

/** The dashboard layout route (ADR 0014): the TopBar/scroll-region/StatusBar
 * strip around the seven section views. Settings is full-bleed (its own
 * header and nav rail) and skips this strip. */
export function DashboardLayout() {
  return (
    <>
      <TopBar />
      <div className={motionClass('flex min-h-0 flex-1 flex-col items-center overflow-y-auto gap-4 px-5 pt-4 pb-4', 'section-fade')}>
        <Outlet />
      </div>
      <StatusBar />
    </>
  )
}
