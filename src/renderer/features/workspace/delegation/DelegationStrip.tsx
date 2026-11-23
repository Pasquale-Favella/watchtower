import { CircleStopIcon, NetworkIcon } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import { TextTooltip } from '@/renderer/components/ui/tooltip'
import { cn } from '@/renderer/shared/lib/utils'
import type { DelegationRecord } from '@/shared/schemas/delegation.js'
import type { ProjectId, TaskId } from '@/shared/schemas/workspace.js'

import { useWorkspaceConnections } from '../connection-hooks.js'
import { useErrorToast } from '../error-toast.js'
import { formatRunDuration } from '../timeline/duration.js'
import { useElapsedMs } from '../timeline/use-elapsed.js'
import {
  delegateWaitingLabel,
  delegationStatusTone,
  delegationTally,
  delegationTallyLabel,
  heldWake,
  isLiveDelegation,
  stripDelegations,
} from './delegation-status.js'
import { delegationView } from './delegation-view.js'
import { DelegationTooltip } from './DelegationTooltip.js'
import { useCancelDelegation, useDelegations, useOpenDelegatedTask, useParentRunActive } from './hooks.js'
import { toneDotClass } from './tone-classes.js'

/** Rows above this count collapse to a tally with an expand control. */
const COLLAPSE_ABOVE = 2

export interface DelegationStripViewProps {
  /** Live delegations and settled ones whose wake is held. */
  readonly records: readonly DelegationRecord[]
  readonly heldWake: boolean
  readonly connectionLabels?: ReadonlyMap<string, string>
  readonly isStopPending: (delegationId: string) => boolean
  readonly error?: string | null
  readonly onOpen: (record: DelegationRecord) => void
  readonly onStop: (record: DelegationRecord) => void
}

/** Live Delegated Tasks and held wakes above the composer. */
export function DelegationStripView(props: DelegationStripViewProps): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  if (props.records.length === 0 && !props.heldWake) return null

  const tally = delegationTallyLabel(delegationTally(props.records)) ?? `${props.records.length} delegated tasks`
  const collapsed = props.records.length > COLLAPSE_ABOVE && !expanded
  return (
    <section aria-label="Delegated tasks" className="min-w-0 border-t px-3 py-1.5 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <NetworkIcon aria-hidden="true" className="text-muted-foreground size-3.5 shrink-0" />
        {collapsed ? (
          <button
            type="button"
            aria-expanded={false}
            onClick={() => setExpanded(true)}
            className="text-muted-foreground hover:text-foreground min-w-0 flex-1 truncate text-left"
          >
            {tally} · Show all
          </button>
        ) : (
          <span className="text-muted-foreground min-w-0 flex-1 truncate">{tally}</span>
        )}
        {props.records.length > COLLAPSE_ABOVE && expanded && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-expanded
            aria-label="Collapse delegated tasks"
            onClick={() => setExpanded(false)}
          >
            Collapse
          </Button>
        )}
      </div>
      {/* One polite region per strip, updated when the tally changes, not on every elapsed tick. */}
      <p role="status" aria-live="polite" className="sr-only">
        {tally}
      </p>
      {!collapsed && props.records.length > 0 && (
        <ul aria-label="Live delegated tasks" className="mt-1 divide-y">
          {props.records.map(record => (
            <DelegationStripRow
              key={record.id}
              record={record}
              connectionLabels={props.connectionLabels}
              stopPending={props.isStopPending(record.id)}
              onOpen={props.onOpen}
              onStop={props.onStop}
            />
          ))}
        </ul>
      )}
      {props.heldWake && <p className="text-muted-foreground mt-1">Result held until you send a message.</p>}
      {props.error && (
        <p role="alert" className="text-destructive mt-1">
          {props.error}
        </p>
      )}
    </section>
  )
}

function DelegationStripRow({
  record,
  connectionLabels,
  stopPending,
  onOpen,
  onStop,
}: {
  readonly record: DelegationRecord
  readonly connectionLabels?: ReadonlyMap<string, string> | undefined
  readonly stopPending: boolean
  readonly onOpen: (record: DelegationRecord) => void
  readonly onStop: (record: DelegationRecord) => void
}): React.JSX.Element {
  const live = isLiveDelegation(record)
  const view = delegationView(record, connectionLabels)
  const elapsed = useElapsedMs(record.createdAt, live)
  const waiting = delegateWaitingLabel(record)
  const details = [view.connection, view.model, elapsed === null ? null : formatRunDuration(elapsed)]
    .filter((part): part is string => Boolean(part))
    .join(' · ')
  return (
    <li className="flex min-w-0 items-center gap-2 py-1">
      <span
        aria-hidden="true"
        className={cn('size-1.5 shrink-0 rounded-full', toneDotClass[delegationStatusTone(record.status)])}
      />
      <DelegationTooltip view={view} className="block min-w-0 flex-1">
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{record.title}</span>
          {details && <span className="text-muted-foreground truncate text-[10px]">{details}</span>}
        </span>
      </DelegationTooltip>
      {waiting && (
        <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-400">
          {waiting}
        </span>
      )}
      <Button
        type="button"
        size="xs"
        variant="ghost"
        aria-label={`Open delegated task ${record.title}`}
        onClick={() => onOpen(record)}
      >
        Open
      </Button>
      {live && (
        <TextTooltip
          label="Stop delegated task"
          trigger={
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={`Stop delegated task ${record.title}`}
              disabled={stopPending || record.cancelRequestedAt !== null}
              onClick={() => onStop(record)}
            >
              <CircleStopIcon />
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
  useErrorToast(`workspace:delegation:${taskId}:stop`, "Couldn't stop delegated task", cancel.error)
  const records = stripDelegations(delegations.items, parentRunActive)
  return (
    <DelegationStripView
      records={records}
      heldWake={records.some(record => heldWake(record, parentRunActive))}
      connectionLabels={connectionLabels}
      isStopPending={cancel.isPending}
      error={delegations.error}
      onOpen={record => openTask(record.childTaskId)}
      onStop={record => {
        void cancel.stop(record)
      }}
    />
  )
}
