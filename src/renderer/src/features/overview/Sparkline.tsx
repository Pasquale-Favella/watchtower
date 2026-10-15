import { useId } from 'react'
import { Area, AreaChart, ResponsiveContainer, Tooltip } from 'recharts'

/** A labeled sparkline point: `v` plots, `label` names the day in tooltips. */
export type SparkPoint = { v: number; label: string }

function SparkTooltip({
  active,
  payload,
  formatValue,
}: {
  active?: boolean
  payload?: Array<{ payload: SparkPoint }>
  formatValue: (v: number) => string
}) {
  if (!active || !payload?.length) return null
  const point = payload[0]?.payload
  if (!point) return null
  return (
    <div className="border-border bg-popover rounded-md border px-2 py-1 shadow-md">
      <p className="text-muted-foreground text-[10.5px] whitespace-nowrap">{point.label}</p>
      <p className="text-foreground font-mono text-[12px] font-semibold tabular-nums">{formatValue(point.v)}</p>
    </div>
  )
}

/** Sparkline — a tiny recharts area trend with a hover tooltip (day +
 * formatted value) so each bento mini-chart reads precisely.
 * Used inside the Overview bento hero cards (spend / sessions / calls).
 * Renders a flat muted strip when every point is zero so empty ranges
 * don't look broken. */
export function Sparkline({
  data,
  height = 36,
  className,
  formatValue,
}: {
  data: SparkPoint[]
  height?: number
  className?: string
  formatValue?: (v: number) => string
}) {
  const gradientId = useId().replace(/:/g, '')
  const fmt = formatValue ?? ((v: number) => String(v))
  const hasSignal = data.some(p => p.v > 0)

  if (!hasSignal) {
    return (
      <div className={className} style={{ height }} aria-hidden="true">
        <div className="flex h-full items-end gap-[3px]">
          {data.slice(-24).map((_, i) => (
            <div key={i} className="bg-muted h-[3px] w-full min-w-[2px] rounded-full" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className={className} style={{ height }} aria-hidden="true">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--primary)" stopOpacity={0.04} />
            </linearGradient>
          </defs>
          <Tooltip
            content={<SparkTooltip formatValue={fmt} />}
            cursor={{ stroke: 'var(--border)', strokeWidth: 1 }}
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="v"
            stroke="var(--primary)"
            strokeWidth={1.8}
            fill={`url(#${gradientId})`}
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
