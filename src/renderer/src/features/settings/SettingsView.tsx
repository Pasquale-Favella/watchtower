import { useCallback, useEffect, useState } from 'react'
import { Database, Download, ExternalLink, KeyRound, ShieldAlert, ShieldCheck, X } from 'lucide-react'

import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Card } from '@/shared/components/ui/card'
import { Separator } from '@/shared/components/ui/separator'
import { SidebarTrigger } from '@/shared/components/ui/sidebar'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select'
import { SegTabs } from '@/shared/components/SegTabs'
import { AboutSection } from '@/features/settings/AboutSection'
import { formatUsd } from '@/shared/lib/currency'
import { providerTitle } from '@/shared/lib/models'
import { seriesColorForModel } from '@/shared/lib/modelSeries'
import { CADENCE_UI_OPTIONS, type Theme } from '@/shared/lib/shell'
import { DEFAULT_PERIOD_OPTIONS } from '@/shared/lib/settings-constants'
import { formatBytes, validatePricing } from '@/features/settings/lib'
import {
  fetchAddModelAlias,
  fetchAnalytics,
  fetchClearData,
  fetchExport,
  fetchModelAliases,
  fetchPriceOverrides,
  fetchRemoveModelAlias,
  fetchRemovePriceOverride,
  fetchSetModelPrice,
  fetchSettings,
} from '@/shared/lib/api'
import { useSettingsStore } from '@/features/settings/store'
import { useScanStore } from '@/app/stores/scan-store'
import type { SettingsInfo, ModelAlias, PriceOverride, ProviderRow } from '@/features/settings/settings-types'

type SettingsPane = 'general' | 'providers' | 'aliases' | 'pricing' | 'export' | 'privacy'

const RAIL_ITEMS: Array<{ id: SettingsPane; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'providers', label: 'Providers' },
  { id: 'aliases', label: 'Model aliases' },
  { id: 'pricing', label: 'Pricing' },
  { id: 'export', label: 'Export' },
  { id: 'privacy', label: 'Privacy & data' },
]

const THEME_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

function PaneHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <p className="text-[13px] font-semibold tracking-tight">{title}</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{subtitle}</p>
    </div>
  )
}

/** Inline destructive confirm: the button swaps to a prompt + Confirm/Cancel
 * in place (no OS dialog). Auto-cancels on Escape or when focus leaves. */
function ConfirmRemove({ label, prompt, onConfirm }: { label: string; prompt: string; onConfirm: () => void }) {
  const [confirming, setConfirming] = useState(false)
  if (!confirming) {
    return (
      <Button type="button" variant="outline" size="xs" onClick={() => setConfirming(true)}>
        {label}
      </Button>
    )
  }
  return (
    <span
      className="flex items-center gap-1.5"
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setConfirming(false) }}
      onKeyDown={event => { if (event.key === 'Escape') setConfirming(false) }}
    >
      <span className="text-[11px] text-muted-foreground">{prompt}</span>
      <Button
        type="button"
        variant="destructive"
        size="xs"
        autoFocus
        onClick={() => { setConfirming(false); onConfirm() }}
      >
        Confirm
      </Button>
      <Button type="button" variant="outline" size="xs" onClick={() => setConfirming(false)}>Cancel</Button>
    </span>
  )
}

/** Settings › General: theme, default period, refresh cadence (ADR 0004),
 * currency dropdown (ADR 0009), and the About/version area (ADR 0012).
 * Deliberately no daily-budget row (lives in Plans) and no Scope row. */
function GeneralPane() {
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

/** Settings › Providers: a read-only list of the providers detected on this
 * machine (auto-detected from local session files — no setup needed). */
function ProvidersPane() {
  const [providers, setProviders] = useState<ProviderRow[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void fetchAnalytics().then(result => {
      if (cancelled) return
      setProviders(result.ok && result.data ? result.data.providers : [])
    })
    return () => { cancelled = true }
  }, [])

  return (
    <div className="flex max-w-md flex-col gap-3">
      <PaneHeader
        title="Providers"
        subtitle="The app auto-detects coding tools from local session files. No setup needed — this list is read-only."
      />
      {providers === null ? (
        <p className="text-[11.5px] text-muted-foreground">Loading detected providers…</p>
      ) : providers.length === 0 ? (
        <p className="text-[11.5px] text-muted-foreground">No providers detected yet — run a scan first.</p>
      ) : (
        providers.map(provider => (
          <Card key={provider.name} className="px-4 py-3">
            <div className="flex items-center gap-2.5">
              <span
                aria-hidden="true"
                className="inline-block size-[9px] shrink-0 rounded-full"
                style={{ background: seriesColorForModel(provider.name) }}
              />
              <span className="text-[12.5px] font-medium text-foreground">{providerTitle(provider.name)}</span>
              <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="inline-block size-[6px] rounded-full bg-success" />
                Detected
              </span>
            </div>
            <div className="mt-2 flex gap-4 text-[11px] text-muted-foreground">
              <span>{formatUsd(provider.cost)}</span>
              <span>{provider.calls.toLocaleString('en-US')} calls</span>
              <span>{provider.sessions.toLocaleString('en-US')} sessions</span>
            </div>
          </Card>
        ))
      )}
    </div>
  )
}

/** Settings › Model aliases: full CRUD against the store's alias config
 * table. An alias maps an unrecognized model name to a priced model so its
 * cost shows up (the same table the Models section's quick-add writes to). */
function AliasesPane() {
  const [aliases, setAliases] = useState<ModelAlias[] | null>(null)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const result = await fetchModelAliases()
    setAliases(result.ok ? result.data : [])
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const add = async (): Promise<void> => {
    const model = from.trim()
    const aliasOf = to.trim()
    if (!model || !aliasOf) {
      setError('Both the unrecognized model and its priced target are required.')
      return
    }
    setError(null)
    setBusy(true)
    try {
      const result = await fetchAddModelAlias(model, aliasOf)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setFrom('')
      setTo('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Alias action failed.')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (model: string): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      const result = await fetchRemoveModelAlias(model)
      if (!result.ok) {
        setError(result.error)
        return
      }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Alias action failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex max-w-md flex-col gap-3">
      <PaneHeader
        title="Model aliases"
        subtitle="Map an unrecognized model name to a priced model so its cost shows up."
      />
      <Card className="px-4 py-3">
        {aliases === null ? (
          <p className="text-[11.5px] text-muted-foreground">Loading aliases…</p>
        ) : aliases.length === 0 ? (
          <p className="text-[11.5px] text-muted-foreground">No aliases configured. Unknown models are priced at $0 until aliased.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {aliases.map(alias => (
              <li key={alias.model} className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{alias.model}</code>
                <span className="text-muted-foreground">→</span>
                <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground">{alias.aliasOf}</code>
                <ConfirmRemove
                  label="Remove"
                  prompt="Remove?"
                  onConfirm={() => void remove(alias.model)}
                />
              </li>
            ))}
          </ul>
        )}
        <Separator className="my-3" />
        <div className="flex items-center gap-2">
          <Input
            aria-label="Unrecognized model"
            value={from}
            onChange={event => setFrom(event.target.value)}
            placeholder="unrecognized model"
            className="h-7 flex-1 font-mono text-[11.5px]"
          />
          <span className="text-muted-foreground">→</span>
          <Input
            aria-label="Priced model"
            value={to}
            onChange={event => setTo(event.target.value)}
            placeholder="priced model"
            className="h-7 flex-1 font-mono text-[11.5px]"
          />
          <Button type="button" size="sm" disabled={busy || !from.trim() || !to.trim()} onClick={() => void add()}>
            Add
          </Button>
        </div>
        {error && <p className="mt-2 text-[11px] text-destructive">{error}</p>}
      </Card>
      <p className="text-[11px] text-muted-foreground">Unknown models are priced at $0 until aliased. A local model can instead be credited with what it would have cost via model-savings.</p>
    </div>
  )
}

/** Settings › Pricing: full CRUD against the store's price-override config
 * table — set/update an override or add a new model, and remove one to revert
 * its stored calls to the pipeline-computed cost. Rates are USD per 1M tokens. */
function PricingPane() {
  const [overrides, setOverrides] = useState<PriceOverride[] | null>(null)
  const [model, setModel] = useState('')
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const result = await fetchPriceOverrides()
    setOverrides(result.ok ? result.data : [])
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const add = async (): Promise<void> => {
    const pricing = validatePricing(model, input, output)
    if (!pricing.ok) {
      setError(pricing.error)
      return
    }
    setError(null)
    setBusy(true)
    try {
      const result = await fetchSetModelPrice(pricing.model, pricing.inputPricePerMillion, pricing.outputPricePerMillion)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setModel('')
      setInput('')
      setOutput('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Price override action failed.')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (modelName: string): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      const result = await fetchRemovePriceOverride(modelName)
      if (!result.ok) {
        setError(result.error)
        return
      }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Price override action failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex max-w-md flex-col gap-3">
      <PaneHeader
        title="Pricing"
        subtitle="Override or add per-model rates so local or self-hosted models are priced. Rates are USD per 1,000,000 tokens."
      />
      <Card className="px-4 py-3">
        {overrides === null ? (
          <p className="text-[11.5px] text-muted-foreground">Loading price overrides…</p>
        ) : overrides.length === 0 ? (
          <p className="text-[11.5px] text-muted-foreground">No price overrides configured. Add one below to price an unrecognized or local model.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {overrides.map(override => (
              <li key={override.model} className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{override.model}</code>
                <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
                  in {override.inputPricePerMillion} · out {override.outputPricePerMillion}
                </span>
                <ConfirmRemove
                  label="Remove"
                  prompt="Remove?"
                  onConfirm={() => void remove(override.model)}
                />
              </li>
            ))}
          </ul>
        )}
        <Separator className="my-3" />
        <div className="grid grid-cols-[1fr_70px_70px_auto] items-center gap-2">
          <Input
            aria-label="Override model"
            value={model}
            onChange={event => setModel(event.target.value)}
            placeholder="model name"
            className="h-7 font-mono text-[11.5px]"
          />
          <Input
            aria-label="Input rate"
            value={input}
            onChange={event => setInput(event.target.value)}
            placeholder="input"
            inputMode="decimal"
            className="h-7 font-mono text-[11.5px]"
          />
          <Input
            aria-label="Output rate"
            value={output}
            onChange={event => setOutput(event.target.value)}
            placeholder="output"
            inputMode="decimal"
            className="h-7 font-mono text-[11.5px]"
          />
          <Button
            type="button"
            size="sm"
            disabled={busy || !model.trim() || !input.trim() || !output.trim()}
            onClick={() => void add()}
          >
            Add
          </Button>
        </div>
        {error && <p className="mt-2 text-[11px] text-destructive">{error}</p>}
      </Card>
      <p className="text-[11px] text-muted-foreground">A configured model is overridden; an unknown one is added. Removing an override reverts its stored calls to the standard pricing — no rescan needed.</p>
    </div>
  )
}

/** Settings › Export: CSV/JSON export through the export bridge, in the
 * currently selected display currency. The main process shows the folder/file
 * picker at export time — data never leaves the machine. */
function ExportPane() {
  const [format, setFormat] = useState<'csv' | 'json'>('csv')
  const [exporting, setExporting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  const exportNow = async (): Promise<void> => {
    setResult(null)
    setExporting(true)
    try {
      const outcome = await fetchExport(format)
      setResult(outcome.ok
        ? { ok: true, text: `Exported to ${outcome.data.path}.` }
        : { ok: false, text: outcome.error ?? 'Export failed.' })
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : 'Export failed.' })
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="flex max-w-md flex-col gap-3">
      <PaneHeader
        title="Export"
        subtitle="Save your usage as CSV or JSON. Everything stays on your machine."
      />
      <Card className="px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12.5px] text-foreground">Format</span>
          <SegTabs
            options={[{ value: 'csv', label: 'CSV' }, { value: 'json', label: 'JSON' }]}
            value={format}
            onChange={value => { setFormat(value as 'csv' | 'json'); setResult(null) }}
          />
        </div>
        <Separator className="my-3" />
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-muted-foreground">Files are written in the selected display currency.</span>
          <Button type="button" size="sm" disabled={exporting} onClick={() => void exportNow()}>
            <Download className="size-3.5" />
            {exporting ? 'Exporting…' : 'Export'}
          </Button>
        </div>
        {result && (
          <p className={result.ok ? 'mt-2 text-[11px] text-success' : 'mt-2 text-[11px] text-destructive'}>
            {result.text}
          </p>
        )}
      </Card>
      <p className="text-[11px] text-muted-foreground">CSV writes a folder (summary, daily, models, projects, sessions, tools, mcp). JSON writes one file (schema watchtower.export.v1).</p>
    </div>
  )
}

/** Settings › Privacy & data: the local-only/no-API-keys claims, the SQLite
 * store's location and size, and a clear-data action. No telemetry toggle —
 * there is no telemetry. */
function PrivacyPane() {
  const [info, setInfo] = useState<SettingsInfo | null>(null)
  const [clearing, setClearing] = useState(false)
  const [clearError, setClearError] = useState<string | null>(null)
  const refresh = useScanStore(s => s.refresh)

  const load = useCallback(async (): Promise<void> => {
    const result = await fetchSettings()
    setInfo(result.ok ? result.data : null)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const clear = async (): Promise<void> => {
    setClearError(null)
    setClearing(true)
    const result = await fetchClearData()
    if (result.ok) {
      setInfo(result.data)
      void refresh()
    } else {
      setClearError(result.error)
    }
    setClearing(false)
  }

  return (
    <div className="flex max-w-md flex-col gap-3">
      <PaneHeader
        title="Privacy & data"
        subtitle="What the app does, and does not do, with your data."
      />
      <Card className="flex flex-col gap-4 px-4 py-4">
        <div className="flex items-start gap-2.5">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-brand-text" />
          <div>
            <p className="text-[12.5px] font-medium text-foreground">Local-only</p>
            <p className="text-[11px] text-muted-foreground">Everything runs on your machine. Data is read from local session files.</p>
          </div>
        </div>
        <div className="flex items-start gap-2.5">
          <KeyRound className="mt-0.5 size-4 shrink-0 text-brand-text" />
          <div>
            <p className="text-[12.5px] font-medium text-foreground">No API keys</p>
            <p className="text-[11px] text-muted-foreground">Usage is detected from local files; no provider API keys are required.</p>
          </div>
        </div>
      </Card>

      <Card className="px-4 py-3">
        <p className="flex items-center gap-2 text-[10.5px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">
          <Database className="size-3.5" /> Store
        </p>
        <div className="mt-2 flex flex-col gap-1.5 text-[11.5px]">
          <div className="flex justify-between gap-4">
            <span className="shrink-0 text-muted-foreground">Location</span>
            <span className="break-all text-right text-foreground">{info?.dataDir ?? '…'}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="shrink-0 text-muted-foreground">Database size</span>
            <span className="text-foreground">{info ? formatBytes(info.dbSize) : '…'}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="shrink-0 text-muted-foreground">Total data size</span>
            <span className="text-foreground">{info ? formatBytes(info.dataDirSize) : '…'}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="shrink-0 text-muted-foreground">Pricing cache</span>
            <span className="text-foreground">{info ? formatBytes(info.cacheSize) : '…'}</span>
          </div>
        </div>
        <Separator className="my-3" />
        <div className="flex items-center gap-2">
          <ConfirmRemove
            label="Clear data"
            prompt="This removes all scanned reports. Config (aliases, overrides, currency, cadence) is kept."
            onConfirm={() => void clear()}
          />
          {clearing && <span className="text-[11px] text-muted-foreground">Clearing…</span>}
          {clearError && <span className="text-[11px] text-destructive">{clearError}</span>}
        </div>
      </Card>
    </div>
  )
}

/** The Settings section: a six-pane rail — General, Providers,
 * Model aliases, Pricing, Export, Privacy & data — with no Devices pane and
 * no Plans pane (plan/budget editing lives only in the Plans section). */
export function SettingsView(): React.JSX.Element {
  const [pane, setPane] = useState<SettingsPane>('general')

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center gap-2.5 border-b border-border px-4 pb-[11px] pt-[13px]">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mr-1 h-4" />
        <div className="text-sm font-semibold tracking-tight">Settings</div>
        <div className="flex-1" />
      </div>
      <div className="flex flex-1">
        <nav className="flex w-[198px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border p-3.5" aria-label="Settings sections">
          {RAIL_ITEMS.map(item => (
            <button
              key={item.id}
              type="button"
              aria-current={pane === item.id ? 'page' : undefined}
              onClick={() => setPane(item.id)}
              className={`cursor-pointer rounded-md px-2.5 py-[7px] text-left text-[12.5px] hover:bg-accent hover:text-foreground ${pane === item.id ? 'bg-accent text-foreground' : 'text-muted-foreground'}`}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {pane === 'general' && <GeneralPane />}
          {pane === 'providers' && <ProvidersPane />}
          {pane === 'aliases' && <AliasesPane />}
          {pane === 'pricing' && <PricingPane />}
          {pane === 'export' && <ExportPane />}
          {pane === 'privacy' && <PrivacyPane />}
        </div>
      </div>
    </div>
  )
}
