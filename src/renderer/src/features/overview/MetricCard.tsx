import type { ReactNode } from 'react'

import { cn } from '@/shared/lib/utils'
import { Card } from '@/shared/components/ui/card'

/** MetricCard — a single-stat card, rebuilt on
 * the shadcn `Card` primitive: uppercase label, large tabular-nums value, an
 * optional caption, and an `accent` variant that highlights the value in the
 * app's brand color. */
export function MetricCard({
  label,
  value,
  sub,
  accent,
  className,
}: {
  label: ReactNode
  value: ReactNode
  sub?: ReactNode
  accent?: boolean
  className?: string
}) {
  return (
    <Card className={cn('gap-0 rounded-lg border border-border bg-card px-4 py-3.5 shadow-[var(--card-shadow)] ring-0 [--card-spacing:0px]', className)}>
      <div className="truncate text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn('mt-1.5 truncate font-mono text-2xl font-semibold tracking-tight tabular-nums text-foreground', accent && 'text-primary')}>
        {value}
      </div>
      {sub ? <div className="mt-1 truncate text-[11px] text-muted-foreground">{sub}</div> : null}
    </Card>
  )
}
