import { cn } from '@/shared/lib/utils'
import type { CoachHarnessRow } from '../../../../shared/schemas/agents.js'
import { statusLabel } from './lib'

const dotClass: Record<CoachHarnessRow['status'], string> = {
  ready: 'bg-emerald-500',
  warning: 'bg-amber-500',
  error: 'bg-destructive',
  pending: 'animate-pulse bg-muted-foreground/60',
  disabled: 'bg-muted-foreground/50',
}

export function HarnessStatusDot({ status, className }: { status: CoachHarnessRow['status']; className?: string }) {
  return (
    <span
      aria-label={statusLabel(status)}
      className={cn('size-1.5 shrink-0 rounded-full', dotClass[status], className)}
    />
  )
}

export function harnessTooltip(row: CoachHarnessRow): string {
  return [
    `${row.displayName} — ${statusLabel(row.status)}`,
    row.message,
    row.version ? `Version ${row.version}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
}
