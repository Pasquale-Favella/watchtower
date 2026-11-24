import { GitBranch } from 'lucide-react'

import { WatchtowerMascot } from '@/renderer/components/mascot/WatchtowerMascot.js'
import { HarnessIcon } from '@/renderer/features/coach-skills/harness-icon.js'
import { cn } from '@/renderer/shared/lib/utils'

import type { SidebarTaskMood } from '../delegation/sidebar-delegation.js'
import { ProjectAvatar } from '../ProjectAvatar.js'

export type SidebarTaskTone = 'amber' | 'indigo' | 'blue'

const SIDEBAR_TONE_CLASSES: Record<SidebarTaskTone, string> = {
  amber: 'text-amber-600 dark:text-amber-400',
  indigo: 'text-indigo-600 dark:text-indigo-400',
  blue: 'text-blue-600 dark:text-blue-400',
}

/** The status slot gives way to the row's hover/focus actions. */
const STATUS_SLOT_CLASS =
  'flex shrink-0 items-center gap-1 text-xs tabular-nums group-hover/task:hidden group-has-[:focus-visible]/task:hidden pointer-coarse:hidden'

/** While the actions show, the line keeps clear of them so its text truncates instead of sliding underneath. */
const ACTIONS_CLEARANCE_CLASS = 'group-hover/task:pr-14 group-has-[:focus-visible]/task:pr-14 pointer-coarse:pr-14'

interface SidebarTaskRowContentProps {
  /** Completed and archived chats collapse to one receded line. */
  readonly slim: boolean
  readonly title: string
  /** Null for chats that belong to no Project. */
  readonly projectId: string | null
  readonly projectName: string
  /** Live states: the mascot acts the state out next to its label, in place of the elapsed time. */
  readonly mood: SidebarTaskMood | null
  readonly tone: SidebarTaskTone | null
  readonly statusLabel: string | null
  readonly elapsedTime: string
  readonly harnessKind: string | null
  readonly modelName: string | null
  readonly branch: string | null
  readonly activeDelegates: number
}

function StatusSlot({
  mood,
  tone,
  statusLabel,
  elapsedTime,
}: Pick<SidebarTaskRowContentProps, 'mood' | 'tone' | 'statusLabel' | 'elapsedTime'>) {
  if (mood && tone && statusLabel)
    return (
      <span aria-hidden="true" className={cn(STATUS_SLOT_CLASS, 'max-w-[60%] font-medium', SIDEBAR_TONE_CLASSES[tone])}>
        <WatchtowerMascot mood={mood} className="size-4 shrink-0" />
        <span className="truncate">{statusLabel}</span>
      </span>
    )
  return (
    <span aria-hidden="true" className={cn(STATUS_SLOT_CLASS, 'text-sidebar-muted-foreground')}>
      {elapsedTime}
    </span>
  )
}

export function SidebarTaskRowContent({
  slim,
  title,
  projectId,
  projectName,
  mood,
  tone,
  statusLabel,
  elapsedTime,
  harnessKind,
  modelName,
  branch,
  activeDelegates,
}: SidebarTaskRowContentProps) {
  if (slim)
    return (
      <span className={cn('flex h-5 min-w-0 items-center gap-2', ACTIONS_CLEARANCE_CLASS)}>
        <ProjectAvatar
          projectId={projectId}
          name={projectName}
          className="opacity-60 grayscale transition group-hover/task:opacity-100 group-hover/task:grayscale-0"
        />
        <span className="min-w-0 flex-1 truncate text-[13px]">{title}</span>
        <StatusSlot mood={null} tone={null} statusLabel={null} elapsedTime={elapsedTime} />
      </span>
    )

  const hasMeta = Boolean(branch || harnessKind || activeDelegates > 0)
  return (
    <>
      <span className={cn('flex h-5 min-w-0 items-center gap-1.5', ACTIONS_CLEARANCE_CLASS)}>
        <ProjectAvatar projectId={projectId} name={projectName} />
        <span className="text-sidebar-muted-foreground min-w-0 flex-1 truncate text-xs">{projectName}</span>
        <StatusSlot mood={mood} tone={tone} statusLabel={statusLabel} elapsedTime={elapsedTime} />
      </span>
      <span className="mt-0.5 block min-w-0 truncate text-[13px] font-medium">{title}</span>
      {hasMeta && (
        <span className="text-sidebar-muted-foreground mt-0.5 flex h-4 min-w-0 items-center gap-1.5 text-xs">
          {branch && (
            <span className="flex min-w-0 items-center gap-1">
              <GitBranch className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{branch}</span>
            </span>
          )}
          {activeDelegates > 0 && (
            <span className="bg-sidebar-accent text-sidebar-accent-foreground shrink-0 rounded px-1 tabular-nums">
              {activeDelegates} delegated
            </span>
          )}
          {harnessKind && (
            <span className="ml-auto flex max-w-[60%] min-w-0 shrink-0 items-center gap-1">
              <HarnessIcon kind={harnessKind} className="size-3 shrink-0" />
              {modelName && <span className="truncate">{modelName}</span>}
            </span>
          )}
        </span>
      )}
    </>
  )
}
