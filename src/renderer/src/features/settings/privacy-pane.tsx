import { useCallback, useEffect, useState } from 'react'
import { Database, KeyRound, ShieldCheck } from 'lucide-react'

import { Card } from '@/shared/components/ui/card'
import { Separator } from '@/shared/components/ui/separator'
import { Button } from '@/shared/components/ui/button'
import { ConfirmRemove, PaneHeader } from '@/features/settings/pane-parts'
import { formatBytes } from '@/features/settings/lib'
import { fetchClearData, fetchSettings } from '@/shared/lib/api'
import { subscribeToRefresh, useScanStore } from '@/app/stores/scan-store'
import type { SettingsInfo } from '@/features/settings/settings-types'

/** Settings › Privacy & data: the local-only/no-API-keys claims, the SQLite
 * store's location and size, and a clear-data action. No telemetry toggle —
 * there is no telemetry. */
export function PrivacyPane() {
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

  // A clear triggers a rescan, so re-read the on-disk sizes whenever a scan
  // (or config change) settles — otherwise the pane keeps showing the
  // post-clear payload while the store refills underneath it.
  useEffect(() => subscribeToRefresh(() => { void load() }), [load])

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
            <p className="text-[11px] text-muted-foreground">Usage is detected from local files; no provider API keys are required. Coach runs use each harness&apos;s own sign-in — an opt-in toggle in Coach can pass environment keys through instead.</p>
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
