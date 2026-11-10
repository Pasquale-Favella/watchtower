import { Cpu, MessagesSquare } from 'lucide-react'

import type { PromptMenuItem } from './prompt-search.js'
import { WorkspaceFileIcon } from './WorkspaceFileIcon.js'

type Props = {
  readonly item: PromptMenuItem
}

export function PromptMentionResult({ item }: Props): React.JSX.Element {
  return (
    <>
      {item.category === 'file' ? (
        <WorkspaceFileIcon path={item.path ?? item.label} />
      ) : item.category === 'conversation' ? (
        <MessagesSquare aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
      ) : (
        <Cpu aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
      )}
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="max-w-[45%] min-w-0 shrink-0 truncate font-sans text-xs font-medium">{item.label}</span>
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-left text-xs">{item.description}</span>
      </span>
    </>
  )
}
