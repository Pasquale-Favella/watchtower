import { ChevronRight, CircleStopIcon, CornerLeftUp, NetworkIcon } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'

import { LoadingRegion } from '@/renderer/components/skeletons'
import { Button } from '@/renderer/components/ui/button'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { TextTooltip } from '@/renderer/components/ui/tooltip'
import { cn } from '@/renderer/shared/lib/utils'
import type { DelegationRecord } from '@/shared/schemas/delegation.js'
import type { ConversationId, ProjectId, TaskId, WorkspaceCheckout } from '@/shared/schemas/workspace.js'
import type { WorkspaceConnection } from '@/shared/schemas/workspace-connections.js'

import { useWorkspaceConnections } from '../connection-hooks.js'
import { useErrorToast } from '../error-toast.js'
import { useWorkspaceProject } from '../hooks.js'
import { type ParentTaskLink, useParentTaskLink } from './chat-delegation-hooks.js'
import { delegationView } from './delegation-view.js'
import { DelegationDetailsTooltip } from './DelegationTooltip.js'
import { groupDelegationDetails } from './details-view.js'
import { useCancelDelegation, useDelegations, useOpenDelegatedTask } from './hooks.js'
import { toneDotClass, toneTextClass } from './tone-classes.js'

interface DelegationRowProps {
  readonly record: DelegationRecord
  readonly connectionLabels: ReadonlyMap<string, string>
  readonly harnessKind: string
  readonly checkout: WorkspaceCheckout | undefined
  readonly stopPending: boolean
  readonly onOpen: (taskId: TaskId) => void
  readonly onStop: (record: DelegationRecord) => void
}

const rowClass = 'min-w-0 justify-start gap-2 px-1 text-left'

function DelegatedTaskRow({
  record,
  connectionLabels,
  harnessKind,
  checkout,
  stopPending,
  onOpen,
  onStop,
}: DelegationRowProps): React.JSX.Element {
  const view = delegationView(record, connectionLabels)

  return (
    <li className="flex min-w-0 items-center gap-1">
      <DelegationDetailsTooltip
        record={record}
        view={view}
        harnessKind={harnessKind}
        checkout={checkout}
        trigger={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={`Open delegated task ${record.title} · ${view.statusLabel}`}
            className={cn(rowClass, 'flex-1')}
            onClick={() => onOpen(record.childTaskId)}
          />
        }
      >
        <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', toneDotClass[view.tone])} />
        <span className="min-w-0 flex-1 truncate">{record.title}</span>
        <span className={cn('shrink-0 text-[10px]', toneTextClass[view.tone])}>{view.statusLabel}</span>
      </DelegationDetailsTooltip>
      {view.live && (
        <TextTooltip
          label="Stop delegated task"
          side="left"
          trigger={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Stop delegated task ${record.title}`}
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

export interface DelegationDetailsViewProps {
  readonly records: readonly DelegationRecord[]
  readonly status: 'loading' | 'ready'
  readonly error: string | null
  readonly parent?: ReactNode
  readonly truncated?: boolean | undefined
  readonly connections?: readonly WorkspaceConnection[] | undefined
  readonly checkouts?: ReadonlyMap<string, WorkspaceCheckout> | undefined
  readonly isStopPending: (delegationId: string) => boolean
  readonly onOpen: (taskId: TaskId) => void
  readonly onStop: (record: DelegationRecord) => void
}

export function DelegationDetailsView({
  records,
  status,
  error,
  parent,
  truncated,
  connections,
  checkouts,
  isStopPending,
  onOpen,
  onStop,
}: DelegationDetailsViewProps): React.JSX.Element | null {
  const [showPrevious, setShowPrevious] = useState(false)
  const connectionLabels = useMemo(
    () => new Map(connections?.map(connection => [connection.connectionId, connection.label])),
    [connections],
  )
  const harnessKinds = useMemo(
    () => new Map(connections?.map(connection => [connection.connectionId, connection.harnessKind])),
    [connections],
  )
  if (!parent && records.length === 0) return null

  const { active, previous } = groupDelegationDetails(records)
  const renderRow = (record: DelegationRecord) => (
    <DelegatedTaskRow
      key={record.id}
      record={record}
      connectionLabels={connectionLabels}
      harnessKind={harnessKinds.get(record.connectionId) ?? record.driverId}
      checkout={record.isolation === 'worktree' ? checkouts?.get(record.checkoutId) : undefined}
      stopPending={isStopPending(record.id)}
      onOpen={onOpen}
      onStop={onStop}
    />
  )

  return (
    <section aria-label="Delegated tasks" className="space-y-1 p-2">
      <h3 className="text-muted-foreground flex items-center gap-2 px-1 text-xs">
        <NetworkIcon aria-hidden="true" className="size-3.5" />
        {active.length > 0 ? `Delegated tasks · ${active.length} running` : 'Delegated tasks'}
      </h3>
      {parent}
      {error && (
        <p role="alert" className="text-destructive px-1 text-xs">
          {error}
        </p>
      )}
      {status === 'loading' && !error && (
        <LoadingRegion label="Loading delegated tasks…" className="flex flex-col gap-2 px-1 py-1">
          {[0, 1].map(row => (
            <div key={row} className="flex items-center gap-2">
              <Skeleton className="h-3 w-3/5" />
              <Skeleton className="ml-auto h-2.5 w-12" />
            </div>
          ))}
        </LoadingRegion>
      )}
      {active.length > 0 && (
        <ul aria-label="Active delegated tasks" className="space-y-0.5">
          {active.map(renderRow)}
        </ul>
      )}
      {previous.length > 0 && (
        <>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className={cn(rowClass, 'text-muted-foreground w-full')}
            aria-expanded={showPrevious}
            onClick={() => setShowPrevious(open => !open)}
          >
            <ChevronRight aria-hidden="true" className={cn('size-3', showPrevious && 'rotate-90')} />
            Previous tasks ({previous.length})
          </Button>
          {showPrevious && (
            <ul aria-label="Previous delegated tasks" className="space-y-0.5">
              {previous.map(renderRow)}
            </ul>
          )}
        </>
      )}
      {truncated && records.length > 0 && (
        <p className="text-muted-foreground px-1 text-xs">Showing the latest {records.length}</p>
      )}
    </section>
  )
}

function ParentTaskRow({ parent }: { readonly parent: ParentTaskLink }): React.JSX.Element {
  return (
    <TextTooltip
      label={`Open parent task: ${parent.title}`}
      side="left"
      trigger={
        <Button type="button" size="xs" variant="ghost" className={cn(rowClass, 'w-full')} onClick={parent.open}>
          <CornerLeftUp aria-hidden="true" className="text-muted-foreground size-3.5" />
          <span className="truncate">Delegated from {parent.title}</span>
        </Button>
      }
    />
  )
}

export function DelegationDetails({
  taskId,
  conversationId,
  projectId,
}: {
  readonly taskId: TaskId
  readonly conversationId: ConversationId | null
  readonly projectId: ProjectId | null
}): React.JSX.Element {
  const delegations = useDelegations(taskId)
  const cancel = useCancelDelegation()
  const openTask = useOpenDelegatedTask()
  const parentTask = useParentTaskLink(projectId, taskId, openTask)
  const connections = useWorkspaceConnections()
  const project = useWorkspaceProject(projectId ? { projectId } : null)
  useErrorToast(`workspace:delegation:${taskId}:details-stop`, "Couldn't stop delegated task", cancel.error)

  const records = delegations.items.filter(item => !conversationId || item.parentConversationId === conversationId)
  const checkoutsById = new Map(project.data?.otherCheckouts.map(checkout => [checkout.id, checkout]))

  return (
    <DelegationDetailsView
      records={records}
      status={delegations.status}
      error={delegations.error}
      parent={parentTask && <ParentTaskRow parent={parentTask} />}
      truncated={delegations.truncated}
      connections={connections.data?.items}
      checkouts={checkoutsById}
      isStopPending={cancel.isPending}
      onOpen={openTask}
      onStop={record => {
        void cancel.stop(record)
      }}
    />
  )
}
