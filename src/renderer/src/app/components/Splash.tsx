import { Button } from '@/shared/components/ui/button'
import { WatchtowerIcon } from '@/app/components/WatchtowerIcon'
import { useScanStore } from '@/app/stores/scan-store'

/**
 * First-launch/first-hydrate splash: shown until the store has a report to
 * read, with a per-provider scan-progress list fed by the main process's
 * `scan:progress` events. If the initial scan fails, shows an error message
 * and a manual retry button instead of leaving the user stuck indefinitely.
 * Store-driven (map ticket 04): progress, error, and retry come from the scan
 * store.
 */
export function Splash() {
  const providers = useScanStore(s => s.progress)
  const error = useScanStore(s => s.scanError)
  const refresh = useScanStore(s => s.refresh)

  return (
    <div className="flex h-screen w-full flex-col items-center justify-center gap-6 bg-background text-foreground">
      <div className="flex items-center gap-2">
        <WatchtowerIcon className="size-7 text-brand" />
        <b className="text-lg font-bold tracking-tight">Watchtower</b>
      </div>
      <p className="text-[12.5px] text-muted-foreground">Scanning your machine's code-assistant sources…</p>
      <div className="flex w-72 flex-col gap-1.5">
        {providers.length === 0 && !error && (
          <span className="text-center text-[11px] text-mut2">Starting…</span>
        )}
        {providers.map(p => (
          <div key={p.provider} className="flex items-center justify-between rounded-md border border-border bg-card px-2.5 py-1.5 text-[11.5px]">
            <span className="capitalize">{p.provider}</span>
            <span className={p.done ? 'text-brand' : 'text-mut2'}>
              {p.done ? 'done' : p.total ? `${p.processed ?? 0}/${p.total}` : '…'}
            </span>
          </div>
        ))}
      </div>
      {error && (
        <div className="flex w-72 flex-col items-center gap-2 rounded-md border border-border bg-card px-3 py-2.5 text-center">
          <span className="text-[11.5px] text-destructive">{error}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>
            Retry
          </Button>
        </div>
      )}
    </div>
  )
}
