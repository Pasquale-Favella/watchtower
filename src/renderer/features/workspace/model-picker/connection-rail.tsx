import type { KeyboardEvent, Ref } from 'react'

import { Button } from '@/renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { HarnessIcon } from '@/renderer/features/coach-skills/harness-icon.js'
import { HarnessStatusDot } from '@/renderer/features/coach-skills/harness-status.js'
import { statusLabel } from '@/renderer/features/coach-skills/lib.js'
import { cn } from '@/renderer/shared/lib/utils'
import type { CoachHarnessRow } from '@/shared/schemas/agents.js'
import type { WorkspaceConnection } from '@/shared/schemas/workspace-connections.js'

const LOCKED_CONNECTION_MESSAGE = 'Start a new chat to use another agent'

/** Harness rail: one icon per detected agent. Browsing previews an agent. Committing happens on a model pick. */
export function ConnectionRail({
  railRef,
  connections,
  previewId,
  lockedId,
  statusOf,
  onPreview,
  onLeaveRail,
}: {
  readonly railRef: Ref<HTMLDivElement>
  readonly connections: readonly WorkspaceConnection[]
  readonly previewId: string
  readonly lockedId: string | undefined
  readonly statusOf: (connectionId: string) => CoachHarnessRow['status']
  readonly onPreview: (connectionId: string) => void
  /** ArrowRight leaves the rail for the search field. */
  readonly onLeaveRail: () => void
}) {
  function moveFocus(event: KeyboardEvent<HTMLDivElement>, delta: number) {
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-rail-item]:not([aria-disabled="true"])'),
    )
    const index = items.findIndex(item => item === event.target)
    const next = items[(index + delta + items.length) % items.length]
    next?.focus()
  }

  return (
    <div
      ref={railRef}
      role="group"
      aria-label="Agents"
      className="bg-muted/30 w-11 shrink-0 overflow-y-auto p-1"
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          moveFocus(event, event.key === 'ArrowDown' ? 1 : -1)
        } else if (event.key === 'ArrowRight') {
          event.preventDefault()
          onLeaveRail()
        }
      }}
    >
      <div className="relative flex min-h-full flex-col gap-1">
        {connections.map(connection => {
          const locked = lockedId !== undefined && connection.connectionId !== lockedId
          const selected = connection.connectionId === previewId
          const status = locked ? 'disabled' : statusOf(connection.connectionId)
          const tooltip = locked ? LOCKED_CONNECTION_MESSAGE : `${connection.label} — ${statusLabel(status)}`
          return (
            <div key={connection.connectionId} className="h-9 w-full shrink-0">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-lg"
                      data-rail-item
                      aria-label={connection.label}
                      aria-pressed={selected}
                      aria-disabled={locked ? true : undefined}
                      onClick={() => {
                        if (!locked) onPreview(connection.connectionId)
                      }}
                      className={cn(
                        'text-muted-foreground hover:bg-primary/10 hover:text-foreground focus-visible:bg-primary/10 relative isolate w-full rounded-md',
                        selected && 'bg-primary/15 text-primary hover:bg-primary/20',
                        locked && 'opacity-50',
                      )}
                    />
                  }
                >
                  <HarnessIcon kind={connection.harnessKind} className="size-5" />
                  <HarnessStatusDot status={status} className="absolute top-0.5 right-0.5" />
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8} className="max-w-64">
                  {tooltip}
                </TooltipContent>
              </Tooltip>
            </div>
          )
        })}
      </div>
    </div>
  )
}
