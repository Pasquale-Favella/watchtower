import { BrainIcon, ChevronRightIcon, LoaderCircleIcon } from 'lucide-react'
import { useState } from 'react'

import { Markdown } from '@/renderer/components/Markdown'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/renderer/components/ui/collapsible'

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
      ?.trim() ?? ''
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="text-muted-foreground bg-muted/20 overflow-hidden rounded-lg border text-xs"
    >
      <div className="flex min-w-0 items-center gap-1 pr-1.5">
        <CollapsibleTrigger className="group/disclosure flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left">
          <ChevronRightIcon
            aria-hidden
            className="size-3 shrink-0 transition-transform group-data-[panel-open]/disclosure:rotate-90"
          />
          {streaming ? (
            <LoaderCircleIcon aria-hidden className="size-3.5 shrink-0 motion-safe:animate-spin" />
          ) : (
            <BrainIcon aria-hidden className="size-3.5 shrink-0" />
          )}
          <span className="shrink-0 font-medium">{streaming ? 'Thinking…' : 'Reasoning'}</span>
          {!open && preview && <span className="min-w-0 truncate">{preview}</span>}
        </CollapsibleTrigger>
        {text && <CopyTextButton text={text} label="Copy reasoning" />}
      </div>
      <CollapsibleContent className="border-t px-3 py-2.5">
        <div className="typeset max-h-96 overflow-auto text-xs break-words">
          <Markdown streaming={streaming}>{text}</Markdown>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
