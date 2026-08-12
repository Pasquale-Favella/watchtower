/** The canonical period options (values + labels) the app's period switcher
 * and the default-period setting share. Single source of truth: TopBar renders
 * it as its SegTabs, and Settings › General's default-period Select uses it, so
 * the two can never drift. */

/** The period values the app's default-period setting accepts. */
export const DEFAULT_PERIOD_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: '7D' },
  { value: '30days', label: '30D' },
  { value: 'all', label: '6M' },
  { value: 'lifetime', label: 'Life' },
]

export const DEFAULT_PERIOD_VALUES: ReadonlyArray<string> = DEFAULT_PERIOD_OPTIONS.map(option => option.value)

/** The long-form scope labels for the sidebar footer and TopBar caption (the
 * SegTabs use the short `DEFAULT_PERIOD_OPTIONS` labels). Re-exported from the
 * shared lib (src/shared/lib/period-labels.ts) so the UI captions and the MCP
 * briefing the harness agents receive can never drift (ADR 0020). */
export { PERIOD_LABELS } from '../../../../shared/lib/period-labels.js'
