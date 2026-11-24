import { ChevronRightIcon, CircleStopIcon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/renderer/components/ui/collapsible'
import { TextTooltip, Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { HarnessIcon } from '@/renderer/features/coach-skills/harness-icon.js'
import { cn } from '@/renderer/shared/lib/utils'
import type { DelegationRecord } from '@/shared/schemas/delegation.js'
import type { TaskId } from '@/shared/schemas/workspace.js'

import { type DelegateView, delegationView, nativeDelegateView } from '../delegation/delegation-view.js'
import { DelegationTooltipBody } from '../delegation/DelegationTooltip.js'
import {
  toTaskId,
  useCancelDelegation,
  useDelegationRecord,
  useOpenDelegatedTask,
  useReadDelegation,
} from '../delegation/hooks.js'
import { readFullResult, resultCopySource } from '../delegation/result-copy.js'
import { toneDotClass, toneTextClass } from '../delegation/tone-classes.js'
import { showErrorToast } from '../error-toast.js'
import { CopyTextButton } from './MessageActions.js'
import { ToolOutputPanel } from './ToolOutputPanel.js'
import type { ToolBlock } from './work-log.js'

export function DelegationRow({
  tool,
  delegation,
  connectionLabels,
  harnessKind,
}: {
  readonly tool: ToolBlock
  readonly delegation: DelegationRecord | null
  readonly connectionLabels: ReadonlyMap<string, string>
  readonly harnessKind: string | undefined
}): React.JSX.Element {
  const cancel = useCancelDelegation()
  const openTask = useOpenDelegatedTask()
  const childTaskId: TaskId | null = delegation?.childTaskId ?? toTaskId(tool.orchestration?.childTaskId)
  // The list carries a result preview, so an open row reads the whole result from the record.
  const [expanded, setExpanded] = useState(false)
  const full = useDelegationRecord(expanded && delegation?.resultText ? delegation.id : null)
  const readRecord = useReadDelegation()
  const delegationId = delegation?.id
  // Copy never takes the preview: when the whole result is not loaded yet, it is read now.
  const loadFullResult = useCallback(async () => {
    if (!delegationId) throw new Error('The delegated task is not loaded.')
    try {
      return await readFullResult(() => readRecord(delegationId))
    } catch (cause) {
      showErrorToast(
        `workspace:delegation:${delegationId}:copy`,
        "Couldn't copy delegated task result",
        cause instanceof Error ? cause.message : null,
      )
      throw cause
    }
  }, [delegationId, readRecord])
  return (
    <DelegationRowView
      tool={tool}
      delegation={delegation}
      childTaskId={childTaskId}
      connectionLabels={connectionLabels}
      harnessKind={harnessKind}
      fullResultText={full.data?.resultText}
      loadFullResult={loadFullResult}
      onOpenChange={setExpanded}
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
  harnessKind,
  fullResultText,
  loadFullResult,
  onOpenChange,
  stopPending,
  stopError = null,
  onOpen,
  onStop,
}: {
  readonly tool: ToolBlock
  readonly delegation: DelegationRecord | null
  readonly childTaskId: TaskId | null
  readonly connectionLabels?: ReadonlyMap<string, string>
  readonly harnessKind?: string
  /** The whole result, once loaded; the delegation record from the list holds only a preview. */
  readonly fullResultText?: string | null | undefined
  /** Reads the whole result for Copy while it is not loaded. A failed read rejects. */
  readonly loadFullResult?: (() => Promise<string>) | undefined
  readonly onOpenChange?: ((open: boolean) => void) | undefined
  readonly stopPending: boolean
  readonly stopError?: string | null
  readonly onOpen: (taskId: TaskId) => void
  readonly onStop: (record: DelegationRecord) => void
}): React.JSX.Element {
  const view: DelegateView = delegation
    ? delegationView(delegation, connectionLabels)
    : nativeDelegateView({ ...tool, status: 'unknown' })
  const [open, setOpen] = useState(view.tone === 'failure')
  useEffect(() => onOpenChange?.(open), [open, onOpenChange])
  const live = view.live
  const detail = (live ? null : delegation && view.preview) ?? view.statusLabel
  const rowClass = 'flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 py-2 text-left'
  const result = fullResultText ?? delegation?.resultText ?? tool.output
  const copySource = resultCopySource({
    fullResultText,
    hasRecordResult: delegation?.resultText != null,
    fallbackText: tool.output,
    loadFullResult,
  })
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
        <Tooltip>
          <TooltipTrigger
            render={
              childTaskId ? (
                <button
                  type="button"
                  className={cn(rowClass, 'hover:bg-muted focus-visible:ring-ring focus-visible:ring-2')}
                  aria-label={`Open delegated task ${view.title}`}
                  aria-description={view.statusLabel}
                  onClick={() => onOpen(childTaskId)}
                />
              ) : (
                <span className={rowClass} tabIndex={0} />
              )
            }
          >
            <span className="text-muted-foreground relative shrink-0">
              <HarnessIcon kind={harnessKind ?? ''} className="size-4" />
              <span
                aria-hidden
                className={cn(
                  'ring-background absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-1',
                  toneDotClass[view.tone],
                )}
              />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{view.title}</span>
              <span className="text-muted-foreground block truncate text-[11px]">{detail}</span>
            </span>
            <span className={cn('shrink-0', toneTextClass[view.tone])}>{view.statusLabel}</span>
          </TooltipTrigger>
          <TooltipContent side="top" align="start" className="max-w-72 flex-col items-start gap-0.5 text-left">
            <DelegationTooltipBody view={view} />
          </TooltipContent>
        </Tooltip>
        <div className="flex shrink-0 items-center gap-0.5 pr-1.5">
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
          <TextTooltip
            label="Task details"
            trigger={
              <CollapsibleTrigger
                render={<Button type="button" size="icon-xs" variant="ghost" />}
                className="group/disclosure"
                aria-label={`Details for ${view.title}`}
              >
                <ChevronRightIcon
                  aria-hidden
                  className="text-muted-foreground transition-transform group-data-[panel-open]/disclosure:rotate-90"
                />
              </CollapsibleTrigger>
            }
          />
        </div>
      </div>
      {stopError && (
        <p role="alert" className="text-destructive px-2.5 pb-2">
          {stopError}
        </p>
      )}
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
        {result !== null && (
          <ToolOutputPanel text={result} label="Result" running={live} copySource={copySource ?? undefined} />
        )}
        {tool.error && <ToolOutputPanel text={tool.error} label="Error" error />}
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[10px]">{tool.toolCallId}</span>
          {result && copySource !== null && <CopyTextButton text={copySource} label="Copy delegated task result" />}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
