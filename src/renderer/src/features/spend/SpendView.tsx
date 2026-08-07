import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Sankey, Tooltip, XAxis, YAxis } from 'recharts'
import type { SankeyLinkProps, SankeyNodeProps } from 'recharts'
import { cn } from '@/shared/lib/utils'
import { Panel } from '@/shared/components/Panel'
import { SegTabs } from '@/shared/components/SegTabs'
import { motionClass } from '@/shared/lib/motion'
import { providerOptionsFromDetected } from '@/shared/lib/shell'
import { formatDayLabel, providerLabel, sankeyData, stackedRows, type SpendRow, type SankeyNodeData } from '@/features/spend/lib'
import { isOtherNode, seriesColorForModel } from '@/shared/lib/modelSeries'
import { formatUsd, formatConverted } from '@/shared/lib/models'
import { ErrorPanel } from '@/shared/components/ErrorPanel'
import { useSpendStore } from '@/features/spend/store'
import { selectScope, useShellStore } from '@/app/stores/shell-store'
import { useScanStore } from '@/app/stores/scan-store'
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
  return kind === 'model' ? seriesColorForModel(name) : 'var(--color-mut2)'
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
  background: 'var(--panel)',
  border: '1px solid var(--line)',
  borderRadius: 8,
  fontSize: 12,
  color: 'var(--ink)',
}

function DailyStackedChart({
  days,
  dataStart,
  colorFor,
  emptyText,
}: {
  days: SpendDayEntry[]
  dataStart: string | null
  colorFor: (name: string) => string
  emptyText: string
}) {
  const { rows, series } = useMemo(() => stackedRows(days), [days])
  const hasSpend = rows.some(row => series.some(name => Number(row[name] ?? 0) > 0))
  const leadingNoData = dataStart !== null && rows.length > 0 && rows[0]!.date < dataStart

  if (!hasSpend) {
    return <p className="py-3 text-center text-[11.5px] text-muted-foreground">{emptyText}</p>
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--line2)" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: 'var(--mut2)' }}
              tickFormatter={formatDayLabel}
              axisLine={false}
              tickLine={false}
              minTickGap={40}
            />
            <YAxis tick={{ fontSize: 11, fill: 'var(--mut2)' }} tickFormatter={(value: number) => formatConverted(value).replace(/\.\d+$/, '')} axisLine={false} tickLine={false} width={42} />
            <Tooltip
              formatter={(value) => formatUsd(Number(value))}
              contentStyle={tooltipStyle}
              cursor={{ fill: 'var(--hover)' }}
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
          {series.map(name => (
            <span key={name} className="inline-flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
              <span className="size-2 rounded-[2px]" style={{ background: colorFor(name) }} aria-hidden="true" />
              {name}
            </span>
          ))}
        </div>
      )}
      {leadingNoData && (
        <p className="text-[10.5px] text-mut2">Days before {formatDayLabel(dataStart ?? '')} recorded no activity.</p>
      )}
    </div>
  )
}

function SankeyFlow({ flow }: { flow: SpendFlow }) {
  const data = useMemo(() => sankeyData(flow), [flow])

  if (flow.links.length === 0) {
    return <p className="py-3 text-center text-[11.5px] text-muted-foreground">No model-project flow in this range yet.</p>
  }

  return (
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
          <Tooltip
            formatter={(value) => formatUsd(Number(value))}
            contentStyle={tooltipStyle}
          />
        </Sankey>
      </ResponsiveContainer>
    </div>
  )
}

export function SpendView(): React.JSX.Element {
  const scope = useShellStore(useShallow(selectScope))
  const payload = useSpendStore(s => s.data)
  const error = useSpendStore(s => s.error)
  const load = useSpendStore(s => s.load)
  const provider = useShellStore(s => s.provider)
  const setProvider = useShellStore(s => s.setProvider)
  const detectedProviders = useScanStore(s => s.detectedProviders)

  useEffect(() => {
    void load(scope)
  }, [load, scope])

  const providerOptions = useMemo(() => providerOptionsFromDetected(detectedProviders), [detectedProviders])

  return (
    <div className={cn('w-full max-w-[1180px]', motionClass('flex flex-col gap-3', 'section-fade'))}>
      {providerOptions.length > 1 && (
        <div className="flex justify-center">
          <SegTabs options={providerOptions} value={provider} onChange={setProvider} />
        </div>
      )}

      {payload === null ? (
        error ? <ErrorPanel message={error} /> : (
          <div className="rounded-lg border border-border bg-card px-3.5 py-6 text-[12px] text-muted-foreground">Loading spend…</div>
        )
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Panel title="Daily spend by model" right={providerLabel(provider)}>
              <DailyStackedChart
                days={payload.byModel}
                dataStart={payload.dataStart}
                colorFor={seriesColorForModel}
                emptyText="No model spend in this range yet."
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
