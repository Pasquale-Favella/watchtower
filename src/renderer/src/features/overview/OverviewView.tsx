import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { cn } from '@/shared/lib/utils'
import { Panel } from '@/shared/components/Panel'
import { BarList, type BarItem } from '@/features/overview/BarList'
import { DailySpendChart } from '@/features/overview/DailySpendChart'
import { KpiBento, KpiBentoSkeleton } from '@/features/overview/KpiBento'
import { motionClass } from '@/shared/lib/motion'
import { formatUsd, formatConverted } from '@/shared/lib/models'
import { ErrorPanel } from '@/shared/components/ErrorPanel'
import { LoadingRegion, SkeletonCard, SkeletonLines, SkeletonBars } from '@/shared/components/skeletons'
import { useOverviewStore } from '@/features/overview/store'
import { selectScope, useScopeStore } from '@/app/stores/scope-store'
import { navigateToSection } from '@/app/navigation'
import type { OverviewPayload } from '../../../../shared/schemas/overview.js'

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function formatRate(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`
}

function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 1000)}s`
}

function formatChartDate(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Date(year, (month ?? 1) - 1, day ?? 1).toLocaleString('en-US', { month: 'short', day: 'numeric' })
}

function emptyNote(text: string) {
  return <p className="text-muted-foreground py-3 text-center text-[11.5px]">{text}</p>
}

function ModelsTable({ payload }: { payload: OverviewPayload }) {
  if (!payload.models.length) return emptyNote('No model usage in this range yet.')
  return (
    <div className="flex flex-col">
      {payload.models.map(model => (
        <div key={model.name} className="border-border flex items-center gap-3 border-t py-1.5 first:border-t-0">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-medium">{model.name}</span>
            {model.sourceModels?.length ? (
              <span
                className="text-muted-foreground block truncate text-[10.5px]"
                title={model.sourceModels.join(', ')}
              >
                includes {model.sourceModels.join(', ')}
              </span>
            ) : null}
          </span>
          <span className="text-muted-foreground w-14 text-right font-mono text-[11px] tabular-nums">
            {formatCompact(model.inputTokens)}
          </span>
          <span className="text-muted-foreground w-14 text-right font-mono text-[11px] tabular-nums">
            {formatCompact(model.outputTokens)}
          </span>
          <span className="text-foreground w-12 text-right font-mono text-[11.5px] tabular-nums">
            {model.calls.toLocaleString('en-US')}
          </span>
          <span className="w-16 text-right font-mono text-[11.5px] tabular-nums">{formatUsd(model.cost)}</span>
        </div>
      ))}
    </div>
  )
}

function ActivitiesPanel({ payload }: { payload: OverviewPayload }) {
  if (!payload.activities.length) return emptyNote('No activity in this range yet.')
  const items: BarItem[] = payload.activities.map(activity => ({
    name: activity.name,
    value: activity.cost,
    display: formatUsd(activity.cost),
  }))
  return <BarList items={items} total={payload.kpis.cost} />
}

function EfficiencyPanel({ payload }: { payload: OverviewPayload }) {
  const eff = payload.efficiency
  const cachePct = Math.round(payload.kpis.cacheHitPercent)
  const pricingPct = Math.min(99, Math.round(eff.pricingCoverage * 100))
  const grade = eff.grade
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-muted-foreground text-[11px] font-medium">Efficiency score</div>
          <div className="text-foreground font-mono text-[20px] font-semibold tabular-nums">
            {Math.round(eff.score)} / 100
          </div>
        </div>
        <div
          className={cn(
            'rounded-md px-2 py-1 font-mono text-[15px] font-semibold',
            grade === 'A+' || grade === 'A' ? 'text-primary' : grade === 'F' ? 'text-destructive' : 'text-foreground',
          )}
        >
          {grade}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11.5px]">
        <span className="text-muted-foreground">
          One-shot <strong className="text-foreground">{formatRate(eff.oneShotRate)}</strong>
        </span>
        <span className="text-muted-foreground">
          Cache hit <strong className="text-foreground">{cachePct}%</strong>
        </span>
        <span className="text-muted-foreground">
          Retry tax <strong className="text-foreground">{formatUsd(eff.retryTax.totalUSD)}</strong>
        </span>
      </div>
      {eff.routingWaste.totalSavingsUSD > 0 && (
        <p className="text-muted-foreground text-[11.5px]">
          Routing to <strong className="text-foreground">{eff.routingWaste.baselineModel}</strong> could save{' '}
          <strong className="text-foreground">{formatUsd(eff.routingWaste.totalSavingsUSD)}</strong> this period.
        </p>
      )}
      <p className="text-muted-foreground text-[11px]">
        {pricingPct}% of spend priced · composite of one-shot, cache hit, and retry tax.
      </p>
    </div>
  )
}

function workflowCoachingNote(payload: OverviewPayload): string | null {
  const wf = payload.workflow
  const reworked = wf.topReworkedFiles[0]
  if (wf.correctionRate !== null && wf.correctionRate >= 0.15 && wf.corrections >= 3) {
    return `You corrected the assistant on ${Math.round(wf.correctionRate * 100)}% of prompts (${wf.corrections} times). State the requirements in the first message to cut the back and forth.`
  }
  if (reworked && reworked.sessions >= 3) {
    return `${reworked.path} was reworked across ${reworked.sessions} sessions (${reworked.edits} edits). A focused pass on it may cost less than the repeated churn.`
  }
  if (wf.medianTimeToFirstEditMs !== null && wf.medianTimeToFirstEditMs >= 5 * 60 * 1000) {
    return `Median time to first edit is ${formatDuration(wf.medianTimeToFirstEditMs)}. Point the assistant at the target file to cut the exploration before it starts editing.`
  }
  return null
}

function WorkflowPanel({ payload }: { payload: OverviewPayload }) {
  const wf = payload.workflow
  const reworked = wf.topReworkedFiles[0]
  const hasSignal =
    wf.correctionRate !== null || wf.medianTimeToFirstEditMs !== null || wf.corrections > 0 || !!reworked
  if (!hasSignal) return emptyNote('No workflow signal in this range yet.')
  const note = workflowCoachingNote(payload)
  const coverage = payload.efficiency.pricingCoverage
  const showCoverage = typeof coverage === 'number' && coverage < 1
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11.5px]">
        <span className="text-muted-foreground">
          Correction rate <strong className="text-foreground">{formatRate(wf.correctionRate)}</strong>
          {wf.corrections > 0 && (
            <span className="text-muted-foreground">
              {' '}
              · {wf.corrections} {wf.corrections === 1 ? 'correction' : 'corrections'}
            </span>
          )}
        </span>
        <span className="text-muted-foreground">
          Time to first edit{' '}
          <strong className="text-foreground">
            {wf.medianTimeToFirstEditMs === null ? '—' : formatDuration(wf.medianTimeToFirstEditMs)}
          </strong>
        </span>
        {showCoverage && (
          <span className="border-border text-muted-foreground rounded border px-1.5 py-0.5 text-[10px]">
            {Math.min(99, Math.round(coverage * 100))}% priced
          </span>
        )}
      </div>
      {reworked && (
        <p className="text-muted-foreground text-[11.5px]">
          Top rework: <strong className="text-foreground">{reworked.path}</strong> · {reworked.sessions}{' '}
          {reworked.sessions === 1 ? 'session' : 'sessions'} · {reworked.edits}{' '}
          {reworked.edits === 1 ? 'edit' : 'edits'}
        </p>
      )}
      <p className="text-muted-foreground text-[11px]">
        {note ?? 'Corrections, first-edit latency, and file churn across your sessions.'}
      </p>
    </div>
  )
}

function BreakdownPanel({ payload }: { payload: OverviewPayload }) {
  const rows: Array<{ label: string; name: string; detail: string }> = [
    ...payload.tools.map(t => ({ label: 'Tools', name: t.name, detail: `${t.calls} calls` })),
    ...payload.mcpServers.map(m => ({ label: 'MCP', name: m.name, detail: `${m.calls} calls` })),
    ...payload.skills.map(s => ({ label: 'Skills', name: s.name, detail: `${s.turns} turns · ${formatUsd(s.cost)}` })),
    ...payload.subagents.map(s => ({
      label: 'Subagents',
      name: s.name,
      detail: `${s.calls} calls · ${formatUsd(s.cost)}`,
    })),
  ]
  if (!rows.length) return emptyNote('No breakdown data in this range yet.')
  return (
    <div className="flex flex-col">
      {rows.map(row => (
        <div
          key={`${row.label}:${row.name}`}
          className="border-border flex items-center gap-3 border-t py-1 first:border-t-0"
        >
          <span className="text-muted-foreground w-16 shrink-0 text-[10.5px] font-medium tracking-wide uppercase">
            {row.label}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{row.name}</span>
          <span className="text-muted-foreground shrink-0 text-[11px]">{row.detail}</span>
        </div>
      ))}
    </div>
  )
}

function LocalSavingsPanel({ payload }: { payload: OverviewPayload }) {
  const savings = payload.localModelSavings
  if (!savings.totalUSD) return emptyNote('No local-model savings in this range yet.')
  return (
    <div className="flex flex-col gap-1">
      <div className="border-border flex items-baseline justify-between border-b pb-2">
        <span className="text-muted-foreground text-[11px] font-medium">Saved via local models</span>
        <strong className="text-foreground font-mono text-[16px] tabular-nums">{formatUsd(savings.totalUSD)}</strong>
      </div>
      {savings.byModel.map(model => (
        <div key={model.name} className="flex items-center justify-between py-1 text-[11.5px]">
          <span className="text-foreground truncate">{model.name}</span>
          <span className="text-muted-foreground">
            {model.calls} {model.calls === 1 ? 'call' : 'calls'} · {formatUsd(model.savingsUSD)} saved
          </span>
        </div>
      ))}
    </div>
  )
}

export function OverviewView() {
  const scope = useScopeStore(useShallow(selectScope))
  const payload = useOverviewStore(s => s.data)
  const error = useOverviewStore(s => s.error)
  const load = useOverviewStore(s => s.load)

  // Store-driven load (ADR 0011): the store owns fetching — same-scope
  // refetches (refresh tick) keep the last-known payload (true SWR), scope
  // changes clear to a fresh load.
  useEffect(() => {
    void load(scope)
  }, [load, scope])

  const chartData = useMemo(() => payload?.daily ?? [], [payload])
  const topModel = payload?.models[0]

  return (
    <div className={cn('w-full max-w-[1180px]', motionClass('flex flex-col gap-4', 'section-fade'))}>
      {payload === null ? (
        error ? (
          <ErrorPanel message={error} />
        ) : (
          <LoadingRegion label="Loading overview…" className="flex flex-col gap-4">
            <KpiBentoSkeleton />
            <SkeletonCard title>
              <SkeletonBars className="h-40" />
            </SkeletonCard>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <SkeletonCard title>
                <SkeletonLines lines={5} />
              </SkeletonCard>
              <SkeletonCard title>
                <SkeletonLines lines={5} />
              </SkeletonCard>
            </div>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <SkeletonCard title>
                <SkeletonLines lines={4} />
              </SkeletonCard>
              <SkeletonCard title>
                <SkeletonLines lines={4} />
              </SkeletonCard>
            </div>
          </LoadingRegion>
        )
      ) : (
        <>
          <KpiBento payload={payload} />

          <Panel title="Spend over time" right={topModel ? `Biggest driver: ${topModel.name}` : 'No model driver yet'}>
            {chartData.length === 0 ? (
              emptyNote('No spend yet.')
            ) : (
              <DailySpendChart
                data={chartData}
                formatDate={formatChartDate}
                formatValue={(v: number) => formatConverted(v).replace(/\.\d+$/, '')}
              />
            )}
            {payload.dataStart !== null && (chartData[0]?.date ?? '') < payload.dataStart && (
              <p className="text-muted-foreground mt-1.5 text-[10.5px]">
                Days before {formatChartDate(payload.dataStart)} recorded no activity.
              </p>
            )}
          </Panel>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel
              title="Top models"
              right={
                <button type="button" className="text-primary font-medium" onClick={() => navigateToSection('models')}>
                  See all ›
                </button>
              }
            >
              <ModelsTable payload={payload} />
            </Panel>
            <Panel title="Top activities" right="Sorted by cost">
              <ActivitiesPanel payload={payload} />
            </Panel>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel title="Efficiency">
              <EfficiencyPanel payload={payload} />
            </Panel>
            <Panel title="Workflow">
              <WorkflowPanel payload={payload} />
            </Panel>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel title="Breakdown" right="Tools · MCP · skills · subagents">
              <BreakdownPanel payload={payload} />
            </Panel>
            <Panel title="Local model savings">
              <LocalSavingsPanel payload={payload} />
            </Panel>
          </div>
        </>
      )}
    </div>
  )
}
