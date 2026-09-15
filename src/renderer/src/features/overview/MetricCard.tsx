import type { ReactNode } from 'react'

import { cn } from '@/shared/lib/utils'
import { Card } from '@/shared/components/ui/card'
import { InfoTip } from '@/shared/components/InfoTip'

/** MetricCard — a single-stat card, rebuilt on
 * the shadcn `Card` primitive: uppercase label, large tabular-nums value, an
 * optional caption, and an `accent` variant that highlights the value in the
 * app's brand color. With `subInline`, the caption sits on the value's
 * baseline instead of below it, for a two-row card. Pass `info` to append an
 * info icon with a tooltip explaining what the number means. */
export function MetricCard({
  label,
  value,
  sub,
  subInline,
  accent,
  className,
  info,
}: {
  label: ReactNode
  value: ReactNode
  sub?: ReactNode
  subInline?: boolean
  accent?: boolean
  className?: string
  info?: string
}) {
  const valueClassName = cn('truncate font-mono text-2xl font-semibold tracking-tight tabular-nums text-foreground', accent && 'text-primary')
  return (
    <Card className={cn('gap-0 rounded-lg border border-border bg-card px-4 py-3.5 shadow-[var(--card-shadow)] ring-0 [--card-spacing:0px]', className)}>
      <div className="flex min-w-0 items-center gap-1.5">
        <div className="truncate text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
        {info ? <InfoTip label={`About ${typeof label === 'string' ? label.toLowerCase() : 'this metric'}`} text={info} /> : null}
      </div>
      {sub && subInline ? (
        <div className="mt-1.5 flex min-w-0 items-baseline gap-2">
          <div className={cn(valueClassName, 'shrink-0')}>{value}</div>
          <div className="truncate text-[11px] text-muted-foreground">{sub}</div>
        </div>
      ) : (
        <>
          <div className={cn('mt-1.5', valueClassName)}>{value}</div>
          {sub ? <div className="mt-1 truncate text-[11px] text-muted-foreground">{sub}</div> : null}
        </>
      )}
    </Card>
  )
}
