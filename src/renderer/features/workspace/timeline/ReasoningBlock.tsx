import { BrainIcon } from 'lucide-react'
import { useState } from 'react'

import { Markdown } from '@/renderer/components/Markdown'
import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/renderer/components/ui/trace'

import { CopyTextButton } from './MessageActions.js'

export function ReasoningBlock({
  text,
  streaming,
}: {
  readonly text: string
  readonly streaming: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const preview =
    text
      .split('\n')
      .find(line => line.trim())
      ?.replace(/[*_`#>]+/g, '')
      .trim() ?? ''
  return (
    <TraceCollapsible open={open} onOpenChange={setOpen} className="group/reasoning text-xs">
      <div className="flex min-w-0 items-center gap-1">
        <TraceCollapsibleTrigger className="min-w-0">
          <TraceLine status={streaming ? 'running' : undefined} className="text-xs">
            <TraceIcon>
              <BrainIcon />
            </TraceIcon>
            <TraceTitle className="shrink-0 overflow-visible font-medium">
              {streaming ? 'Thinking…' : 'Reasoning'}
            </TraceTitle>
            {!open && preview && <span className="text-muted-foreground/70 min-w-0 truncate">{preview}</span>}
          </TraceLine>
        </TraceCollapsibleTrigger>
        {text && (
          <span className="opacity-0 transition-opacity group-hover/reasoning:opacity-100 focus-within:opacity-100">
            <CopyTextButton text={text} label="Copy reasoning" />
          </span>
        )}
      </div>
      <TraceCollapsibleContent>
        <div className="typeset max-h-96 overflow-auto text-xs break-words">
          <Markdown streaming={streaming}>{text}</Markdown>
        </div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}
