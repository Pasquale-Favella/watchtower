import { ChevronRightIcon, CircleAlertIcon } from 'lucide-react'

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/renderer/components/ui/collapsible'
import { cn } from '@/renderer/shared/lib/utils'

import type { WorkGroup } from './turn-segments.js'
import type { ToolBlock, WorkSummary } from './work-log.js'

const toolStatusLabels = {
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  unknown: 'Status unavailable',
} as const

const logItemClass = 'bg-muted/40 rounded-md border px-2.5 py-1.5 text-xs'

function FailureMarker({ count }: { readonly count: number }): React.JSX.Element | null {
  if (count === 0) return null
  return (
    <span className="text-destructive inline-flex items-center gap-1">
      <CircleAlertIcon aria-hidden className="size-3" />
      {count} failed
    </span>
  )
}

/** One tool call: its name and lifecycle, with input, output and error available on expansion. */
export function ToolRow({ tool }: { readonly tool: ToolBlock }): React.JSX.Element {
  const failed = tool.status === 'failed'
  return (
    <Collapsible defaultOpen={failed || tool.status === 'running'} className={logItemClass}>
      <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-2 text-left">
        <ChevronRightIcon
          aria-hidden
          className="text-muted-foreground size-3 shrink-0 transition-transform data-[panel-open]:rotate-90"
        />
        <span className="min-w-0 truncate font-medium">{tool.name}</span>
        <span className={cn('ml-auto shrink-0', failed ? 'text-destructive' : 'text-muted-foreground')}>
          {toolStatusLabels[tool.status]}
          {tool.continued ? ' · continued' : ''}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 pt-2">
        {tool.input && (
          <pre className="bg-muted max-h-80 overflow-auto rounded p-2 break-words whitespace-pre-wrap">
            {tool.input}
          </pre>
        )}
        {tool.output && (
          <pre className="bg-muted max-h-80 overflow-auto rounded p-2 break-words whitespace-pre-wrap">
            {tool.output}
          </pre>
        )}
        {tool.error && <pre className="text-destructive break-words whitespace-pre-wrap">{tool.error}</pre>}
        <p className="text-muted-foreground">
          Tool call <code className="break-all">{tool.toolCallId}</code>
        </p>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** A single call is one row. Two or more calls collapse under their summary, scrolling when the list is long. */
export function WorkGroupRow({ group }: { readonly group: WorkGroup }): React.JSX.Element {
  const [only] = group.tools
  if (group.tools.length === 1 && only) return <ToolRow tool={only} />
  return (
    <WorkLogCollapsible summary={group.summary} className={logItemClass}>
      {group.tools.map(tool => (
        <ToolRow key={tool.toolCallId} tool={tool} />
      ))}
    </WorkLogCollapsible>
  )
}

function WorkLogCollapsible({
  summary,
  children,
  className,
  open,
  onOpenChange,
  label,
}: {
  readonly summary: WorkSummary
  readonly children: React.ReactNode
  readonly className?: string
  /** Controlled expansion when provided; otherwise the group starts collapsed. */
  readonly open?: boolean
  readonly onOpenChange?: (open: boolean) => void
  /** Replaces the summary sentence on the trigger, such as a fold label. */
  readonly label?: string
}): React.JSX.Element {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className={className}>
      <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-2 text-left">
        <ChevronRightIcon
          aria-hidden
          className="text-muted-foreground size-3 shrink-0 transition-transform data-[panel-open]:rotate-90"
        />
        <span className="min-w-0 truncate">{label ?? summary.label}</span>
        <span className="text-muted-foreground ml-auto flex shrink-0 items-center gap-2">
          {label !== undefined && <span>{summary.toolCount} tool calls</span>}
          <FailureMarker count={summary.failedCount} />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 max-h-[min(18rem,50vh)] space-y-1.5 overflow-y-auto pr-1">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** The folded activity row for a settled Run. Its expansion is controlled so the choice survives remounts. */
export function TurnFoldRow({
  label,
  summary,
  groups,
  open,
  onOpenChange,
}: {
  readonly label: string
  readonly summary: WorkSummary
  readonly groups: readonly WorkGroup[]
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  return (
    <WorkLogCollapsible summary={summary} label={label} open={open} onOpenChange={onOpenChange}>
      {groups.map(group => (
        <WorkGroupRow key={group.key} group={group} />
      ))}
    </WorkLogCollapsible>
  )
}
