import { ExternalLink, EyeOff, Power, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'

import { displayShortcutForAction } from '@/app/shortcuts'
import { useScanStore } from '@/app/stores/scan-store'
import { DailySpendChart } from '@/features/overview/DailySpendChart'
import { formatChartDate, formatChartValue, spendTrend } from '@/features/overview/lib'
import { useSettingsStore } from '@/features/settings/store'
import { SkeletonBars } from '@/shared/components/skeletons'
import { Button } from '@/shared/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader } from '@/shared/components/ui/card'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/components/ui/tooltip'
import { orbControls } from '@/shared/lib/api'
import { formatUsd } from '@/shared/lib/models'
import { cn } from '@/shared/lib/utils'

import { useOrbPanelStore } from './panel-store'
import { useOrbPlacementStore } from './placement-store'

/** The first-close peek's note (the main process decides when it shows). */
const BACKGROUNDED_PEEK = 'Still watching in the background'

/** The KpiBento's metric label style. */
const LABEL = 'text-muted-foreground text-[10px] font-medium tracking-wide uppercase'

/** Values fade in over their skeleton instead of popping in. */
const FADE_IN = 'animate-in fade-in-0 duration-300 motion-reduce:animate-none'

/** A fixed-height row: the skeleton and the value it becomes measure the
 * same, so data arriving never shifts the layout. */
function Slot({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('flex items-center', className)}>{children}</div>
}

/** The unfolded orb: the Overview's economics in miniature — today's spend,
 * the 30-day total with its week-over-week trend, local-model savings, and
 * the same daily-spend chart — plus the way back into the full app. */
export function OrbPanel({ className }: { className?: string }) {
  const peek = useOrbPlacementStore(s => s.placement.peek)
  const today = useOrbPanelStore(s => s.today.data)
  const recent = useOrbPanelStore(s => s.recent.data)
  // One failure policy: a failed load shows ONE error state in place of the
  // stats and chart. A slice that settled with nothing to show (no ledger
  // yet) shows a dash — never a skeleton that would not resolve.
  const todaySettled = useOrbPanelStore(s => s.today.status === 'ready')
  const recentSettled = useOrbPanelStore(s => s.recent.status === 'ready')
  const loadError = useOrbPanelStore(s => s.recent.error ?? s.today.error)
  const failed = loadError !== null && recent === null
  const scanning = useScanStore(s => s.scanning)
  const refresh = useScanStore(s => s.refresh)
  // Re-render money values when the display currency changes (ADR 0009).
  useSettingsStore(s => s.activeCurrency)

  const trend = recent ? spendTrend(recent.daily) : null

  return (
    <Card
      className={cn(
        'border-border bg-card gap-0 overflow-hidden rounded-xl border shadow-xl ring-0 [--card-spacing:0px]',
        className,
      )}
    >
      <CardHeader className="border-border flex flex-row items-start justify-between gap-2 border-b px-4 py-3">
        <div className="flex min-w-0 flex-col">
          <p className="text-muted-foreground text-[11px] font-medium tracking-wider uppercase">Today</p>
          <Slot className="mt-1 h-[26px]">
            {today ? (
              <span
                className={cn(
                  FADE_IN,
                  'text-primary truncate font-mono text-[26px] leading-none font-bold tracking-tight tabular-nums',
                )}
              >
                {formatUsd(today.kpis.cost)}
              </span>
            ) : todaySettled ? (
              <Empty />
            ) : (
              <Skeleton className="h-5 w-28" />
            )}
          </Slot>
          <Slot className="mt-1 h-4">
            {today ? (
              <small className={cn(FADE_IN, 'text-muted-foreground truncate text-[10.5px]')}>
                {today.kpis.sessions.toLocaleString('en-US')} session{today.kpis.sessions === 1 ? '' : 's'} ·{' '}
                {today.kpis.calls.toLocaleString('en-US')} calls
              </small>
            ) : todaySettled ? null : (
              <Skeleton className="h-3 w-32" />
            )}
          </Slot>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconAction label="Scan now" onClick={() => void refresh()} disabled={scanning}>
            <RefreshCw className={cn(scanning && 'animate-spin')} />
          </IconAction>
          <IconAction
            label={`Hide orb · ${displayShortcutForAction('summonOrb')} brings it back`}
            onClick={orbControls.hide}
          >
            <EyeOff />
          </IconAction>
          <IconAction label="Quit Watchtower" onClick={orbControls.quit}>
            <Power />
          </IconAction>
        </div>
      </CardHeader>

      <CardContent className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-4 py-3">
        {failed ? (
          <p
            className="text-muted-foreground grid h-full place-items-center text-center text-[11.5px]"
            title={loadError ?? undefined}
          >
            Couldn&apos;t load spend data — open Watchtower for details.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <div className="min-w-0">
                <p className={LABEL}>Last 30 days</p>
                <Slot className="mt-0.5 h-6">
                  {recent ? (
                    <p
                      className={cn(
                        FADE_IN,
                        'text-foreground truncate font-mono text-[16px] font-semibold tabular-nums',
                      )}
                    >
                      {formatUsd(recent.kpis.cost)}
                      {trend !== null && (
                        <span
                          className={cn(
                            'ml-1.5 font-sans text-[11px] font-medium',
                            trend >= 0 ? 'text-muted-foreground' : 'text-primary',
                          )}
                        >
                          {trend >= 0 ? '+' : ''}
                          {Math.round(trend * 100)}% wk
                        </span>
                      )}
                    </p>
                  ) : recentSettled ? (
                    <Empty />
                  ) : (
                    <Skeleton className="h-4 w-20" />
                  )}
                </Slot>
              </div>
              <div className="min-w-0">
                <p className={LABEL}>Via local models</p>
                <Slot className="mt-0.5 h-6">
                  {recent ? (
                    <p
                      className={cn(
                        FADE_IN,
                        'text-foreground truncate font-mono text-[16px] font-semibold tabular-nums',
                      )}
                    >
                      {formatUsd(recent.kpis.savingsUSD)}
                    </p>
                  ) : recentSettled ? (
                    <Empty />
                  ) : (
                    <Skeleton className="h-4 w-16" />
                  )}
                </Slot>
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex items-center justify-between">
                <p className={LABEL}>Spend over time</p>
                <Button
                  variant="link"
                  size="xs"
                  className="h-auto px-0 text-[11px]"
                  onClick={() => orbControls.openApp('overview')}
                >
                  See overview ›
                </Button>
              </div>
              {/* The chart fills whatever height is left — it can never push the
              footer, whatever the header and stats measure. */}
              <div className="relative mt-1 min-h-0 flex-1">
                {recent === null && !recentSettled ? (
                  <SkeletonBars className="absolute inset-0" />
                ) : recent === null || recent.daily.length === 0 ? (
                  <p className="text-muted-foreground grid h-full place-items-center text-[11.5px]">No spend yet.</p>
                ) : (
                  <DailySpendChart
                    data={recent.daily}
                    formatDate={formatChartDate}
                    formatValue={formatChartValue}
                    className={cn(FADE_IN, 'absolute inset-0 aspect-auto h-full')}
                  />
                )}
              </div>
            </div>
          </>
        )}
      </CardContent>

      <CardFooter className="border-border justify-between gap-2 px-3 py-2">
        <p className="text-muted-foreground min-w-0 truncate pl-1 text-[11px]">{peek ? BACKGROUNDED_PEEK : null}</p>
        <Button size="sm" className="shrink-0" onClick={() => orbControls.openApp()}>
          Open Watchtower
          <ExternalLink data-icon="inline-end" />
        </Button>
      </CardFooter>
    </Card>
  )
}

function IconAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            onClick={onClick}
            disabled={disabled}
            className="text-muted-foreground"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

/** A settled value that has nothing to show. */
function Empty() {
  return <span className="text-muted-foreground font-mono text-[16px]">—</span>
}
