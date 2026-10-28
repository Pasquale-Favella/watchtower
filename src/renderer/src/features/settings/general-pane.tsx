import { useAtomSet, useAtomValue } from '@effect/atom-react'
import { ExternalLink, ShieldAlert, X } from 'lucide-react'
import { useState } from 'react'

import { scanStateAtom } from '@/app/atoms/scan'
import { querySnapshot, useRemoteQuery } from '@/app/hooks/use-remote-query'
import { AboutSection } from '@/features/settings/AboutSection'
import {
  activeCurrencyAtom,
  cadenceAtom,
  currencyOptionsAtom,
  setCadenceAtom,
  setCurrencyAtom,
} from '@/features/settings/atoms'
import { SETTINGS_INFO_REQUEST, settingsInfoQuery } from '@/features/settings/capability-atoms'
import { openSystemSettingsAtom } from '@/features/settings/capability-atoms'
import { preferencesAtom, setPreferencesAtom } from '@/features/settings/preferences-atoms'
import { QueryErrorNotice } from '@/shared/components/QueryErrorNotice'
import { SegTabs } from '@/shared/components/SegTabs'
import { Button } from '@/shared/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/components/ui/select'
import { DEFAULT_PERIOD_OPTIONS } from '@/shared/lib/settings-constants'
import { CADENCE_UI_OPTIONS, type Theme } from '@/shared/lib/shell'

const THEME_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

/** Settings › General: theme, default period, refresh cadence (ADR 0004),
 * currency dropdown (ADR 0009), and the About/version area (ADR 0012).
 * Deliberately no daily-budget row (lives in Plans) and no Scope row. */
export function GeneralPane() {
  const fdaNeeded = useAtomValue(scanStateAtom).fdaNeeded
  const [fdaDismissed, setFdaDismissed] = useState(false)
  const preferences = useAtomValue(preferencesAtom)
  const cadence = useAtomValue(cadenceAtom)
  const currency = useAtomValue(activeCurrencyAtom)
  const currencyOptions = useAtomValue(currencyOptionsAtom)
  const setPreferences = useAtomSet(setPreferencesAtom)
  const setCadence = useAtomSet(setCadenceAtom)
  const setCurrency = useAtomSet(setCurrencyAtom)
  const cadenceChange = useAtomValue(setCadenceAtom)
  const currencyChange = useAtomValue(setCurrencyAtom)
  const cadenceError = querySnapshot(cadenceChange).error
  const currencyError = querySnapshot(currencyChange).error
  const openSystemSettings = useAtomSet(openSystemSettingsAtom, { mode: 'promise' })
  const [fdaError, setFdaError] = useState<string | null>(null)
  const { data: settingsInfo, error: settingsInfoError } = useRemoteQuery(
    settingsInfoQuery,
    SETTINGS_INFO_REQUEST,
    () => 'settings-info',
  )

  const choosePeriod = (value: string): void => {
    setPreferences({ defaultPeriod: value as typeof preferences.defaultPeriod })
  }

  // The Claude-config row is conditional: shown when a
  // Claude config dir is available, and nullable — absent `claudeConfigDirs`
  // hides the row rather than erroring.
  const showClaudeConfigRow = (settingsInfo?.claudeConfigDirs?.length ?? 0) > 0

  return (
    <div className="flex max-w-md flex-col gap-5">
      {/* macOS Full Disk Access gate (ADR 0015): shown only when the last scan
       * found zero sources on a Mac — the one platform whose privacy gate
       * silently hides provider data. Dismissal is pane-local: leaving and
       * returning to Settings (or the next zero-source scan) shows it again. */}
      {fdaNeeded && !fdaDismissed && (
        <div className="border-warning/40 bg-warning/5 flex items-start gap-2.5 rounded-lg border px-3 py-2.5">
          <ShieldAlert className="text-warning mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-foreground text-[12px] font-medium">No coding-tool data found</p>
            <p className="text-muted-foreground mt-0.5 text-[11px] leading-snug">
              On macOS, Watchtower needs <span className="text-foreground font-medium">Full Disk Access</span> to read
              Claude, Cursor, and other tool data. Grant it in System Settings, then refresh with{' '}
              <span className="text-foreground font-medium">⌘R</span>.
            </p>
            <button
              type="button"
              className="text-brand-text mt-1.5 inline-flex cursor-pointer items-center gap-1 text-[11px] font-medium"
              onClick={() => {
                setFdaError(null)
                void openSystemSettings(undefined).catch(error =>
                  setFdaError(error instanceof Error ? error.message : String(error)),
                )
              }}
            >
              Open System Settings <ExternalLink className="size-3" />
            </button>
            {fdaError && <p className="text-destructive mt-1 text-[10.5px]">{fdaError}</p>}
          </div>
          <button
            type="button"
            aria-label="Dismiss"
            className="text-muted-foreground hover:text-foreground cursor-pointer rounded p-0.5 transition-colors"
            onClick={() => setFdaDismissed(true)}
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
      <QueryErrorNotice error={settingsInfoError} hasData={settingsInfo !== null} />
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground text-[10.5px] font-semibold tracking-[0.05em] uppercase">Appearance</p>
        <div className="flex items-center justify-between gap-3">
          <span className="text-foreground text-[12.5px]">Theme</span>
          <SegTabs
            options={THEME_OPTIONS}
            value={preferences.theme}
            onChange={value => setPreferences({ theme: value as Theme })}
          />
        </div>
        <p className="text-muted-foreground text-[11px]">Match your system or force a mode; your choice persists.</p>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground text-[10.5px] font-semibold tracking-[0.05em] uppercase">Display</p>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="settings-currency" className="text-foreground text-[12.5px] font-medium">
            Currency
          </label>
          <p className="text-muted-foreground text-[11px]">
            Display currency for every cost in the app and in CSV/JSON exports. Rates come from the Frankfurter API (ECB
            data) and are cached 24h.
          </p>
          <div className="flex items-center gap-2">
            <Select
              value={currency.code}
              disabled={currencyChange.waiting}
              onValueChange={value => {
                if (value) setCurrency(value)
              }}
            >
              <SelectTrigger id="settings-currency" size="sm" className="mt-1 w-full text-[12.5px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {currencyOptions.map(option => (
                  <SelectItem key={option.code} value={option.code}>
                    {option.code} · {option.symbol}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-1 shrink-0 text-[11px]"
              disabled={currency.code === 'USD' || currencyChange.waiting}
              onClick={() => setCurrency('USD')}
            >
              Reset to USD
            </Button>
          </div>
          {currencyError && (
            <p role="alert" className="text-destructive text-[11px]">
              {currencyError}
            </p>
          )}
          {currency.code !== 'USD' && currency.updatedAt && (
            <p className="text-muted-foreground text-[10.5px]">
              Rate fetched{' '}
              {new Date(currency.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.
            </p>
          )}
          {currency.code !== 'USD' && !currency.updatedAt && (
            <p className="text-muted-foreground text-[10.5px]">
              No rate cached yet — showing USD-equivalent values until a fetch succeeds.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="settings-period" className="text-foreground text-[12.5px] font-medium">
            Default period
          </label>
          <p className="text-muted-foreground text-[11px]">Applied on next launch.</p>
          <Select
            value={preferences.defaultPeriod}
            onValueChange={value => {
              if (value) choosePeriod(value)
            }}
          >
            <SelectTrigger id="settings-period" size="sm" className="mt-1 w-full text-[12.5px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DEFAULT_PERIOD_OPTIONS.map(option => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="settings-cadence" className="text-foreground text-[12.5px] font-medium">
            Refresh every
          </label>
          <p className="text-muted-foreground text-[11px]">
            How often the app scans your machine's sources in the background. Manual only refreshes on ⌘R.
          </p>
          <Select
            value={cadence}
            disabled={cadenceChange.waiting}
            onValueChange={value => {
              if (value) setCadence(value)
            }}
          >
            <SelectTrigger id="settings-cadence" size="sm" className="mt-1 w-full text-[12.5px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CADENCE_UI_OPTIONS.map(option => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {cadenceError && (
            <p role="alert" className="text-destructive text-[11px]">
              {cadenceError}
            </p>
          )}
        </div>
      </div>

      {showClaudeConfigRow && (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-[10.5px] font-semibold tracking-[0.05em] uppercase">Claude config</p>
          <div className="flex items-center justify-between gap-3">
            <span className="text-foreground text-[12.5px]">Active config</span>
            <span className="border-border text-muted-foreground rounded-md border px-2 py-1 text-[11px]">
              All Claude configs
            </span>
          </div>
          <p className="text-muted-foreground text-[11px]">
            Applies to the overview data. Manage config folders with CLAUDE_CONFIG_DIRS or the watchtower config.
          </p>
        </div>
      )}

      <AboutSection />
    </div>
  )
}
