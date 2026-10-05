import { cn } from '@/shared/lib/utils'
import { Card } from '@/shared/components/ui/card'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { SkeletonBars } from '@/shared/components/skeletons'
import { formatUsd } from '@/shared/lib/models'
import { navigateToSection } from '@/app/navigation'
import type { OverviewPayload } from '../../../../shared/schemas/overview.js'
import { Sparkline } from '@/features/overview/Sparkline'
import { EfficiencyGauge } from '@/features/overview/EfficiencyGauge'
import { formatChartDate, spendTrend } from '@/features/overview/lib'

function formatCount(unit: string): (v: number) => string {
  return (v: number) => `${Math.round(v).toLocaleString('en-US')} ${unit}`
}

function HeroShell({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <Card
      className={cn(
        'border-border bg-card gap-0 rounded-xl border p-4 shadow-[var(--card-shadow)] ring-0 [--card-spacing:0px] sm:p-5',
        className,
      )}
    >
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
    <HeroShell className="lg:col-span-3">
      <p className="text-muted-foreground text-[11px] font-medium tracking-wider uppercase">Total spend</p>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-primary font-mono text-[34px] leading-none font-bold tracking-tight tabular-nums">
          {formatUsd(total)}
        </span>
        {trend !== null && (
          <span
            className={cn(
              'text-[12px] font-medium tabular-nums',
              trend >= 0 ? 'text-muted-foreground' : 'text-primary',
            )}
          >
            {trend >= 0 ? '+' : ''}
            {Math.round(trend * 100)}% this week
          </span>
        )}
      </div>

      <div className="mt-3">
        <Sparkline
          data={payload.daily.map(d => ({ v: d.costUSD, label: formatChartDate(d.date) }))}
          height={52}
          formatValue={(v: number) => `${formatUsd(v)} spend`}
        />
        <p className="text-muted-foreground mt-1 text-[10.5px]">Daily spend · last {payload.daily.length} days</p>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div>
          <p className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">
            Portion priced from estimates
          </p>
          <p className="text-foreground mt-0.5 font-mono text-[16px] font-semibold tabular-nums">
            {formatUsd(estimated)}{' '}
            <span className="text-muted-foreground font-sans text-[11px] font-normal">Estimates</span>
          </p>
        </div>
        <div>
          <p className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">Via local models</p>
          <p className="text-foreground mt-0.5 font-mono text-[16px] font-semibold tabular-nums">
            {formatUsd(saved)} <span className="text-muted-foreground font-sans text-[11px] font-normal">Local</span>
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
    <HeroShell className="lg:col-span-2">
      <div className="grid grid-cols-2 gap-3">
        <button type="button" onClick={() => navigateToSection('sessions')} className="group min-w-0 text-left">
          <p className="text-muted-foreground text-[11px] font-medium tracking-wider uppercase">Sessions</p>
          <p className="text-foreground group-hover:text-primary mt-0.5 truncate font-mono text-[24px] leading-none font-bold tabular-nums">
            {payload.kpis.sessions.toLocaleString('en-US')}
          </p>
          <Sparkline
            data={payload.daily.map(d => ({ v: d.sessions, label: formatChartDate(d.date) }))}
            height={34}
            className="mt-1.5"
            formatValue={formatCount('sessions')}
          />
        </button>
        <button type="button" onClick={() => navigateToSection('sessions')} className="group min-w-0 text-left">
          <p className="text-muted-foreground text-[11px] font-medium tracking-wider uppercase">Calls</p>
          <p className="text-foreground group-hover:text-primary mt-0.5 truncate font-mono text-[24px] leading-none font-bold tabular-nums">
            {payload.kpis.calls.toLocaleString('en-US')}
          </p>
          <Sparkline
            data={payload.daily.map(d => ({ v: d.calls, label: formatChartDate(d.date) }))}
            height={34}
            className="mt-1.5"
            formatValue={formatCount('calls')}
          />
        </button>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">One-shot success rate</p>
          <p className="text-foreground mt-1 font-mono text-[30px] leading-none font-bold tabular-nums">
            {rate === null ? '—' : `${Math.round(rate * 100)}%`}
          </p>
          <p className="text-muted-foreground mt-1.5 text-[10px] font-medium tracking-wide uppercase">
            Edits landed on first try
          </p>
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
      <div className="border-border bg-card rounded-xl border p-4 sm:p-5 lg:col-span-3">
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
      <div className="border-border bg-card rounded-xl border p-4 sm:p-5 lg:col-span-2">
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
