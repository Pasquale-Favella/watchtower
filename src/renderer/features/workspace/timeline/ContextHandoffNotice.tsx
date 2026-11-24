import { ArrowRightIcon, ArrowRightLeftIcon } from 'lucide-react'

import { TextTooltip } from '@/renderer/components/ui/tooltip'
import { HarnessIcon } from '@/renderer/features/coach-skills/harness-icon.js'

import type { HandoffEndpoint } from '../conversation-view.js'

/** A centered divider marking where a conversation's context moved to a new agent attempt. */
export function ContextHandoffNotice({
  source,
  target,
  highWatermark,
  truncated,
  harnessKinds,
}: {
  readonly source: HandoffEndpoint | null
  readonly target: HandoffEndpoint
  readonly highWatermark: number
  readonly truncated: boolean
  readonly harnessKinds: ReadonlyMap<string, string>
}): React.JSX.Element {
  const scope = `Includes conversation through event ${highWatermark}${truncated ? ' · context shortened' : ''}`
  return (
    <article
      className="text-muted-foreground flex min-w-0 items-center gap-2 py-2 text-xs"
      aria-label="Context handoff prepared"
    >
      <span aria-hidden className="bg-border/70 h-px flex-1" />
      <TextTooltip
        label={scope}
        trigger={
          <span
            tabIndex={0}
            className="focus-visible:ring-ring inline-flex min-w-0 flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-sm focus-visible:ring-2 focus-visible:outline-none"
          >
            <span className="inline-flex shrink-0 items-center gap-1.5 font-medium">
              <ArrowRightLeftIcon aria-hidden className="size-3 shrink-0" />
              Context handoff
            </span>
            <span className="inline-flex min-w-0 items-center gap-1.5 opacity-80">
              {source ? (
                <HandoffEndpointLabel endpoint={source} harnessKind={harnessKinds.get(source.connectionId)} />
              ) : (
                <span className="italic">Unavailable connection</span>
              )}
              <ArrowRightIcon aria-hidden className="size-3 shrink-0" />
              <HandoffEndpointLabel endpoint={target} harnessKind={harnessKinds.get(target.connectionId)} />
            </span>
            {truncated ? (
              <span className="border-border/70 rounded-full border px-1.5 text-[10px] leading-4">shortened</span>
            ) : null}
            <span className="sr-only">{scope}</span>
          </span>
        }
      />
      <span aria-hidden className="bg-border/70 h-px flex-1" />
    </article>
  )
}

function HandoffEndpointLabel({
  endpoint,
  harnessKind,
}: {
  readonly endpoint: HandoffEndpoint
  readonly harnessKind: string | undefined
}): React.JSX.Element {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <HarnessIcon kind={harnessKind ?? ''} className="size-3 shrink-0" />
      <span className="text-foreground/80 truncate font-medium">{endpoint.connection}</span>
      {endpoint.model ? <span className="truncate">· {endpoint.model}</span> : null}
    </span>
  )
}
