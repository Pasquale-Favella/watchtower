import type { ReactElement } from 'react'

import { Kbd } from '@/renderer/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'

import { composerActionHintRows } from './composer-state.js'

/** The submit button's tooltip: the keys that send, queue or steer, and what each does. */
export function ComposerActionTooltip({
  busy,
  canSteer,
  trigger,
}: {
  readonly busy: boolean
  readonly canSteer: boolean
  readonly trigger: ReactElement
}): ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger render={trigger} />
      <TooltipContent className="flex-col items-stretch gap-1">
        <ComposerActionHint busy={busy} canSteer={canSteer} />
      </TooltipContent>
    </Tooltip>
  )
}

export function ComposerActionHint({
  busy,
  canSteer,
}: {
  readonly busy: boolean
  readonly canSteer: boolean
}): ReactElement {
  return (
    <>
      {composerActionHintRows({ busy, canSteer }).map(row => (
        <div key={row.label} className="flex flex-col gap-0.5">
          <div className="flex items-center justify-between gap-4">
            <span className={row.muted ? 'text-background/75' : undefined}>{row.label}</span>
            {row.keys && (
              <span className="flex items-center gap-1">
                <Kbd>{row.keys}</Kbd>
                {row.orClick && (
                  <>
                    <span className="text-background/75">or</span>
                    <Kbd>{row.orClick}</Kbd>
                  </>
                )}
              </span>
            )}
          </div>
          {row.detail && <span className="text-background/75">{row.detail}</span>}
        </div>
      ))}
    </>
  )
}
