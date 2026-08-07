/** The canonical period options (values + labels) the app's period switcher
 * and the default-period setting share. Single source of truth: TopBar renders
 * it as its SegTabs, and Settings › General's default-period Select uses it, so
 * the two can never drift. */

/** The period values the app's default-period setting accepts. */
export const DEFAULT_PERIOD_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: '7D' },
  { value: '30days', label: '30D' },
  { value: 'month', label: 'Month' },
  { value: 'all', label: '6M' },
  { value: 'lifetime', label: 'Life' },
]

export const DEFAULT_PERIOD_VALUES: ReadonlyArray<string> = DEFAULT_PERIOD_OPTIONS.map(option => option.value)

/** The long-form scope labels for the sidebar footer and TopBar caption (the
 * SegTabs use the short `DEFAULT_PERIOD_OPTIONS` labels). */
export const PERIOD_LABELS: Record<string, string> = {
  today: 'Today', week: 'Last 7 days', month: 'This month', '30days': 'Last 30 days',
  all: 'Last 6 months', lifetime: 'Lifetime',
}
