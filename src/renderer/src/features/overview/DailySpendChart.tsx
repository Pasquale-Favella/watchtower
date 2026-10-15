import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from 'recharts'

import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/shared/components/ui/chart'
import type { OverviewDailyEntry } from '../../../../shared/schemas/overview.js'

/** Single-series daily-spend bar chart config (shadcn `ChartContainer`). The
 * key matches the Bar's `name`, so the tooltip row labels it "Spend". */
const overviewChartConfig = {
  spend: {
    label: 'Spend',
    color: 'var(--primary)',
  },
} satisfies ChartConfig

/** Daily spend as a shadcn-wrapped recharts bar chart — the capsule strip
 * from the wireframes, re-expressed with the shadcn chart primitives so the
 * Overview's "Spend over time" panel follows the same directives as the rest
 * of the app. Keeps the capsule's visual grammar: the peak day lifts into
 * brand, the second-highest gets a brand tint, the rest stay muted bars. */
export function DailySpendChart({
  data,
  formatDate,
  formatValue,
}: {
  data: OverviewDailyEntry[]
  formatDate: (dateKey: string) => string
  formatValue: (n: number) => string
}) {
  if (!data.length) return null

  const ranked = data.map((d, i) => ({ i, v: d.costUSD })).sort((a, b) => b.v - a.v)
  const peak = ranked[0] && ranked[0].v > 0 ? ranked[0].i : -1
  const second = ranked[1] && ranked[1].v > 0 ? ranked[1].i : -1

  return (
    <ChartContainer config={overviewChartConfig} className="h-48 w-full">
      <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
          tickFormatter={formatDate}
          axisLine={false}
          tickLine={false}
          minTickGap={40}
        />
        <YAxis
          tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
          tickFormatter={(value: number) => formatValue(value)}
          axisLine={false}
          tickLine={false}
          width={42}
        />
        <ChartTooltip
          cursor={{ fill: 'var(--accent)' }}
          content={
            <ChartTooltipContent
              labelFormatter={label => formatDate(String(label))}
              formatter={(value, _name, item) => {
                const entry = item?.payload as OverviewDailyEntry | undefined
                return (
                  <span className="inline-flex items-center gap-2">
                    <span className="bg-primary size-2 shrink-0 rounded-[2px]" aria-hidden="true" />
                    <span className="text-muted-foreground">Spend</span>
                    <span className="text-foreground font-mono font-semibold tabular-nums">
                      {formatValue(Number(value))}
                    </span>
                    {entry && entry.calls > 0 && (
                      <span className="text-muted-foreground">
                        {entry.calls} {entry.calls === 1 ? 'call' : 'calls'}
                      </span>
                    )}
                  </span>
                )
              }}
            />
          }
        />
        <Bar dataKey="costUSD" name="spend" radius={[3, 3, 0, 0]} maxBarSize={14}>
          {data.map((d, i) => (
            <Cell
              key={d.date}
              fill={i === peak ? 'var(--primary)' : i === second ? 'var(--primary)' : 'var(--muted)'}
              fillOpacity={i === peak ? 1 : i === second ? 0.4 : 1}
            />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  )
}
