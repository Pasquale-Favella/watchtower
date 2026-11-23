import { GitBranch } from 'lucide-react'

import { HarnessIcon } from '@/renderer/features/coach-skills/harness-icon.js'
import { cn } from '@/renderer/shared/lib/utils'

interface SidebarTaskRowContentProps {
  readonly slim: boolean
  readonly title: string
  readonly statusColor: string
  readonly statusText: string
  readonly statusTextColor: string
  readonly harnessKind: string | null
  readonly modelName: string | null
  readonly branch: string | null
  readonly activeDelegates: number
}

export function SidebarTaskRowContent({
  slim,
  title,
  statusColor,
  statusText,
  statusTextColor,
  harnessKind,
  modelName,
  branch,
  activeDelegates,
}: SidebarTaskRowContentProps) {
  return (
    <>
      <span className="flex min-w-0 items-center gap-1.5 pointer-coarse:pr-14">
        <span className={cn('size-1.5 shrink-0 rounded-full', statusColor)} aria-hidden="true" />
        {slim && harnessKind && <HarnessIcon kind={harnessKind} className="size-3.5 shrink-0" />}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className="max-w-[55%] min-w-14 text-right">
          <span
            aria-hidden="true"
            className={cn(
              'block truncate text-[10px] tabular-nums transition-opacity group-hover/task:opacity-0 group-has-[:focus-visible]/task:opacity-0 pointer-coarse:opacity-100',
              statusTextColor,
            )}
          >
            {statusText}
          </span>
        </span>
      </span>
      {!slim && (
        <span className="text-sidebar-muted-foreground flex min-h-4 min-w-0 items-center gap-1.5 pl-3 text-[11px]">
          {harnessKind && (
            <span className="flex min-w-0 items-center gap-1">
              <HarnessIcon kind={harnessKind} className="size-3 shrink-0" />
              <span className="truncate">{modelName}</span>
            </span>
          )}
          {branch && (
            <span className="flex min-w-0 items-center gap-1">
              <GitBranch className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{branch}</span>
            </span>
          )}
          {activeDelegates > 0 && (
            <span className="bg-sidebar-accent shrink-0 rounded px-1 tabular-nums">
              {activeDelegates} delegated running
            </span>
          )}
        </span>
      )}
    </>
  )
}
