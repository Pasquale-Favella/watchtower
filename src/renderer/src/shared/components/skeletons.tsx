import type { ReactNode } from 'react'

import { cn } from '@/shared/lib/utils'
import { Skeleton } from '@/shared/components/ui/skeleton'

/** Decorative bar-chart silhouette heights, cycled by the bar skeleton. */
const BAR_HEIGHTS = [38, 62, 46, 74, 52, 86, 64, 92, 58, 78, 48, 68, 42, 58]

/** Loading wrapper: announces `label` through a status region (screen
 * readers) while the visual skeleton content is hidden from assistive tech.
 * Every loading state in the app renders through this.
 *
 * The inner `contents` div deliberately has no box: it flattens the skeleton
 * children into the status div's own layout, so `className` (flex, gap,
 * borders) applies to them directly. Keep children plain decorative markup. */
export function LoadingRegion({
  label,
  className,
  children,
}: {
  label: string
  className?: string
  children: ReactNode
}) {
  return (
    <div role="status" className={className}>
      <span className="sr-only">{label}</span>
      <div className="contents" aria-hidden="true">{children}</div>
    </div>
  )
}

/** Card chrome skeleton: an optional title bar (title + hint lines) over
 * composed content — lines, bars, or rows. */
export function SkeletonCard({
  title = true,
  className,
  children,
}: {
  title?: boolean
  className?: string
  children?: ReactNode
}) {
  return (
    <div className={cn('rounded-lg border border-border bg-card p-3.5', className)}>
      {title && (
        <div className="mb-3 flex items-center justify-between gap-4">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-3 w-16" />
        </div>
      )}
      {children}
    </div>
  )
}

/** A KPI-card skeleton: label line over a value line. */
export function SkeletonMetricCard() {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <Skeleton className="h-3 w-14" />
      <Skeleton className="mt-2 h-5 w-20" />
    </div>
  )
}

/** N shimmer text lines, the last one shorter. */
export function SkeletonLines({ lines = 3 }: { lines?: number }) {
  return (
    <div className="flex flex-col gap-2.5" aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={cn('h-3', i === lines - 1 && 'w-3/5')} />
      ))}
    </div>
  )
}

/** Bar-chart silhouette: varying-height bars filling the block — give it a
 * fixed height (e.g. `h-40`) so the bars have room to stand. */
export function SkeletonBars({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-end gap-1.5', className)} aria-hidden="true">
      {BAR_HEIGHTS.map((height, i) => (
        <Skeleton key={i} style={{ height: `${height}%` }} className="w-full rounded-[3px]" />
      ))}
    </div>
  )
}

/** Pill-chip skeleton: mirrors the rounded-full suggestion chips (Coach &
 *  Skills detected-pattern pills, sample prompts) — a fragment of
 *  varying-width pill skeletons, so the caller's LoadingRegion flex
 *  (justify-center, gap-2) applies directly to each pill through the
 *  contents flattening. Height matches the real pill (px-4 py-2 text-[12px]
 *  + border ≈ h-8); rounded-full matches the pill radius. */
export function SkeletonPills() {
  return (
    <>
      <Skeleton className="h-8 w-36 rounded-full" />
      <Skeleton className="h-8 w-44 rounded-full" />
      <Skeleton className="h-8 w-28 rounded-full" />
    </>
  )
}

/** Table/list-row skeleton: varied-width cells across rows. */
export function SkeletonRows({ rows = 7, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col', className)} aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 border-t border-border py-2.5 first:border-t-0">
          <Skeleton className="h-3.5 w-2/5" />
          <Skeleton className="h-3 w-16" />
          <Skeleton className="ml-auto h-3 w-20" />
        </div>
      ))}
    </div>
  )
}
