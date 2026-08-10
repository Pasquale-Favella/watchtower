import { useEffect, useState } from 'react'
import { ExternalLink, ShieldAlert, X } from 'lucide-react'

import { Button } from '@/shared/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select'
import { SegTabs } from '@/shared/components/SegTabs'
import { AboutSection } from '@/features/settings/AboutSection'
import { CADENCE_UI_OPTIONS, type Theme } from '@/shared/lib/shell'
import { DEFAULT_PERIOD_OPTIONS } from '@/shared/lib/settings-constants'
import { fetchSettings } from '@/shared/lib/api'
import { useSettingsStore } from '@/features/settings/store'
import { useScanStore } from '@/app/stores/scan-store'

const THEME_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

/** Settings › General: theme, default period, refresh cadence (ADR 0004),
 * currency dropdown (ADR 0009), and the About/version area (ADR 0012).
 * Deliberately no daily-budget row (lives in Plans) and no Scope row. */
export function GeneralPane() {
  const fdaNeeded = useScanStore(s => s.fdaNeeded)
  const [fdaDismissed, setFdaDismissed] = useState(false)
  const theme = useSettingsStore(s => s.theme)
  const setTheme = useSettingsStore(s => s.setTheme)
  const cadence = useSettingsStore(s => s.cadence)
  const setCadence = useSettingsStore(s => s.setCadence)
  const currency = useSettingsStore(s => s.activeCurrency)
  const currencyOptions = useSettingsStore(s => s.currencyOptions)
  const setCurrency = useSettingsStore(s => s.setCurrency)
  const defaultPeriod = useSettingsStore(s => s.defaultPeriod)
  const setDefaultPeriod = useSettingsStore(s => s.setDefaultPeriod)
  const [claudeConfigDirs, setClaudeConfigDirs] = useState<string[] | undefined>()

  useEffect(() => {
    let cancelled = false
    void fetchSettings().then(result => {
      if (cancelled) return
      setClaudeConfigDirs(result.ok ? result.data.claudeConfigDirs : undefined)
    })
    return () => { cancelled = true }
  }, [])

  const choosePeriod = (value: string): void => {
    setDefaultPeriod(value)
  }

  // The Claude-config row is conditional: shown when a
  // Claude config dir is available, and nullable — absent `claudeConfigDirs`
  // hides the row rather than erroring.
  const showClaudeConfigRow = (claudeConfigDirs?.length ?? 0) > 0

  return (
    <div className="flex max-w-md flex-col gap-5">
      {/* macOS Full Disk Access gate (ADR 0015): shown only when the last scan
       * found zero sources on a Mac — the one platform whose privacy gate
       * silently hides provider data. Dismissal is pane-local: leaving and
       * returning to Settings (or the next zero-source scan) shows it again. */}
      {fdaNeeded && !fdaDismissed && (
        <div className="flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2.5">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-medium text-foreground">No coding-tool data found</p>
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
              On macOS, Watchtower needs{' '}
              <span className="font-medium text-foreground">Full Disk Access</span> to read Claude,
              Cursor, and other tool data. Grant it in System Settings, then refresh with{' '}
              <span className="font-medium text-foreground">⌘R</span>.
            </p>
            <button
              type="button"
              className="mt-1.5 inline-flex cursor-pointer items-center gap-1 text-[11px] font-medium text-brand-text"
              onClick={() => void window.api.openSystemSettings()}
            >
              Open System Settings <ExternalLink className="size-3" />
            </button>
          </div>
          <button
            type="button"
            aria-label="Dismiss"
            className="cursor-pointer rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setFdaDismissed(true)}
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
      <div className="flex flex-col gap-2">
        <p className="text-[10.5px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">Appearance</p>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12.5px] text-foreground">Theme</span>
          <SegTabs options={THEME_OPTIONS} value={theme} onChange={value => setTheme(value as Theme)} />
        </div>
        <p className="text-[11px] text-muted-foreground">Match your system or force a mode; your choice persists.</p>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-[10.5px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">Display</p>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="settings-currency" className="text-[12.5px] font-medium text-foreground">Currency</label>
          <p className="text-[11px] text-muted-foreground">Display currency for every cost in the app and in CSV/JSON exports. Rates come from the Frankfurter API (ECB data) and are cached 24h.</p>
          <div className="flex items-center gap-2">
            <Select
              value={currency.code}
              onValueChange={value => { if (value) void setCurrency(value) }}
            >
              <SelectTrigger id="settings-currency" size="sm" className="mt-1 w-full text-[12.5px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {currencyOptions.map(option => (
                  <SelectItem key={option.code} value={option.code}>{option.code} · {option.symbol}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-1 shrink-0 text-[11px]"
              disabled={currency.code === 'USD'}
              onClick={() => void setCurrency('USD')}
            >
              Reset to USD
            </Button>
          </div>
          {currency.code !== 'USD' && currency.updatedAt && (
            <p className="text-[10.5px] text-muted-foreground">Rate fetched {new Date(currency.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.</p>
          )}
          {currency.code !== 'USD' && !currency.updatedAt && (
            <p className="text-[10.5px] text-muted-foreground">No rate cached yet — showing USD-equivalent values until a fetch succeeds.</p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="settings-period" className="text-[12.5px] font-medium text-foreground">Default period</label>
          <p className="text-[11px] text-muted-foreground">Applied on next launch.</p>
          <Select value={defaultPeriod} onValueChange={value => { if (value) choosePeriod(value) }}>
            <SelectTrigger id="settings-period" size="sm" className="mt-1 w-full text-[12.5px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DEFAULT_PERIOD_OPTIONS.map(option => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="settings-cadence" className="text-[12.5px] font-medium text-foreground">Refresh every</label>
          <p className="text-[11px] text-muted-foreground">How often the app scans your machine's sources in the background. Manual only refreshes on ⌘R.</p>
          <Select value={cadence} onValueChange={value => { if (value) void setCadence(value) }}>
            <SelectTrigger id="settings-cadence" size="sm" className="mt-1 w-full text-[12.5px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CADENCE_UI_OPTIONS.map(option => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {showClaudeConfigRow && (
        <div className="flex flex-col gap-2">
          <p className="text-[10.5px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">Claude config</p>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12.5px] text-foreground">Active config</span>
            <span className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground">All Claude configs</span>
          </div>
          <p className="text-[11px] text-muted-foreground">Applies to the overview data. Manage config folders with CLAUDE_CONFIG_DIRS or the watchtower config.</p>
        </div>
      )}

      <AboutSection />
    </div>
  )
}
