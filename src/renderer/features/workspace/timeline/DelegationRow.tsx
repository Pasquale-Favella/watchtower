import { ChevronRightIcon, CircleAlertIcon, CircleStopIcon, LoaderCircleIcon, NetworkIcon } from 'lucide-react'
import { useState } from 'react'

import { Badge } from '@/renderer/components/ui/badge'
import { Button } from '@/renderer/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/renderer/components/ui/collapsible'
import { TextTooltip } from '@/renderer/components/ui/tooltip'
import { cn } from '@/renderer/shared/lib/utils'
import type { DelegationRecord } from '@/shared/schemas/delegation.js'
import type { TaskId } from '@/shared/schemas/workspace.js'

import { useWorkspaceConnections } from '../connection-hooks.js'
import { isLiveDelegation } from '../delegation/delegation-status.js'
import { type DelegateView, delegationView, nativeDelegateView } from '../delegation/delegation-view.js'
import { DelegationTooltip } from '../delegation/DelegationTooltip.js'
import {
  toDelegationId,
  toTaskId,
  useCancelDelegation,
  useDelegationRecord,
  useOpenDelegatedTask,
} from '../delegation/hooks.js'
import { CopyTextButton } from './MessageActions.js'
import { ToolOutputPanel } from './ToolOutputPanel.js'
import type { ToolBlock } from './work-log.js'

/** A tool call that started or inspected a Delegated Task. The durable record, when loaded, is the source of truth. */
export function DelegationRow({ tool }: { readonly tool: ToolBlock }): React.JSX.Element {
  const delegationId = toDelegationId(tool.orchestration?.delegationId)
  const record = useDelegationRecord(delegationId)
  const cancel = useCancelDelegation()
  const openTask = useOpenDelegatedTask()
  const connections = useWorkspaceConnections()
  const connectionLabels = new Map(connections.data?.items.map(item => [item.connectionId, item.label] as const) ?? [])
  const delegation = record.data ?? null
  const childTaskId: TaskId | null = delegation?.childTaskId ?? toTaskId(tool.orchestration?.childTaskId)
  return (
    <DelegationRowView
      tool={tool}
      delegation={delegation}
      childTaskId={childTaskId}
      connectionLabels={connectionLabels}
      stopPending={delegation ? cancel.isPending(delegation.id) : false}
      stopError={cancel.error}
      onOpen={openTask}
      onStop={item => {
        void cancel.stop(item)
      }}
    />
  )
}

export function DelegationRowView({
  tool,
  delegation,
  childTaskId,
  connectionLabels,
  stopPending,
  stopError = null,
  onOpen,
  onStop,
}: {
  readonly tool: ToolBlock
  readonly delegation: DelegationRecord | null
  readonly childTaskId: TaskId | null
  readonly connectionLabels?: ReadonlyMap<string, string>
  readonly stopPending: boolean
  readonly stopError?: string | null
  readonly onOpen: (taskId: TaskId) => void
  readonly onStop: (record: DelegationRecord) => void
}): React.JSX.Element {
  const view: DelegateView = delegation ? delegationView(delegation, connectionLabels) : nativeDelegateView(tool)
  const [open, setOpen] = useState(view.tone === 'failure')
  const live = delegation ? isLiveDelegation(delegation) : view.live
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        'bg-muted/30 overflow-hidden rounded-lg border text-xs',
        view.tone === 'failure' && 'border-destructive/40',
      )}
    >
      <div className="flex min-w-0 items-center">
        <CollapsibleTrigger className="group/disclosure flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left">
          <ChevronRightIcon
            aria-hidden
            className="text-muted-foreground size-3 shrink-0 transition-transform group-data-[panel-open]/disclosure:rotate-90"
          />
          {live ? (
            <LoaderCircleIcon aria-hidden className="text-primary size-3.5 shrink-0 motion-safe:animate-spin" />
          ) : (
            <NetworkIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
          )}
          <DelegationTooltip view={view} className="block min-w-0 flex-1">
            <span className="block truncate font-medium">{view.title}</span>
          </DelegationTooltip>
          {view.model && (
            <TextTooltip
              label={view.model}
              trigger={<span className="text-muted-foreground hidden max-w-24 truncate sm:inline">{view.model}</span>}
            />
          )}
          <Badge variant="ghost" className="gap-1 px-1.5 text-[10px]">
            {view.tone === 'failure' ? <CircleAlertIcon aria-hidden className="text-destructive size-3" /> : null}
            {view.statusLabel}
          </Badge>
        </CollapsibleTrigger>
        <div className="flex shrink-0 items-center gap-0.5 pr-1.5">
          {childTaskId && (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-label={`Open delegated task ${view.title}`}
              onClick={() => onOpen(childTaskId)}
            >
              Open
            </Button>
          )}
          {delegation && live && (
            <TextTooltip
              label="Stop delegated task"
              trigger={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Stop delegated task ${view.title}`}
                  disabled={stopPending || delegation.cancelRequestedAt !== null}
                  onClick={() => onStop(delegation)}
                >
                  <CircleStopIcon />
                </Button>
              }
            />
          )}
        </div>
      </div>
      <CollapsibleContent className="space-y-2 border-t px-2.5 py-2.5">
        {view.connection && <p className="text-muted-foreground">Connection: {view.connection}</p>}
        {view.accessMode && (
          <p className="text-muted-foreground">
            Access: {view.accessMode}
            {view.accessModeNote ? ` · ${view.accessModeNote}` : ''}
          </p>
        )}
        {view.isolation && <p className="text-muted-foreground">{view.isolation}</p>}
        {tool.input && <ToolOutputPanel text={tool.input} label="Task details" />}
        {(delegation?.resultText ?? tool.output) !== null && (
          <ToolOutputPanel
            text={delegation?.resultText ?? tool.output ?? 'No result reported.'}
            label="Result"
            running={live}
          />
        )}
        {tool.error && <ToolOutputPanel text={tool.error} label="Error" error />}
        {stopError && (
          <p role="alert" className="text-destructive">
            {stopError}
          </p>
        )}
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[10px]">{tool.toolCallId}</span>
          {(delegation?.resultText ?? tool.output) && (
            <CopyTextButton text={delegation?.resultText ?? tool.output ?? ''} label="Copy delegated task result" />
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
