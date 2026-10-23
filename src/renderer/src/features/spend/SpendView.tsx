import { useAtomSet, useAtomValue } from '@effect/atom-react'
import { useMemo } from 'react'
import type { SankeyLinkProps, SankeyNodeProps } from 'recharts'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Sankey, Tooltip, XAxis, YAxis } from 'recharts'

import { scanStateAtom } from '@/app/atoms/scan'
import { overviewScopeAtom, providerAtom, setProviderAtom } from '@/app/atoms/scope'
import { useRemoteQuery } from '@/app/hooks/use-remote-query'
import { spendQuery } from '@/features/spend/atoms'
import {
  formatDayLabel,
  providerLabel,
  sankeyData,
  type SankeyNodeData,
  type SpendRow,
  stackedRows,
} from '@/features/spend/lib'
import { Panel } from '@/shared/components/Panel'
import { QueryErrorNotice } from '@/shared/components/QueryErrorNotice'
import { SegTabs } from '@/shared/components/SegTabs'
import { LoadingRegion, SkeletonBars, SkeletonCard } from '@/shared/components/skeletons'
import { isOtherNode, seriesColorForModel } from '@/shared/lib/modelSeries'
import { motionClass } from '@/shared/lib/motion'
import { keyOfScope } from '@/shared/lib/query-keys'
import { providerOptionsFromDetected } from '@/shared/lib/shell'
import { useCurrencyFormatter } from '@/shared/lib/use-currency-formatter'
import { cn } from '@/shared/lib/utils'

import type { SpendDayEntry, SpendFlow } from '../../../../shared/schemas/spend.js'

/** Projects have no model-series color, so segments cycle the theme's series
 * tokens, assigned deterministically by name so a project keeps its color
 * across charts and scope changes. */
const PROJECT_PALETTE = [
  'var(--color-s-opus)',
  'var(--color-s-fable)',
  'var(--color-s-sonnet)',
  'var(--color-s-haiku)',
  'var(--color-s-gpt)',
  'var(--color-s-other)',
]

function projectColorFor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash + name.charCodeAt(i)) % 997
  return PROJECT_PALETTE[hash % PROJECT_PALETTE.length] ?? 'var(--color-s-other)'
}

/** Model nodes use their series token; project nodes are neutral, and the
 * "Other" rollup always uses the other series token (matching the
 * Sankey layoutNodes fill rule). */
function colorForSankeyNode(name: string, kind: 'model' | 'project'): string {
  if (isOtherNode(name)) return 'var(--color-s-other)'
  return kind === 'model' ? seriesColorForModel(name) : 'var(--color-muted-foreground)'
}

function renderSankeyNode(props: SankeyNodeProps): React.JSX.Element {
  const { x, y, width, height } = props
  const node = props.payload as unknown as SankeyNodeData
  return <rect x={x} y={y} width={width} height={height} rx={2} fill={colorForSankeyNode(node.name, node.kind)} />
}

function renderSankeyLink(props: SankeyLinkProps): React.JSX.Element {
  const { sourceX, sourceY, sourceControlX, targetControlX, targetX, targetY, linkWidth, payload } = props
  const sourceName = (payload.source as { name?: string } | undefined)?.name ?? ''
  const d = `M${sourceX},${sourceY} C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`
  return (
    <path
      d={d}
      fill="none"
      stroke={seriesColorForModel(sourceName)}
      strokeOpacity={0.3}
      strokeWidth={Math.max(1, linkWidth)}
    />
  )
}

const tooltipStyle: React.CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: 12,
  color: 'var(--foreground)',
}

function DailyStackedChart({
  days,
  dataStart,
  colorFor,
  emptyText,
  provenance,
}: {
  days: SpendDayEntry[]
  dataStart: string | null
  colorFor: (name: string) => string
  emptyText: string
  provenance?: Map<string, string[]>
}) {
  const { formatConverted, formatUsd } = useCurrencyFormatter()
  const { rows, series } = useMemo(() => stackedRows(days), [days])
  const hasSpend = rows.some(row => series.some(name => Number(row[name] ?? 0) > 0))
  const leadingNoData = dataStart !== null && rows.length > 0 && rows[0]!.date < dataStart

  if (!hasSpend) {
    return <p className="text-muted-foreground py-3 text-center text-[11.5px]">{emptyText}</p>
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
              tickFormatter={formatDayLabel}
              axisLine={false}
              tickLine={false}
              minTickGap={40}
            />
            <YAxis
              tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
              tickFormatter={(value: number) => formatConverted(value).replace(/\.\d+$/, '')}
              axisLine={false}
              tickLine={false}
              width={42}
            />
            <Tooltip
              formatter={value => formatUsd(Number(value))}
              contentStyle={tooltipStyle}
              cursor={{ fill: 'var(--accent)' }}
            />
            {series.map(name => (
              <Bar
                key={name}
                name={name}
                dataKey={(row: SpendRow) => Number(row[name] ?? 0)}
                stackId="spend"
                fill={colorFor(name)}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      {series.length > 1 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1" aria-label="Legend">
          {series.map(name => {
            const raws = provenance?.get(name)
            return (
              <span
                key={name}
                className="text-muted-foreground inline-flex items-center gap-1.5 text-[10.5px]"
                title={raws?.length ? `includes ${raws.join(', ')}` : undefined}
              >
                <span className="size-2 rounded-[2px]" style={{ background: colorFor(name) }} aria-hidden="true" />
                {name}
                {raws?.length ? <span className="text-muted-foreground/80">· includes {raws.join(', ')}</span> : null}
              </span>
            )
          })}
        </div>
      )}
      {leadingNoData && (
        <p className="text-muted-foreground text-[10.5px]">
          Days before {formatDayLabel(dataStart ?? '')} recorded no activity.
        </p>
      )}
    </div>
  )
}

function SankeyFlow({ flow }: { flow: SpendFlow }) {
  const { formatUsd } = useCurrencyFormatter()
  const data = useMemo(() => sankeyData(flow), [flow])
  const merged = useMemo(() => flow.models.filter(node => node.sourceModels?.length), [flow])

  if (flow.links.length === 0) {
    return (
      <p className="text-muted-foreground py-3 text-center text-[11.5px]">No model-project flow in this range yet.</p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <Sankey
            data={data}
            node={renderSankeyNode}
            link={renderSankeyLink}
            nodePadding={18}
            nodeWidth={10}
            linkCurvature={0.5}
            margin={{ top: 4, right: 12, bottom: 4, left: 12 }}
          >
            <Tooltip formatter={value => formatUsd(Number(value))} contentStyle={tooltipStyle} />
          </Sankey>
        </ResponsiveContainer>
      </div>
      {merged.length > 0 && (
        <p className="text-muted-foreground text-[10.5px]">
          {merged.map(node => `${node.label} includes ${node.sourceModels!.join(', ')}`).join(' · ')}
        </p>
      )}
    </div>
  )
}

export function SpendView(): React.JSX.Element {
  const scope = useAtomValue(overviewScopeAtom)
  const { data: payload, error } = useRemoteQuery(spendQuery, scope, keyOfScope)
  const provider = useAtomValue(providerAtom)
  const setProvider = useAtomSet(setProviderAtom)
  const detectedProviders = useAtomValue(scanStateAtom).detectedProviders

  const providerOptions = useMemo(() => providerOptionsFromDetected(detectedProviders), [detectedProviders])
  const modelProvenance = useMemo(() => {
    const map = new Map<string, string[]>()
    if (!payload) return map
    for (const day of payload.byModel) {
      for (const seg of day.segments) {
        if (seg.sourceModels?.length && !map.has(seg.name)) map.set(seg.name, seg.sourceModels)
      }
    }
    for (const node of payload.flow.models) {
      if (node.sourceModels?.length && !map.has(node.id)) map.set(node.id, node.sourceModels)
    }
    return map
  }, [payload])

  return (
    <div className={cn('w-full max-w-[1180px]', motionClass('flex flex-col gap-3', 'section-fade'))}>
      {providerOptions.length > 1 && (
        <div className="flex justify-center">
          <SegTabs options={providerOptions} value={provider} onChange={setProvider} />
        </div>
      )}

      {payload === null ? (
        error ? (
          <QueryErrorNotice error={error} hasData={false} />
        ) : (
          <LoadingRegion label="Loading spend…" className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <SkeletonCard title>
                <SkeletonBars className="h-40" />
              </SkeletonCard>
              <SkeletonCard title>
                <SkeletonBars className="h-40" />
              </SkeletonCard>
            </div>
            <SkeletonCard title>
              <SkeletonBars className="h-44" />
            </SkeletonCard>
          </LoadingRegion>
        )
      ) : (
        <>
          <QueryErrorNotice error={error} hasData />
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Panel title="Daily spend by model" right={providerLabel(provider)}>
              <DailyStackedChart
                days={payload.byModel}
                dataStart={payload.dataStart}
                colorFor={seriesColorForModel}
                emptyText="No model spend in this range yet."
                provenance={modelProvenance}
              />
            </Panel>
            <Panel title="Daily spend by project">
              <DailyStackedChart
                days={payload.byProject}
                dataStart={payload.dataStart}
                colorFor={projectColorFor}
                emptyText="No project spend in this range yet."
              />
            </Panel>
          </div>

          <Panel title="Cost flow · model → project" right="Model → project spend by cost">
            <SankeyFlow flow={payload.flow} />
          </Panel>
        </>
      )}
    </div>
  )
}
