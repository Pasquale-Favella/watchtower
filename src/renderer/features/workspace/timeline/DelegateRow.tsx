import { BotIcon, CheckIcon, CircleAlertIcon, CircleHelpIcon, LoaderCircleIcon } from 'lucide-react'
import { useState } from 'react'

import { WatchtowerMascot } from '@/renderer/components/mascot/WatchtowerMascot'
import { TextTooltip } from '@/renderer/components/ui/tooltip'
import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/renderer/components/ui/trace'
import { cn } from '@/renderer/shared/lib/utils'

import { nativeDelegateView } from '../delegation/delegation-view.js'
import { DelegationTooltip } from '../delegation/DelegationTooltip.js'
import { formatRunDuration } from './duration.js'
import { CopyTextButton } from './MessageActions.js'
import { ToolOutputPanel } from './ToolOutputPanel.js'
import { delegateChildrenSummary, delegateChildStatusLabel, delegateDisplayStatus, type ToolBlock } from './work-log.js'

type DelegateStatus = ToolBlock['status']

const statusView: Record<
  DelegateStatus,
  { readonly label: string; readonly className: string; readonly Icon: typeof CheckIcon }
> = {
  running: { label: 'Running', className: 'text-primary', Icon: LoaderCircleIcon },
  completed: { label: 'Completed', className: 'text-success', Icon: CheckIcon },
  failed: { label: 'Failed', className: 'text-destructive', Icon: CircleAlertIcon },
  unknown: { label: 'Status unavailable', className: 'text-muted-foreground', Icon: CircleHelpIcon },
}

function inputLabel(tool: ToolBlock): string | null {
  if (tool.description?.trim()) return tool.description.trim()
  if (tool.input) {
    try {
      const value: unknown = JSON.parse(tool.input)
      if (typeof value === 'object' && value !== null) {
        const record = value as Record<string, unknown>
        for (const key of ['objective', 'task', 'prompt', 'description', 'message']) {
          const candidate = record[key]
          if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
        }
      }
    } catch {
      // Keep the call name as the fallback when sparse input is malformed.
    }
  }
  return tool.delegate?.action?.trim() || tool.name || null
}

/** Dedicated row for delegated work; it stays visible when ordinary tool activity folds. */
export function DelegateRow({ tool }: { readonly tool: ToolBlock }): React.JSX.Element {
  const [open, setOpen] = useState(tool.status === 'failed')
  const effectiveStatus = delegateDisplayStatus(tool)
  const status = statusView[effectiveStatus]
  const StatusIcon = status.Icon
  const label = inputLabel(tool)
  const model = tool.delegate?.model?.trim()
  const childrenSummary = delegateChildrenSummary(tool)
  return (
    <TraceCollapsible open={open} onOpenChange={setOpen} className="text-xs">
      <TraceCollapsibleTrigger className="max-w-full">
        <TraceLine
          status={effectiveStatus === 'running' ? 'running' : effectiveStatus === 'failed' ? 'error' : undefined}
          className="text-xs"
        >
          <TraceIcon>
            {effectiveStatus === 'running' ? (
              <WatchtowerMascot className="size-4" mood="delegating" />
            ) : (
              <BotIcon className="size-3.5" />
            )}
          </TraceIcon>
          <DelegationTooltip view={nativeDelegateView(tool)} className="block min-w-0">
            <TraceTitle className="block font-medium">{label ?? 'Delegated task'}</TraceTitle>
          </DelegationTooltip>
          {tool.name && <span className="text-muted-foreground/70 truncate font-mono text-[10px]">{tool.name}</span>}
          {model && (
            <TextTooltip
              label={model}
              trigger={<TraceDescription className="hidden max-w-24 truncate sm:inline">{model}</TraceDescription>}
            />
          )}
          {childrenSummary && (
            <TextTooltip
              label={childrenSummary}
              trigger={<TraceDescription className="max-w-32 truncate text-[10px]">{childrenSummary}</TraceDescription>}
            />
          )}
          <span className="inline-flex shrink-0 items-center gap-1 text-[10px]">
            <StatusIcon aria-hidden className={cn('size-3', status.className)} />
            {status.label}
          </span>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="space-y-2">
        {tool.delegate?.reasoningEffort && (
          <p className="text-muted-foreground">Reasoning: {tool.delegate.reasoningEffort}</p>
        )}
        {label && <p className="break-words whitespace-pre-wrap">{label}</p>}
        {tool.delegate?.children && tool.delegate.children.length > 0 && (
          <ul className="space-y-1" aria-label="Delegated agents">
            {tool.delegate.children.map(child => {
              const childLabel = delegateChildStatusLabel(child.status)
              const childClass =
                childLabel === 'Failed'
                  ? 'text-destructive'
                  : childLabel === 'Completed' || childLabel === 'Stopped'
                    ? 'text-success'
                    : childLabel === 'Running' || childLabel === 'Waiting' || childLabel === 'Queued'
                      ? 'text-primary'
                      : 'text-muted-foreground'
              return (
                <li key={child.id} className="flex min-w-0 items-start gap-2">
                  <span className={cn('shrink-0', childClass)}>{childLabel}</span>
                  <span className="min-w-0 break-words">
                    <code>{child.id}</code>
                    {child.message ? ` · ${child.message}` : ''}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
        {tool.input && <ToolOutputPanel text={tool.input} label="Task details" />}
        {tool.output !== null && (
          <ToolOutputPanel
            text={tool.output || 'No result reported.'}
            label="Result"
            running={effectiveStatus === 'running'}
          />
        )}
        {tool.error && <ToolOutputPanel text={tool.error} label="Error" error />}
        {tool.durationMs !== undefined && (
          <p className="text-muted-foreground">Duration {formatRunDuration(tool.durationMs)}</p>
        )}
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[10px]">{tool.toolCallId}</span>
          {tool.output && <CopyTextButton text={tool.output} label="Copy delegate result" />}
        </div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}
