import { CheckIcon, ChevronRightIcon, CircleIcon, ClipboardListIcon, LoaderCircleIcon } from 'lucide-react'
import { useState } from 'react'

import { Markdown } from '@/renderer/components/Markdown'
import { Badge } from '@/renderer/components/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/renderer/components/ui/collapsible'
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
    <Collapsible open={open} onOpenChange={setOpen} className="bg-card overflow-hidden rounded-lg border text-xs">
      <div className="flex min-w-0 items-center gap-1 pr-1.5">
        <CollapsibleTrigger className="group/disclosure flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left">
          <ChevronRightIcon
            aria-hidden
            className="text-muted-foreground size-3 shrink-0 transition-transform group-data-[panel-open]/disclosure:rotate-90"
          />
          <ClipboardListIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 font-medium">Plan</span>
          <Badge variant="secondary" className="gap-1 text-[10px]">
            {active && <LoaderCircleIcon aria-hidden className="size-3 motion-safe:animate-spin" />}
            {done ? 'Completed' : `${completed}/${entries.length} completed`}
          </Badge>
        </CollapsibleTrigger>
        <CopyTextButton text={planCopyText(entries, explanation)} label="Copy plan" />
      </div>
      <CollapsibleContent className="space-y-3 border-t px-3 py-2.5">
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
      </CollapsibleContent>
    </Collapsible>
  )
}
