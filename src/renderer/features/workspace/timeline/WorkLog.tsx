import {
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleHelpIcon,
  Clock3Icon,
  ExternalLinkIcon,
  FilePenLineIcon,
  FileTextIcon,
  GlobeIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  NetworkIcon,
  PlugIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
} from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/renderer/components/ui/trace'
import { useNativeStore } from '@/renderer/shared/hooks/use-native-store'
import { cn } from '@/renderer/shared/lib/utils'

import { formatRunDuration } from './duration.js'
import { FileChangesBlock } from './FileChangesBlock.js'
import { CopyTextButton } from './MessageActions.js'
import { useTimelineRoutes } from './timeline-routes.js'
import { safeToolUrl, toolPresentation } from './tool-presentation.js'
import { ToolOutputPanel } from './ToolOutputPanel.js'
import type { WorkGroup } from './turn-segments.js'
import { toolDisclosureKey, workDisclosureKey } from './turn-segments.js'
import type { ToolBlock, ToolCategory, WorkSummary } from './work-log.js'

const toolStatus = {
  running: { label: 'Running', Icon: LoaderCircleIcon, className: 'motion-safe:animate-spin', trace: 'running' },
  completed: { label: 'Completed', Icon: CheckIcon, className: 'text-success', trace: undefined },
  failed: { label: 'Failed', Icon: CircleAlertIcon, className: 'text-destructive', trace: 'error' },
  unknown: { label: 'Status unavailable', Icon: CircleHelpIcon, className: 'text-muted-foreground', trace: 'pending' },
} as const

const categoryIcons: Record<ToolCategory, typeof TerminalIcon> = {
  command: TerminalIcon,
  read: FileTextIcon,
  edit: FilePenLineIcon,
  search: SearchIcon,
  web: GlobeIcon,
  subagent: BotIcon,
  delegation: NetworkIcon,
  mcp: PlugIcon,
  other: WrenchIcon,
}

function FailureMarker({ count }: { readonly count: number }): React.JSX.Element | null {
  if (count === 0) return null
  return (
    <span className="text-destructive inline-flex shrink-0 items-center gap-1">
      <CircleAlertIcon aria-hidden className="size-3" />
      {count} failed
    </span>
  )
}

/** One agent call, with literal input/output and explicit native metadata. */
export function ToolRow({
  tool,
  disclosureKey,
  disclosureChoices,
  onDisclosureChange,
}: {
  readonly tool: ToolBlock
  readonly disclosureKey?: string
  readonly disclosureChoices?: Readonly<Record<string, boolean>>
  readonly onDisclosureChange?: (key: string, open: boolean) => void
}): React.JSX.Element {
  const [localOpen, setLocalOpen] = useState(false)
  const routes = useTimelineRoutes()
  const controlled = disclosureKey !== undefined && disclosureChoices !== undefined
  const open = controlled ? (disclosureChoices[disclosureKey] ?? false) : localOpen
  const changeOpen = (next: boolean) => {
    if (controlled && disclosureKey && onDisclosureChange) onDisclosureChange(disclosureKey, next)
    else setLocalOpen(next)
  }
  const { openExternal } = useNativeStore()
  const presentation = toolPresentation(tool)
  const CategoryIcon = categoryIcons[presentation.category]
  const { label: statusLabel, Icon: StatusIcon, className: statusClass, trace: traceStatus } = toolStatus[tool.status]
  const url = safeToolUrl(presentation.url)
  return (
    <TraceCollapsible open={open} onOpenChange={changeOpen} className="text-xs">
      <TraceCollapsibleTrigger className="max-w-full" aria-label={`${tool.name}: ${statusLabel}`}>
        <TraceLine status={traceStatus} className="text-xs">
          <TraceIcon>
            <CategoryIcon className="size-3.5" />
          </TraceIcon>
          <TraceTitle className="font-medium">{presentation.label}</TraceTitle>
          {presentation.detail && (
            <span
              className="text-muted-foreground/70 min-w-0 truncate font-mono text-[11px]"
              title={presentation.detail}
            >
              {presentation.detail}
            </span>
          )}
          {tool.status !== 'running' && tool.durationMs !== undefined && (
            <TraceDescription className="text-[11px]">{formatRunDuration(tool.durationMs)}</TraceDescription>
          )}
          {tool.status !== 'completed' && (
            <TraceIcon>
              <StatusIcon className={cn('size-3', statusClass)} />
            </TraceIcon>
          )}
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="space-y-2">
        <div className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          <span>{tool.name}</span>
          {tool.continued && <span>Continued from earlier activity</span>}
          {tool.durationMs !== undefined && (
            <span className="inline-flex items-center gap-1 tabular-nums">
              <Clock3Icon aria-hidden className="size-3" />
              {formatRunDuration(tool.durationMs)}
            </span>
          )}
          {tool.exitCode !== undefined && (
            <span className={tool.exitCode === 0 ? 'text-success' : 'text-destructive'}>Exit code {tool.exitCode}</span>
          )}
        </div>
        {tool.description && (
          <p className="text-muted-foreground break-words whitespace-pre-wrap">{tool.description}</p>
        )}
        {tool.cwd && (
          <p className="text-muted-foreground text-[11px] break-all">
            Working directory <code>{tool.cwd}</code>
          </p>
        )}
        {presentation.command && <ToolOutputPanel text={presentation.command} label="Command" terminal />}
        {presentation.category === 'command' && presentation.command && routes.runShellCommand && (
          <div className="flex justify-end">
            <Button
              type="button"
              variant="link"
              size="xs"
              onClick={() => routes.runShellCommand?.(presentation.command ?? '')}
            >
              Open in terminal
            </Button>
          </div>
        )}
        {tool.input && <ToolOutputPanel text={tool.input} label="Input" />}
        {tool.changes?.length ? <FileChangesBlock changes={tool.changes} /> : null}
        {!tool.changes?.length && presentation.paths.length > 0 && (
          <ul className="text-muted-foreground space-y-1 font-mono text-[11px]" aria-label="Referenced files">
            {presentation.paths.map(path => (
              <li key={path} className="break-all">
                {path}
              </li>
            ))}
          </ul>
        )}
        {url && (
          <div className="flex min-w-0 items-center gap-1">
            <Button
              type="button"
              variant="link"
              size="xs"
              className="max-w-full min-w-0"
              onClick={() => openExternal(url)}
            >
              <ExternalLinkIcon aria-hidden className="size-3 shrink-0" />
              <span className="truncate">{url}</span>
            </Button>
            <CopyTextButton text={url} label="Copy source URL" />
          </div>
        )}
        {tool.output !== null && (
          <ToolOutputPanel
            text={tool.output || 'No output.'}
            label="Output"
            running={tool.status === 'running'}
            terminal={presentation.category === 'command'}
          />
        )}
        {tool.error && <ToolOutputPanel text={tool.error} label="Error" error terminal />}
        <details className="text-muted-foreground text-[10px]">
          <summary className="cursor-pointer">Tool details</summary>
          <code className="break-all">{tool.toolCallId}</code>
        </details>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}

export function WorkGroupRow({
  group,
  turnId,
  withinFold = false,
  disclosureChoices,
  onDisclosureChange,
}: {
  readonly group: WorkGroup
  readonly turnId?: string
  readonly withinFold?: boolean
  readonly disclosureChoices?: Readonly<Record<string, boolean>>
  readonly onDisclosureChange?: (key: string, open: boolean, turnId: string, withinFold: boolean) => void
}): React.JSX.Element {
  const [only] = group.tools
  const groupKey = turnId === undefined ? undefined : workDisclosureKey(turnId, group.key)
  const openedChild =
    turnId !== undefined && group.tools.some(tool => disclosureChoices?.[toolDisclosureKey(turnId, tool)] === true)
  const open = groupKey === undefined ? undefined : (disclosureChoices?.[groupKey] ?? openedChild)
  if (group.tools.length === 1 && only)
    return (
      <ToolRow
        tool={only}
        disclosureKey={turnId === undefined ? undefined : toolDisclosureKey(turnId, only)}
        disclosureChoices={disclosureChoices}
        onDisclosureChange={(key, next) => {
          if (turnId) onDisclosureChange?.(key, next, turnId, withinFold)
        }}
      />
    )
  return (
    <WorkLogCollapsible
      summary={group.summary}
      open={open}
      onOpenChange={next => {
        if (groupKey && turnId) onDisclosureChange?.(groupKey, next, turnId, withinFold)
      }}
      active={group.tools.some(tool => tool.status === 'running')}
    >
      {group.tools.map(tool => (
        <ToolRow
          key={tool.toolCallId}
          tool={tool}
          disclosureKey={turnId === undefined ? undefined : toolDisclosureKey(turnId, tool)}
          disclosureChoices={disclosureChoices}
          onDisclosureChange={(key, next) => {
            if (turnId) onDisclosureChange?.(key, next, turnId, withinFold)
          }}
        />
      ))}
    </WorkLogCollapsible>
  )
}

function WorkLogCollapsible({
  summary,
  children,
  open,
  onOpenChange,
  label,
  active = false,
}: {
  readonly summary: WorkSummary
  readonly children: React.ReactNode
  readonly open?: boolean
  readonly onOpenChange?: (open: boolean) => void
  readonly label?: string
  readonly active?: boolean
}): React.JSX.Element {
  const [localOpen, setLocalOpen] = useState(false)
  const isControlled = open !== undefined
  return (
    <TraceCollapsible
      open={open ?? localOpen}
      onOpenChange={next => {
        if (isControlled) onOpenChange?.(next)
        else setLocalOpen(next)
      }}
      className="text-xs"
    >
      <TraceCollapsibleTrigger className="max-w-full">
        <TraceLine status={active ? 'running' : undefined} className="text-xs">
          <TraceIcon>
            {active ? (
              <LoaderCircleIcon className="size-3.5 motion-safe:animate-spin" />
            ) : (
              <ListChecksIcon className="size-3.5" />
            )}
          </TraceIcon>
          <TraceTitle>{label ?? summary.label}</TraceTitle>
          {label !== undefined && <TraceDescription>{summary.toolCount} tool calls</TraceDescription>}
          <FailureMarker count={summary.failedCount} />
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="max-h-[min(24rem,60vh)] overflow-y-auto">
        <Trace>{children}</Trace>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}

export function TurnFoldRow({
  label,
  summary,
  groups,
  turnId,
  disclosureChoices,
  onDisclosureChange,
  open,
  onOpenChange,
}: {
  readonly label: string
  readonly summary: WorkSummary
  readonly groups: readonly WorkGroup[]
  readonly turnId?: string
  readonly disclosureChoices?: Readonly<Record<string, boolean>>
  readonly onDisclosureChange?: (key: string, open: boolean, turnId: string, withinFold: boolean) => void
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  return (
    <WorkLogCollapsible summary={summary} label={label} open={open} onOpenChange={onOpenChange}>
      {groups.map(group => (
        <WorkGroupRow
          key={group.key}
          group={group}
          turnId={turnId}
          withinFold
          disclosureChoices={disclosureChoices}
          onDisclosureChange={onDisclosureChange}
        />
      ))}
    </WorkLogCollapsible>
  )
}
