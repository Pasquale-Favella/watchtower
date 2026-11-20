import type { ComponentProps, ReactNode } from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'

import { formatRunDuration } from '../timeline/duration.js'
import { useElapsedMs } from '../timeline/use-elapsed.js'
import type { DelegateView } from './delegation-view.js'

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
