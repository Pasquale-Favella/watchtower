import { ChevronDown, ChevronRight } from 'lucide-react'

import { LoadingRegion } from '@/renderer/components/skeletons'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { cn } from '@/renderer/shared/lib/utils'
import type { ProjectId, TaskId } from '@/shared/schemas/workspace.js'

import { delegationView } from './delegation-view.js'
import { useDelegations } from './hooks.js'
import { toneDotClass, toneTextClass } from './tone-classes.js'

/** Expands or collapses a parent's delegated Tasks. The child list loads only while expanded. */
export function SidebarDelegateToggle({
  title,
  total,
  expanded,
  onToggle,
}: {
  readonly title: string
  readonly total: number
  readonly expanded: boolean
  readonly onToggle: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={`${expanded ? 'Collapse' : 'Expand'} delegated tasks of ${title}, ${total} total`}
      title={`${total} delegated ${total === 1 ? 'task' : 'tasks'}`}
      onClick={onToggle}
      className="text-sidebar-muted-foreground hover:text-sidebar-foreground focus-visible:ring-ring flex size-6 shrink-0 items-center justify-center rounded outline-none focus-visible:ring-2"
    >
      {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
    </button>
  )
}

/** Indented child rows of a parent Task. Each row opens its child Task. */
export function SidebarDelegateChildren({
  taskId,
  projectId,
  selectedTaskId,
  onSelectTask,
}: {
  readonly taskId: TaskId
  readonly projectId: ProjectId
  readonly selectedTaskId: TaskId | null
  readonly onSelectTask: (taskId: TaskId, projectId: ProjectId) => void
}): React.JSX.Element {
  const delegations = useDelegations(taskId)
  const items = delegations.items
  return (
    <div className="border-sidebar-border mt-0.5 ml-3.5 border-l pl-2" aria-label="Delegated tasks">
      {delegations.status === 'loading' && !delegations.error && (
        <LoadingRegion label="Loading delegated tasks…" className="flex flex-col gap-2 px-2 py-1">
          <Skeleton className="h-2.5 w-4/5" />
          <Skeleton className="h-2.5 w-3/5" />
        </LoadingRegion>
      )}
      {delegations.error && (
        <p role="status" className="text-destructive px-2 py-1 text-[10px]">
          {delegations.error}
        </p>
      )}
      <ul className="space-y-0.5">
        {items.map(record => {
          const view = delegationView(record)
          const selected = selectedTaskId === record.childTaskId
          return (
            <li key={record.id} className="list-none">
              <button
                type="button"
                aria-current={selected ? 'page' : undefined}
                aria-label={`${record.title}, ${view.statusLabel}`}
                onClick={() => onSelectTask(record.childTaskId, projectId)}
                className={cn(
                  'focus-visible:ring-ring flex min-h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-xs outline-none focus-visible:ring-2',
                  selected
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
                )}
              >
                <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', toneDotClass[view.tone])} />
                <span className="min-w-0 flex-1 truncate">{record.title}</span>
                <span className={cn('shrink-0 text-[10px]', toneTextClass[view.tone])}>{view.statusLabel}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
