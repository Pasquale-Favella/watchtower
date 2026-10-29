import { Database, KeyRound, ShieldCheck } from 'lucide-react'
import { useState } from 'react'

import { formatBytes } from '@/features/settings/lib'
import { ConfirmRemove, PaneHeader } from '@/features/settings/pane-parts'
import { useSettingsPrivacyStore } from '@/features/settings/use-settings-store'
import { QueryErrorNotice } from '@/components/QueryErrorNotice'
import { Card } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'

/** Settings › Privacy & data: the local-only/no-API-keys claims, the SQLite
 * store's location and size, and a clear-data action. No telemetry toggle —
 * there is no telemetry. */
export function PrivacyPane() {
  const [clearing, setClearing] = useState(false)
  const [clearError, setClearError] = useState<string | null>(null)
  const { info: infoQuery, clearData } = useSettingsPrivacyStore()
  const { data: info, error: settingsInfoError } = infoQuery

  const clear = async (): Promise<void> => {
    setClearError(null)
    setClearing(true)
    try {
      const result = await clearData(undefined)
      if (!result.ok) setClearError(result.message)
    } finally {
      setClearing(false)
    }
  }

  return (
    <div className="flex max-w-md flex-col gap-3">
      <PaneHeader title="Privacy & data" subtitle="What the app does, and does not do, with your data." />
      <QueryErrorNotice error={settingsInfoError} hasData={info !== null} />
      <Card className="flex flex-col gap-4 px-4 py-4">
        <div className="flex items-start gap-2.5">
          <ShieldCheck className="text-brand-text mt-0.5 size-4 shrink-0" />
          <div>
            <p className="text-foreground text-[12.5px] font-medium">Local-only</p>
            <p className="text-muted-foreground text-[11px]">
              Everything runs on your machine. Data is read from local session files.
            </p>
          </div>
        </div>
        <div className="flex items-start gap-2.5">
          <KeyRound className="text-brand-text mt-0.5 size-4 shrink-0" />
          <div>
            <p className="text-foreground text-[12.5px] font-medium">No API keys</p>
            <p className="text-muted-foreground text-[11px]">
              Usage is detected from local files; no provider API keys are required. Coach runs use each harness&apos;s
              own sign-in — an opt-in toggle in Coach can pass environment keys through instead.
            </p>
          </div>
        </div>
      </Card>

      <Card className="px-4 py-3">
        <p className="text-muted-foreground flex items-center gap-2 text-[10.5px] font-semibold tracking-[0.05em] uppercase">
          <Database className="size-3.5" /> Store
        </p>
        <div className="mt-2 flex flex-col gap-1.5 text-[11.5px]">
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground shrink-0">Location</span>
            <span className="text-foreground text-right break-all">{info?.dataDir ?? '…'}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground shrink-0">Database size</span>
            <span className="text-foreground">{info ? formatBytes(info.dbSize) : '…'}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground shrink-0">Total data size</span>
            <span className="text-foreground">{info ? formatBytes(info.dataDirSize) : '…'}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground shrink-0">Pricing cache</span>
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
          {clearing && <span className="text-muted-foreground text-[11px]">Clearing…</span>}
          {clearError && <span className="text-destructive text-[11px]">{clearError}</span>}
        </div>
      </Card>
    </div>
  )
}
