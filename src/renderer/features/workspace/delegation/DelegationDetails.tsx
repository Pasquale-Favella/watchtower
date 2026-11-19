import { ArrowUpRight, CircleStopIcon, NetworkIcon } from 'lucide-react'

import { Button } from '@/renderer/components/ui/button'
import { cn } from '@/renderer/shared/lib/utils'
import type { DelegationRecord } from '@/shared/schemas/delegation.js'
import type { ConversationId, TaskId } from '@/shared/schemas/workspace.js'

import { useWorkspaceConnections } from '../connection-hooks.js'
import { isLiveDelegation } from './delegation-status.js'
import { delegationView } from './delegation-view.js'
import { DelegationTooltip } from './DelegationTooltip.js'
import { useCancelDelegation, useDelegations, useOpenDelegatedTask } from './hooks.js'
import { toneTextClass } from './tone-classes.js'

export interface DelegationDetailsViewProps {
  readonly records: readonly DelegationRecord[]
  readonly status: 'loading' | 'ready'
  readonly error: string | null
  readonly connectionLabels?: ReadonlyMap<string, string>
  readonly isStopPending: (delegationId: string) => boolean
  readonly stopError?: string | null
  readonly onOpen: (taskId: TaskId) => void
  readonly onStop: (record: DelegationRecord) => void
}

/** The conversation details section that lists this Task's Delegated Tasks, with Open and Stop. */
export function DelegationDetailsView({
  records,
  status,
  error,
  connectionLabels,
  isStopPending,
  stopError = null,
  onOpen,
  onStop,
}: DelegationDetailsViewProps): React.JSX.Element {
  return (
    <section aria-label="Delegated tasks" className="space-y-1 p-2">
      <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs">
        <NetworkIcon aria-hidden="true" className="size-3.5" />
        <span>Delegated tasks</span>
      </div>
      {error && (
        <p role="alert" className="text-destructive px-1 text-xs">
          {error}
        </p>
      )}
      {status === 'loading' && !error && (
        <p role="status" className="text-muted-foreground px-1 text-xs">
          Loading delegated tasks…
        </p>
      )}
      {status === 'ready' && !error && records.length === 0 && (
        <p className="text-muted-foreground px-1 text-xs">No delegated tasks</p>
      )}
      <ul aria-label="Delegated task list" className="space-y-0.5">
        {records.map(record => {
          const view = delegationView(record, connectionLabels)
          const live = isLiveDelegation(record)
          return (
            <li key={record.id} className="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-xs">
              <DelegationTooltip view={view} className="block min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">{record.title}</span>
                  <span className={cn('shrink-0 text-[10px]', toneTextClass[view.tone])}>{view.statusLabel}</span>
                </span>
              </DelegationTooltip>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                aria-label={`Open delegated task ${record.title}`}
                onClick={() => onOpen(record.childTaskId)}
              >
                Open
                <ArrowUpRight aria-hidden="true" />
              </Button>
              {live && (
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Stop delegated task ${record.title}`}
                  title="Stop delegated task"
                  disabled={isStopPending(record.id) || record.cancelRequestedAt !== null}
                  onClick={() => onStop(record)}
                >
                  <CircleStopIcon />
                </Button>
              )}
            </li>
          )
        })}
      </ul>
      {stopError && (
        <p role="alert" className="text-destructive px-1 text-xs">
          {stopError}
        </p>
      )}
    </section>
  )
}

/** Live section for the details panel. Lists the Delegated Tasks started from this conversation. */
export function DelegationDetails({
  taskId,
  conversationId,
}: {
  readonly taskId: TaskId
  readonly conversationId: ConversationId | null
}): React.JSX.Element {
  const delegations = useDelegations(taskId)
  const cancel = useCancelDelegation()
  const openTask = useOpenDelegatedTask()
  const connections = useWorkspaceConnections()
  const connectionLabels = new Map(connections.data?.items.map(item => [item.connectionId, item.label] as const) ?? [])
  const records = delegations.items.filter(item => !conversationId || item.parentConversationId === conversationId)
  return (
    <DelegationDetailsView
      records={records}
      status={delegations.status}
      error={delegations.error}
      connectionLabels={connectionLabels}
      isStopPending={cancel.isPending}
      stopError={cancel.error}
      onOpen={openTask}
      onStop={record => {
        void cancel.stop(record)
      }}
    />
  )
}
