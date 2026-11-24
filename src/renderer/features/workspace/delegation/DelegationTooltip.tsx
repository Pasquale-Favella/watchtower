import { type ComponentProps, type ReactElement, type ReactNode, useState } from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { HarnessIcon } from '@/renderer/features/coach-skills/harness-icon.js'
import type { DelegationRecord } from '@/shared/schemas/delegation.js'
import type { WorkspaceCheckout } from '@/shared/schemas/workspace.js'

import { formatRunDuration } from '../timeline/duration.js'
import { useElapsedMs } from '../timeline/use-elapsed.js'
import { type DelegateView, delegationDetailsPreview } from './delegation-view.js'
import { delegationDetailsElapsed } from './details-view.js'

/** The hover and focus card for a delegate: status, model, access, isolation, elapsed time and result preview. */
export function DelegationTooltip({
  view,
  children,
  className = 'block min-w-0',
  side = 'top',
}: {
  readonly view: DelegateView
  readonly children: ReactNode
  readonly className?: string
  readonly side?: ComponentProps<typeof TooltipContent>['side']
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={className} tabIndex={0} />}>{children}</TooltipTrigger>
      <TooltipContent
        side={side}
        align={side === 'top' ? 'start' : 'center'}
        className="max-w-72 flex-col items-start gap-0.5 text-left"
      >
        <DelegationTooltipBody view={view} />
      </TooltipContent>
    </Tooltip>
  )
}

export function DelegationTooltipBody({ view }: { readonly view: DelegateView }): React.JSX.Element {
  const liveElapsed = useElapsedMs(view.startedAt, view.live && view.durationMs === null)
  const elapsed = view.durationMs ?? liveElapsed
  return (
    <>
      <span className="max-w-full truncate font-medium">{view.title}</span>
      <span>Status: {view.statusLabel}</span>
      {view.model && <span className="text-background/75">Model: {view.model}</span>}
      {view.connection && <span className="text-background/75">Connection: {view.connection}</span>}
      {view.accessMode && (
        <span className="text-background/75">
          Access: {view.accessMode}
          {view.accessModeNote ? ` · ${view.accessModeNote}` : ''}
        </span>
      )}
      {view.isolation && <span className="text-background/75">{view.isolation}</span>}
      {elapsed !== null && <span className="text-background/75">Elapsed {formatRunDuration(elapsed)}</span>}
      {view.preview && (
        <span className="text-background/75 line-clamp-4 whitespace-normal">Result: {view.preview}</span>
      )}
    </>
  )
}

interface DetailsTooltipProps {
  readonly record: DelegationRecord
  readonly view: DelegateView
  readonly harnessKind: string
  readonly checkout: WorkspaceCheckout | undefined
  readonly trigger: ReactElement
  readonly children: ReactNode
}

export function DelegationDetailsTooltip({
  record,
  view,
  harnessKind,
  checkout,
  trigger,
  children,
}: DetailsTooltipProps): React.JSX.Element {
  const [openedAt, setOpenedAt] = useState<number | null>(null)
  const elapsed = delegationDetailsElapsed(record, openedAt)
  const preview = delegationDetailsPreview(record)
  const folder = checkout?.path.split(/[\\/]/).filter(Boolean).at(-1)
  const effort = record.modeId?.trim()

  return (
    <Tooltip
      onOpenChange={open => {
        if (open && view.live) setOpenedAt(Date.now())
      }}
    >
      <TooltipTrigger render={trigger}>{children}</TooltipTrigger>
      <TooltipContent side="left" className="max-w-72 flex-col items-start gap-0.5 text-left">
        <span className="max-w-full truncate font-medium">{view.title}</span>
        <span className="text-background/75 flex max-w-full items-center gap-1">
          <HarnessIcon kind={harnessKind} className="size-3 shrink-0" />
          <span className="min-w-0 wrap-anywhere">{[view.connection, view.model].filter(Boolean).join(' · ')}</span>
        </span>
        {effort && <span className="text-background/75 max-w-full wrap-anywhere">Effort: {effort}</span>}
        <span>Status: {view.statusLabel}</span>
        {elapsed !== null && <span className="text-background/75">Elapsed {formatRunDuration(elapsed)}</span>}
        {view.accessMode && (
          <span className="text-background/75">
            Access: {view.accessMode}
            {view.accessModeNote ? ` · ${view.accessModeNote}` : ''}
          </span>
        )}
        <span className="text-background/75 max-w-full wrap-anywhere">
          {[view.isolation, checkout?.branch, folder].filter(Boolean).join(' · ')}
        </span>
        {preview && (
          <span className="text-background/75 mt-0.5 wrap-anywhere whitespace-normal">
            {view.live ? preview : `Result: ${preview}`}
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
