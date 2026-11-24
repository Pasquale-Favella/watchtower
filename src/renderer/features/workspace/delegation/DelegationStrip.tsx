import { ChevronDownIcon, CircleStopIcon, NetworkIcon } from 'lucide-react'
import { useId, useMemo, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import { TextTooltip, Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { HarnessIcon } from '@/renderer/features/coach-skills/harness-icon.js'
import { cn } from '@/renderer/shared/lib/utils'
import type { DelegationRecord } from '@/shared/schemas/delegation.js'
import type { ProjectId, TaskId } from '@/shared/schemas/workspace.js'

import { useWorkspaceConnections } from '../connection-hooks.js'
import { useErrorToast } from '../error-toast.js'
import { useElapsedMs } from '../timeline/use-elapsed.js'
import {
  delegateWaitingLabel,
  delegationHeadline,
  delegationTally,
  delegationTallyLabel,
  heldWake,
  isLiveDelegation,
  sortStripDelegations,
  stripDelegations,
} from './delegation-status.js'
import { delegationView, formatDelegateElapsed } from './delegation-view.js'
import { DelegationTooltipBody } from './DelegationTooltip.js'
import { useCancelDelegation, useDelegations, useOpenDelegatedTask, useParentRunActive } from './hooks.js'
import { toneDotClass } from './tone-classes.js'

/** Rows shown before the rest fold behind "Show N more". */
const VISIBLE_ROWS = 3

export interface DelegationStripViewProps {
  /** Live delegations and settled ones whose wake is held. */
  readonly records: readonly DelegationRecord[]
  readonly heldWake: boolean
  readonly connectionLabels?: ReadonlyMap<string, string>
  /** Harness kind per connection, for the row avatars. Rows fall back to the delegation's driver. */
  readonly harnessKinds?: ReadonlyMap<string, string>
  readonly isStopPending: (delegationId: string) => boolean
  readonly error?: string | null
  /** Starts with the list open or closed. By default it opens only while a delegate needs the user. */
  readonly initiallyExpanded?: boolean
  readonly onOpen: (record: DelegationRecord) => void
  readonly onStop: (record: DelegationRecord) => void
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** Live Delegated Tasks and held wakes above the composer: one calm summary line that opens into a list. */
export function DelegationStripView(props: DelegationStripViewProps): React.JSX.Element | null {
  const [userExpanded, setUserExpanded] = useState<boolean | null>(props.initiallyExpanded ?? null)
  const [showAll, setShowAll] = useState(false)
  const listId = useId()
  const rows = useMemo(() => sortStripDelegations(props.records), [props.records])
  if (rows.length === 0 && !props.heldWake) return null

  const tally = delegationTally(rows)
  const tallyLabel = delegationTallyLabel(tally)
  const headline = delegationHeadline(tally)
  const featured = rows[0]
  // A delegate that needs the person keeps the list open until they close it themselves.
  const expanded = featured !== undefined && (userExpanded ?? headline?.tone === 'attention')
  const hiddenCount = Math.max(0, rows.length - VISIBLE_ROWS)
  const shown = showAll ? rows : rows.slice(0, VISIBLE_ROWS)
  const phase = headline?.phase ?? 'Finished'
  const detail = headline?.detail ?? plural(rows.length, 'delegate', 'delegates')
  return (
    <section
      aria-label="Delegated tasks"
      className="bg-muted/30 mb-2 min-w-0 rounded-md border text-xs transition-opacity duration-150 motion-reduce:transition-none starting:opacity-0"
    >
      {featured && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setUserExpanded(!expanded)}
          className="hover:bg-accent/20 focus-visible:ring-ring flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-1.5 text-left focus-visible:ring-2 focus-visible:outline-none"
        >
          <NetworkIcon
            aria-hidden="true"
            className={cn(
              'size-3.5 shrink-0',
              headline?.tone === 'attention' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground',
            )}
          />
          <span
            className={cn(
              'shrink-0 font-medium',
              headline?.tone === 'attention' && 'text-amber-700 dark:text-amber-400',
            )}
          >
            {phase}
          </span>
          <span className="text-muted-foreground shrink-0">· {detail}</span>
          <FeaturedDelegate record={featured} />
          <span className="text-muted-foreground flex shrink-0 items-center gap-0.5">
            Details
            <ChevronDownIcon
              aria-hidden="true"
              className={cn('size-3.5 transition-transform motion-reduce:transition-none', expanded && 'rotate-180')}
            />
          </span>
        </button>
      )}
      {/* One polite region per strip, updated when the tally changes, not on every elapsed tick. */}
      <p role="status" aria-live="polite" className="sr-only">
        {tallyLabel ?? ''}
      </p>
      {expanded && (
        <div id={listId} className="border-t p-1">
          <ul
            aria-label="Live delegated tasks"
            className={cn('flex flex-col gap-0.5', showAll && 'max-h-56 overflow-y-auto')}
          >
            {shown.map(record => (
              <DelegationStripRow
                key={record.id}
                record={record}
                connectionLabels={props.connectionLabels}
                harnessKind={props.harnessKinds?.get(record.connectionId) ?? record.driverId}
                stopPending={props.isStopPending(record.id)}
                onOpen={props.onOpen}
                onStop={props.onStop}
              />
            ))}
          </ul>
          {hiddenCount > 0 && (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="text-muted-foreground mt-0.5"
              aria-expanded={showAll}
              onClick={() => setShowAll(!showAll)}
            >
              {showAll ? 'Show fewer' : `Show ${hiddenCount} more`}
            </Button>
          )}
        </div>
      )}
      {props.heldWake && (
        <p className={cn('text-muted-foreground px-3 py-1.5', featured && 'border-t')}>
          Result held until you send a message.
        </p>
      )}
      {props.error && (
        <p role="alert" className="text-destructive border-t px-3 py-1.5">
          {props.error}
        </p>
      )}
    </section>
  )
}

/** The delegate the summary line names, with its live timer. */
function FeaturedDelegate({ record }: { readonly record: DelegationRecord }): React.JSX.Element {
  const live = isLiveDelegation(record)
  const elapsed = useElapsedMs(record.createdAt, live)
  return (
    <>
      <span className="text-muted-foreground min-w-0 flex-1 truncate">{record.title}</span>
      {elapsed !== null && (
        <span className="text-muted-foreground shrink-0 tabular-nums">{formatDelegateElapsed(elapsed)}</span>
      )}
    </>
  )
}

function DelegationStripRow({
  record,
  connectionLabels,
  harnessKind,
  stopPending,
  onOpen,
  onStop,
}: {
  readonly record: DelegationRecord
  readonly connectionLabels?: ReadonlyMap<string, string> | undefined
  readonly harnessKind: string
  readonly stopPending: boolean
  readonly onOpen: (record: DelegationRecord) => void
  readonly onStop: (record: DelegationRecord) => void
}): React.JSX.Element {
  const live = isLiveDelegation(record)
  const view = delegationView(record, connectionLabels)
  const liveElapsed = useElapsedMs(record.createdAt, live)
  const elapsed = live ? liveElapsed : view.durationMs
  const waitingLabel = delegateWaitingLabel(record)
  const request = live && record.pendingRequest !== null
  const pulse = live && !request && record.status === 'running'
  const detail = [view.model, view.statusLabel].filter((part): part is string => Boolean(part)).join(' · ')
  return (
    <li
      className={cn(
        'group/row hover:bg-accent/20 focus-within:bg-accent/20 flex min-w-0 items-center rounded-md',
        request && 'bg-amber-500/10',
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={`Open delegated task ${record.title}`}
              aria-description={waitingLabel ?? view.statusLabel}
              onClick={() => onOpen(record)}
              className="focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left focus-visible:ring-2 focus-visible:outline-none"
            />
          }
        >
          <span className="relative shrink-0">
            <span className="bg-muted text-muted-foreground ring-background flex size-6 items-center justify-center rounded-full border ring-2">
              <HarnessIcon kind={harnessKind} className="size-3.5" />
            </span>
            <span
              aria-hidden="true"
              className={cn(
                'ring-background absolute -right-px bottom-0 size-2 rounded-full ring-2',
                toneDotClass[view.tone],
                pulse && 'motion-safe:animate-pulse',
              )}
            />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-xs font-medium">{record.title}</span>
            <span
              className={cn(
                'truncate text-[10px]',
                request ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground',
              )}
            >
              {request ? view.statusLabel : detail}
            </span>
          </span>
          {elapsed !== null && (
            <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
              {formatDelegateElapsed(elapsed)}
            </span>
          )}
        </TooltipTrigger>
        <TooltipContent side="top" align="start" className="max-w-72 flex-col items-start gap-0.5 text-left">
          <DelegationTooltipBody view={view} />
        </TooltipContent>
      </Tooltip>
      {live && (
        <TextTooltip
          label="Stop delegated task"
          trigger={
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={`Stop delegated task ${record.title}`}
              className="mr-1 shrink-0 opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 motion-reduce:transition-none"
              disabled={stopPending || record.cancelRequestedAt !== null}
              onClick={() => onStop(record)}
            >
              <CircleStopIcon aria-hidden="true" />
            </Button>
          }
        />
      )}
    </li>
  )
}

export function DelegationStrip({
  taskId,
}: {
  readonly taskId: TaskId
  readonly projectId: ProjectId
}): React.JSX.Element | null {
  const delegations = useDelegations(taskId)
  const parentRunActive = useParentRunActive(taskId)
  const openTask = useOpenDelegatedTask()
  const cancel = useCancelDelegation()
  const connections = useWorkspaceConnections()
  const connectionLabels = useMemo(
    () => new Map(connections.data?.items.map(item => [item.connectionId, item.label] as const) ?? []),
    [connections.data?.items],
  )
  const harnessKinds = useMemo(
    () => new Map(connections.data?.items.map(item => [item.connectionId, item.harnessKind] as const) ?? []),
    [connections.data?.items],
  )
  useErrorToast(`workspace:delegation:${taskId}:stop`, "Couldn't stop delegated task", cancel.error)
  const records = stripDelegations(delegations.items, parentRunActive)
  return (
    <DelegationStripView
      records={records}
      heldWake={records.some(record => heldWake(record, parentRunActive))}
      connectionLabels={connectionLabels}
      harnessKinds={harnessKinds}
      isStopPending={cancel.isPending}
      error={delegations.error}
      onOpen={record => openTask(record.childTaskId)}
      onStop={record => {
        void cancel.stop(record)
      }}
    />
  )
}
