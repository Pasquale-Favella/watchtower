import type { KeyboardEvent, Ref } from 'react'

import { Button } from '@/renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { HarnessIcon } from '@/renderer/features/coach-skills/harness-icon.js'
import { HarnessStatusDot } from '@/renderer/features/coach-skills/harness-status.js'
import { statusLabel } from '@/renderer/features/coach-skills/lib.js'
import { cn } from '@/renderer/shared/lib/utils'
import type { WorkspaceConnection } from '@/shared/schemas/workspace-connections.js'

import { useWorkspaceConnectionCatalog, type WorkspaceConnectionCatalog } from '../connection-hooks.js'
import { connectionDetail, connectionStatus } from './catalog.js'

const LOCKED_CONNECTION_MESSAGE = 'Start a new chat to use another agent'

type ConnectionReading = Pick<WorkspaceConnectionCatalog, 'inspection' | 'pending' | 'failed'>

/**
 * Harness rail: one icon per detected agent, each with its status. Browsing previews an
 * agent. Committing happens on a model pick. Every agent reads its inspection shared since startup.
 */
export function ConnectionRail({
  railRef,
  connections,
  previewId,
  lockedId,
  readingOf,
  onPreview,
  onLeaveRail,
}: {
  readonly railRef: Ref<HTMLDivElement>
  readonly connections: readonly WorkspaceConnection[]
  readonly previewId: string
  readonly lockedId: string | undefined
  /** A reading that wins over the agent's own, such as the active agent's merged with session facts. */
  readonly readingOf: (connectionId: string) => ConnectionReading | undefined
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
        {connections.map(connection => (
          <RailItem
            key={connection.connectionId}
            connection={connection}
            selected={connection.connectionId === previewId}
            locked={lockedId !== undefined && connection.connectionId !== lockedId}
            override={readingOf(connection.connectionId)}
            onPreview={() => onPreview(connection.connectionId)}
          />
        ))}
      </div>
    </div>
  )
}

function RailItem({
  connection,
  selected,
  locked,
  override,
  onPreview,
}: {
  readonly connection: WorkspaceConnection
  readonly selected: boolean
  readonly locked: boolean
  readonly override: ConnectionReading | undefined
  readonly onPreview: () => void
}) {
  const own = useWorkspaceConnectionCatalog(connection.connectionId)
  const reading = override ?? own
  const status = locked ? 'disabled' : connectionStatus(reading)
  const detail = locked ? null : connectionDetail(reading)
  const tooltip = locked
    ? LOCKED_CONNECTION_MESSAGE
    : `${connection.label} — ${detail && status !== 'pending' ? detail : statusLabel(status)}`
  return (
    <div className="h-9 w-full shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              data-rail-item
              aria-label={connection.label}
              aria-description={locked ? undefined : (detail ?? statusLabel(status))}
              aria-pressed={selected}
              aria-disabled={locked ? true : undefined}
              onClick={() => {
                if (!locked) onPreview()
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
}
