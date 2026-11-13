import { useState } from 'react'

import { Button } from '@/renderer/components/ui/button'

const COLLAPSED_HEIGHT_CLASS = 'max-h-[11rem] overflow-hidden'

/**
 * Long user messages fold to about eight lines. The fold is local to the message view, so it resets
 * when the transcript is re-projected for another Conversation.
 */
export function ExpandableMessage({
  expandable,
  children,
}: {
  readonly expandable: boolean
  readonly children: React.ReactNode
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  if (!expandable) return <>{children}</>
  return (
    <div className="min-w-0">
      <div className={expanded ? undefined : `${COLLAPSED_HEIGHT_CLASS} relative`}>
        {children}
        {!expanded && (
          <div
            aria-hidden
            className="from-primary/10 pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t to-transparent"
          />
        )}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="mt-1 h-6 px-1.5 text-xs"
        aria-expanded={expanded}
        onClick={() => {
          setExpanded(current => !current)
        }}
      >
        {expanded ? 'Show less' : 'Show full message'}
      </Button>
    </div>
  )
}
