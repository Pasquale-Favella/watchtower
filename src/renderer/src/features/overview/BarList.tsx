/** BarList — a ranked list of horizontal share-bars:
 * name, a proportional bar (gradient across the chart palette),
 * and a right-aligned value + percent-of-total. Used for "top N by cost"
 * breakdowns where a full chart would be overkill. */
export type BarItem = { name: string; value: number; display: string }

export function BarList({ items, total }: { items: BarItem[]; total?: number }) {
  if (!items.length) return <div className="py-8 text-center text-[11.5px] text-muted-foreground">No data.</div>
  const max = Math.max(...items.map(i => i.value), 1)
  return (
    <div className="flex flex-col gap-2.5">
      {items.map(item => {
        const pct = Math.max(2, Math.round((item.value / max) * 100))
        const share = total ? `${Math.round((item.value / total) * 100)}%` : ''
        return (
          <div key={item.name} className="grid grid-cols-[minmax(80px,130px)_1fr_auto] items-center gap-3 text-[12.5px]">
            <div className="truncate font-medium text-foreground">{item.name}</div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-brand"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="min-w-[88px] text-right font-mono text-[11.5px] tabular-nums text-muted-foreground">
              <span className="font-medium text-foreground">{item.display}</span> {share}
            </div>
          </div>
        )
      })}
    </div>
  )
}
