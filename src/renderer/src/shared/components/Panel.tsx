import type { ReactNode } from 'react'

import { cn } from '@/shared/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/components/ui/card'

/** Panel — a card (`.phead` strip + `.pbody`)
 * mapped onto the shadcn `Card` primitive with theme tokens. Every section's
 * cards follow this mapping. */
export function Panel({
  title,
  right,
  rightLink,
  className,
  children,
}: {
  title?: ReactNode
  right?: ReactNode
  /** Render the `right` slot as an accent action link ("See all ›"). */
  rightLink?: boolean
  className?: string
  children?: ReactNode
}) {
  const hasHead = title !== undefined || right !== undefined
  return (
    <Card
      className={cn(
        'gap-0 overflow-hidden rounded-lg border-border bg-card shadow-[var(--card-shadow)] ring-0 [--card-spacing:0px]',
        className,
      )}
    >
      {hasHead && (
        <CardHeader className="flex flex-row items-center justify-between gap-2 border-b border-line2 px-3.5 py-2">
          {title !== undefined && <CardTitle className="text-subhead font-subhead text-foreground">{title}</CardTitle>}
          {right !== undefined && (
            <span className={cn('text-meta', rightLink && 'font-medium text-brand-text')}>{right}</span>
          )}
        </CardHeader>
      )}
      <CardContent className="px-3.5 py-3">{children}</CardContent>
    </Card>
  )
}

/** Stat — a KPI cell mapped onto a padded Card. */
export function Stat({ label, value, sub, accent }: { label: ReactNode; value: ReactNode; sub?: ReactNode; accent?: boolean }) {
  return (
    <div className={cn('flex flex-col justify-center gap-1 px-3 py-2', accent && 'shadow-[inset_0_2px_0_var(--brand)]')}>
      <span className={cn('text-label font-medium', accent && 'text-brand')}>{label}</span>
      <strong className={cn('truncate font-mono text-kpi font-semibold leading-tight tabular-nums', accent ? 'text-brand' : 'text-foreground')}>
        {value}
      </strong>
      {sub && <small className="truncate text-[9.5px] text-muted-foreground">{sub}</small>}
    </div>
  )
}