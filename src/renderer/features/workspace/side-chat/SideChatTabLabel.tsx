import { cn } from '@/renderer/shared/lib/utils'

import { useSideChatTabs } from './hooks.js'

/**
 * A side chat tab's title and status dot. The pane publishes the live title and state; the dot is muted while
 * running and warning-colored when the side chat needs approval or input.
 */
export function SideChatTabLabel({ id, fallback }: { readonly id: string; readonly fallback: string }) {
  const tab = useSideChatTabs()[id]
  const state = tab?.state ?? null
  return (
    <>
      {state && (
        <span
          aria-hidden="true"
          className={cn('size-1.5 shrink-0 rounded-full', state === 'running' ? 'bg-muted-foreground' : 'bg-warning')}
        />
      )}
      <span className="truncate">{tab?.title ?? fallback}</span>
    </>
  )
}
