import { cn } from '@/shared/lib/utils'
import { Card } from '@/shared/components/ui/card'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { SkeletonBars } from '@/shared/components/skeletons'
import { formatUsd } from '@/shared/lib/models'
import { navigateToSection } from '@/app/navigation'
import type { OverviewPayload } from '../../../../shared/schemas/overview.js'
import { Sparkline } from '@/features/overview/Sparkline'
import { EfficiencyGauge } from '@/features/overview/EfficiencyGauge'

/** Week-over-week spend delta from the daily series (last 7 vs prior 7).
 * Null when there isn't enough history — the hero then hides the badge
 * instead of inventing a trend. */
function spendTrend(daily: OverviewPayload['daily']): number | null {
  if (daily.length < 14) return null
  const last = daily.slice(-7).reduce((s, d) => s + d.costUSD, 0)
  const prev = daily.slice(-14, -7).reduce((s, d) => s + d.costUSD, 0)
  if (prev <= 0) return last > 0 ? 1 : null
  return (last - prev) / prev
}

/** Short day label for sparkline tooltips ("Jul 3"). */
function formatDayLabel(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Date(year, (month ?? 1) - 1, day ?? 1).toLocaleString('en-US', { month: 'short', day: 'numeric' })
}

function formatCount(unit: string): (v: number) => string {
  return (v: number) => `${Math.round(v).toLocaleString('en-US')} ${unit}`
}

function HeroShell({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <Card className={cn('gap-0 rounded-xl border border-border bg-card p-4 shadow-[var(--card-shadow)] ring-0 [--card-spacing:0px] sm:p-5', className)}>
      {children}
    </Card>
  )
}

/** Spend hero (left): big total + WoW badge, a daily-cost area sparkline,
 * and the estimates / local-models breakdown as flat sections. Covers the
 * old "Total spend", "Estimated" and "Saved" metric cards without loss. */
function SpendHero({ payload }: { payload: OverviewPayload }) {
  const trend = spendTrend(payload.daily)
  const estimated = payload.kpis.estimatedCostUSD
  const saved = payload.kpis.savingsUSD
  const total = payload.kpis.cost

  return (
    <HeroShell
      className="lg:col-span-3"
    >
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Total spend</p>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono text-[34px] font-bold leading-none tracking-tight tabular-nums text-primary">
          {formatUsd(total)}
        </span>
        {trend !== null && (
          <span className={cn('text-[12px] font-medium tabular-nums', trend >= 0 ? 'text-muted-foreground' : 'text-primary')}>
            {trend >= 0 ? '+' : ''}{Math.round(trend * 100)}% this week
          </span>
        )}
      </div>

      <div className="mt-3">
        <Sparkline
          data={payload.daily.map(d => ({ v: d.costUSD, label: formatDayLabel(d.date) }))}
          height={52}
          formatValue={(v: number) => `${formatUsd(v)} spend`}
        />
        <p className="mt-1 text-[10.5px] text-muted-foreground">Daily spend · last {payload.daily.length} days</p>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div>
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Portion priced from estimates
            </p>
            <p className="mt-0.5 font-mono text-[16px] font-semibold tabular-nums text-foreground">
              {formatUsd(estimated)} <span className="font-sans text-[11px] font-normal text-muted-foreground">Estimates</span>
            </p>
          </div>
          <div>
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Via local models</p>
            <p className="mt-0.5 font-mono text-[16px] font-semibold tabular-nums text-foreground">
              {formatUsd(saved)} <span className="font-sans text-[11px] font-normal text-muted-foreground">Local</span>
            </p>
          </div>
      </div>
    </HeroShell>
  )
}

/** Usage + efficiency hero (right): sessions / calls with area sparklines
 * up top, one-shot rate with a recharts gauge below — the mock's right
 * card. Covers the old "Sessions", "Calls" and "One-shot" metric cards. */
function EfficiencyHero({ payload }: { payload: OverviewPayload }) {
  const rate = payload.kpis.oneShotRate
  return (
    <HeroShell
      className="lg:col-span-2"
    >
      <div className="grid grid-cols-2 gap-3">
        <button type="button" onClick={() => navigateToSection('sessions')} className="group min-w-0 text-left">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Sessions</p>
          <p className="mt-0.5 truncate font-mono text-[24px] font-bold leading-none tabular-nums text-foreground group-hover:text-primary">
            {payload.kpis.sessions.toLocaleString('en-US')}
          </p>
          <Sparkline
            data={payload.daily.map(d => ({ v: d.sessions, label: formatDayLabel(d.date) }))}
            height={34}
            className="mt-1.5"
            formatValue={formatCount('sessions')}
          />
        </button>
        <button type="button" onClick={() => navigateToSection('sessions')} className="group min-w-0 text-left">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Calls</p>
          <p className="mt-0.5 truncate font-mono text-[24px] font-bold leading-none tabular-nums text-foreground group-hover:text-primary">
            {payload.kpis.calls.toLocaleString('en-US')}
          </p>
          <Sparkline
            data={payload.daily.map(d => ({ v: d.calls, label: formatDayLabel(d.date) }))}
            height={34}
            className="mt-1.5"
            formatValue={formatCount('calls')}
          />
        </button>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">One-shot success rate</p>
          <p className="mt-1 font-mono text-[30px] font-bold leading-none tabular-nums text-foreground">
            {rate === null ? '—' : `${Math.round(rate * 100)}%`}
          </p>
          <p className="mt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Edits landed on first try</p>
        </div>
        <EfficiencyGauge value={rate} />
      </div>
    </HeroShell>
  )
}

/** KpiBento — the Overview's six KPI cards re-expressed as the reference
 * mock's two-cell bento: spend hero + efficiency hero, with recharts
 * sparklines and a one-shot gauge. No metric is dropped: total / estimated
 * / saved live in the left card, sessions / calls / one-shot in the right. */
export function KpiBento({ payload }: { payload: OverviewPayload }) {
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-5">
      <SpendHero payload={payload} />
      <EfficiencyHero payload={payload} />
    </div>
  )
}

/** KpiBentoSkeleton — loading placeholder mirroring the bento's two hero
 * cells (same grid spans and block heights) so the layout doesn't jump
 * when the payload arrives. */
export function KpiBentoSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-5">
      <div className="rounded-xl border border-border bg-card p-4 sm:p-5 lg:col-span-3">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="mt-1.5 h-9 w-44" />
        <SkeletonBars className="mt-3 h-[52px]" />
        <Skeleton className="mt-2 h-3 w-40" />
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div>
            <Skeleton className="h-3 w-36" />
            <Skeleton className="mt-1.5 h-5 w-24" />
          </div>
          <div>
            <Skeleton className="h-3 w-28" />
            <Skeleton className="mt-1.5 h-5 w-24" />
          </div>
        </div>
      </div>
      <div className="rounded-xl border border-border bg-card p-4 sm:p-5 lg:col-span-2">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Skeleton className="h-3 w-16" />
            <Skeleton className="mt-1.5 h-6 w-20" />
            <SkeletonBars className="mt-1.5 h-[34px]" />
          </div>
          <div>
            <Skeleton className="h-3 w-16" />
            <Skeleton className="mt-1.5 h-6 w-20" />
            <SkeletonBars className="mt-1.5 h-[34px]" />
          </div>
        </div>
      <div className="mt-3 flex items-center justify-between gap-3">
          <div>
            <Skeleton className="h-3 w-28" />
            <Skeleton className="mt-2 h-8 w-24" />
            <Skeleton className="mt-2 h-3 w-32" />
          </div>
          <Skeleton className="h-[92px] w-[160px] shrink-0 rounded-t-full" />
        </div>
      </div>
    </div>
  )
}
