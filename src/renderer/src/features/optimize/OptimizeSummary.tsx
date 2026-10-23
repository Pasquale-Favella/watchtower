import { Info } from 'lucide-react'

import { healthBar, healthClass } from '@/features/optimize/lib'
import { useCurrencyFormatter } from '@/shared/lib/use-currency-formatter'
import { cn } from '@/shared/lib/utils'

import type { OptimizePayload } from '../../../../shared/schemas/optimize.js'

type OptimizeSummaryProps = { payload: OptimizePayload }
type MetricProps = { label: string; value: string; detail: string; tone?: string }
type ProgressProps = { label: string; value: number; max: number; barClass: string }

function Progress({ label, value, max, barClass }: ProgressProps): React.JSX.Element {
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className="bg-muted h-1.5 w-full overflow-hidden rounded-full"
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-500', barClass)}
        style={{ width: `${percent}%` }}
      />
    </div>
  )
}

function Metric({ label, value, detail, tone }: MetricProps): React.JSX.Element {
  return (
    <div className="border-border bg-background/60 flex min-w-0 flex-col gap-1 rounded-lg border px-3.5 py-3">
      <span className="text-muted-foreground text-[10.5px] font-medium tracking-wide uppercase">{label}</span>
      <strong
        className={cn(
          'truncate font-mono text-[24px] leading-none font-semibold tabular-nums',
          tone ?? 'text-foreground',
        )}
      >
        {value}
      </strong>
      <span className="text-muted-foreground text-[10.5px] leading-snug">{detail}</span>
    </div>
  )
}

function SetupHealth({ summary }: { summary: OptimizePayload['summary'] }): React.JSX.Element {
  const { healthGrade, healthScore, setupCoverage } = summary
  return (
    <div className="border-border bg-background/60 flex min-w-0 flex-col gap-1.5 rounded-lg border px-3.5 py-3">
      <span className="text-muted-foreground text-[10.5px] font-medium tracking-wide uppercase">Setup health</span>
      {healthGrade !== null && healthScore !== null ? (
        <>
          <div className="flex items-baseline gap-2">
            <strong className={cn('font-mono text-[24px] leading-none font-semibold', healthClass(healthGrade))}>
              {healthGrade}
            </strong>
            <span className="text-muted-foreground font-mono text-[11px] tabular-nums">{healthScore}/100</span>
          </div>
          <Progress label="Setup health score" value={healthScore} max={100} barClass={healthBar(healthGrade)} />
          <span className="text-muted-foreground text-[10.5px] leading-snug">Based on setup findings only</span>
        </>
      ) : (
        <>
          <strong className="text-foreground text-[13px] leading-tight font-medium">Insufficient setup evidence</strong>
          <span className="text-muted-foreground text-[10.5px] leading-snug">No grade until setup is observed</span>
        </>
      )}
      <span className="text-muted-foreground mt-auto text-[10.5px] leading-snug">
        MCP inventory observed in {setupCoverage.observedSessions} of {setupCoverage.eligibleSessions} eligible sessions
      </span>
    </div>
  )
}

export function OptimizeSummary({ payload }: OptimizeSummaryProps): React.JSX.Element {
  const { formatUsd } = useCurrencyFormatter()
  const { summary, findings } = payload
  const highPriority = findings.filter(finding => finding.severity === 'high').length
  const findingDetail = highPriority > 0 ? `${highPriority} high priority` : 'None high priority'

  return (
    <div className="mb-4 flex flex-col gap-3">
      <div>
        <h2 className="text-foreground text-[14px] font-semibold">Review opportunities</h2>
        <p className="text-muted-foreground mt-0.5 text-[11px]">
          Observed patterns and modeled opportunities in the selected range.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Findings" value={String(summary.findingCount)} detail={findingDetail} />
        <Metric label="Scoped spend" value={formatUsd(summary.periodCostUSD)} detail="Total in the selected range" />
        <Metric
          label="Work sessions"
          value={String(summary.behaviorSessions)}
          detail={
            summary.excludedSidechainSessions > 0
              ? `${summary.excludedSidechainSessions} delegated excluded from comparisons`
              : 'Human-started sessions compared'
          }
        />
        <SetupHealth summary={summary} />
      </div>
      <div className="border-border bg-muted/40 text-muted-foreground flex items-start gap-2 rounded-md border px-3 py-2 text-[10.5px] leading-relaxed">
        <Info className="mt-px size-3.5 shrink-0" aria-hidden="true" />
        <p className="max-w-[760px]">
          Findings describe observed patterns and modeled opportunities. Associated spend shows the supporting sessions'
          cost; it is not an estimate of avoidable cost.
          {summary.excludedSidechainSessions > 0 &&
            ' Delegated sessions stay in spend and are excluded from standalone behavior comparisons.'}
        </p>
      </div>
    </div>
  )
}
