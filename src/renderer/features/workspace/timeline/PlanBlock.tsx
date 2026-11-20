import { CheckIcon, CircleIcon, ClipboardListIcon, LoaderCircleIcon } from 'lucide-react'
import { useState } from 'react'

import { Markdown } from '@/renderer/components/Markdown'
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

import { CopyTextButton } from './MessageActions.js'
import { planCopyText, type PlanEntry } from './plan-text.js'

const stepIcons = { completed: CheckIcon, inProgress: LoaderCircleIcon, pending: CircleIcon } as const

export function PlanBlock({
  entries,
  explanation,
  streaming = false,
}: {
  readonly entries: readonly PlanEntry[]
  readonly explanation?: string | null
  readonly streaming?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const completed = entries.filter(entry => entry.status === 'completed').length
  const done = entries.length > 0 && completed === entries.length
  const active = !done && (streaming || entries.some(entry => entry.status === 'inProgress'))
  return (
    <TraceCollapsible open={open} onOpenChange={setOpen} className="group/plan text-xs">
      <div className="flex min-w-0 items-center gap-1">
        <TraceCollapsibleTrigger className="min-w-0">
          <TraceLine status={active ? 'running' : undefined} className="text-xs">
            <TraceIcon>
              {active ? (
                <LoaderCircleIcon className="size-3.5 motion-safe:animate-spin" />
              ) : (
                <ClipboardListIcon className="size-3.5" />
              )}
            </TraceIcon>
            <TraceTitle className="font-medium">Plan</TraceTitle>
            <TraceDescription className={cn(done && 'text-success')}>
              {done ? 'Completed' : `${completed}/${entries.length} completed`}
            </TraceDescription>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <span className="opacity-0 transition-opacity group-hover/plan:opacity-100 focus-within:opacity-100">
          <CopyTextButton text={planCopyText(entries, explanation)} label="Copy plan" />
        </span>
      </div>
      <TraceCollapsibleContent className="space-y-3">
        {explanation && (
          <div className="typeset text-muted-foreground text-xs break-words">
            <Markdown>{explanation}</Markdown>
          </div>
        )}
        {entries.length > 0 ? (
          <>
            <progress
              className="accent-primary h-1 w-full"
              aria-label="Plan progress"
              value={completed}
              max={entries.length}
            />
            <ol className="space-y-2" aria-label="Plan steps">
              {entries.map((entry, index) => {
                const Icon = stepIcons[entry.status]
                return (
                  <li key={index} className="flex items-start gap-2.5">
                    <Icon
                      aria-hidden
                      className={cn(
                        'mt-0.5 size-3.5 shrink-0',
                        entry.status === 'completed' ? 'text-success' : 'text-muted-foreground',
                        entry.status === 'inProgress' && 'text-primary motion-safe:animate-spin',
                      )}
                    />
                    <span className="sr-only">{entry.status === 'inProgress' ? 'In progress' : entry.status}</span>
                    <div
                      className={cn(
                        'typeset min-w-0 text-xs break-words',
                        entry.status === 'completed' && 'text-muted-foreground',
                      )}
                    >
                      <Markdown>{entry.content}</Markdown>
                    </div>
                  </li>
                )
              })}
            </ol>
          </>
        ) : (
          <p className="text-muted-foreground">{streaming ? 'Preparing the plan…' : 'No plan steps were provided.'}</p>
        )}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}
