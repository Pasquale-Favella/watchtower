import type { ReactNode } from 'react'

import { cn } from '@/renderer/shared/lib/utils'

import { formatCompactCount } from './unified-diff.js'

/** Empty, loading and failure states share one muted line of text. Failures use the alert role. */
export function InspectionNotice({ tone = 'muted', children }: { tone?: 'muted' | 'error'; children: ReactNode }) {
  return (
    <p
      role={tone === 'error' ? 'alert' : undefined}
      className={cn(
        'px-3 py-6 text-center text-[11.5px] leading-relaxed text-balance',
        tone === 'error' ? 'text-destructive' : 'text-muted-foreground',
      )}
    >
      {children}
    </p>
  )
}

/** `+N −M` in compact form; the accessible name keeps the exact counts. */
export function ChangeStats({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span
      role="group"
      aria-label={`${additions} additions, ${deletions} deletions`}
      className="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] tabular-nums"
    >
      <span className="text-success">+{formatCompactCount(additions)}</span>
      <span className="text-destructive">−{formatCompactCount(deletions)}</span>
    </span>
  )
}
