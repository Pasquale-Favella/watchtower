import { displayShortcutForAction, sectionsRangeLabel, shortcutForAction } from '@/app/shortcuts'
import { useScanStore } from '@/app/stores/scan-store'

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
      <span title={shortcutForAction('commandPalette')?.label}>
        <kbd className="mr-1 rounded border border-border px-1 font-mono text-muted-foreground">{displayShortcutForAction('commandPalette')}</kbd>
        Palette
      </span>
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
    </div>
  )
}
