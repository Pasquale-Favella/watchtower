import { PaneHeader } from '@/features/settings/pane-parts'
import { useSettingsProvidersStore } from '@/features/settings/use-settings-store'
import { QueryErrorNotice } from '@/shared/components/QueryErrorNotice'
import { LoadingRegion } from '@/shared/components/skeletons'
import { Card } from '@/shared/components/ui/card'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { providerTitle } from '@/shared/lib/models'
import { seriesColorForModel } from '@/shared/lib/modelSeries'
import { useCurrencyFormatter } from '@/shared/lib/use-currency-formatter'

/** Settings › Providers: a read-only list of the providers detected on this
 * machine (auto-detected from local session files — no setup needed). */
export function ProvidersPane() {
  const { data, error } = useSettingsProvidersStore()
  const { formatUsd } = useCurrencyFormatter()
  const providers = data?.providers ?? null

  return (
    <div className="flex max-w-md flex-col gap-3">
      <PaneHeader
        title="Providers"
        subtitle="The app auto-detects coding tools from local session files. No setup needed — this list is read-only."
      />
      {providers === null && error && <QueryErrorNotice error={error} hasData={false} />}
      {providers === null && !error && (
        <LoadingRegion label="Loading detected providers…" className="flex flex-col gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="px-4 py-3">
              <div className="flex items-center gap-2.5">
                <Skeleton className="size-[9px] rounded-full" />
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="ml-auto h-3 w-16" />
              </div>
              <div className="mt-2 flex gap-4">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-3 w-14" />
                <Skeleton className="h-3 w-14" />
              </div>
            </Card>
          ))}
        </LoadingRegion>
      )}
      {providers !== null && (
        <>
          <QueryErrorNotice error={error} hasData />
          {providers.length === 0 && (
            <p className="text-muted-foreground text-[11.5px]">No providers detected yet — run a scan first.</p>
          )}
          {providers.length > 0 &&
            providers.map(provider => (
              <Card key={provider.name} className="px-4 py-3">
                <div className="flex items-center gap-2.5">
                  <span
                    aria-hidden="true"
                    className="inline-block size-[9px] shrink-0 rounded-full"
                    style={{ background: seriesColorForModel(provider.name) }}
                  />
                  <span className="text-foreground text-[12.5px] font-medium">{providerTitle(provider.name)}</span>
                  <span className="text-muted-foreground ml-auto flex items-center gap-1.5 text-[11px]">
                    <span className="bg-success inline-block size-[6px] rounded-full" />
                    Detected
                  </span>
                </div>
                <div className="text-muted-foreground mt-2 flex gap-4 text-[11px]">
                  <span>{formatUsd(provider.cost)}</span>
                  <span>{provider.calls.toLocaleString('en-US')} calls</span>
                  <span>{provider.sessions.toLocaleString('en-US')} sessions</span>
                </div>
              </Card>
            ))}
        </>
      )}
    </div>
  )
}
