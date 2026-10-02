import { Info } from 'lucide-react'

import { cn } from '@/shared/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/components/ui/tooltip'

/** InfoTip — a small info icon with a hover/focus tooltip explaining a metric.
 *  Used next to bento labels so each number carries its practical meaning
 *  without cluttering the card. */
export function InfoTip({ label, text, className }: { label: string; text: string; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            className={cn(
              'text-muted-foreground/70 hover:text-foreground focus-visible:outline-ring inline-flex shrink-0 cursor-help items-center rounded-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-1',
              className,
            )}
          >
            <Info className="size-3.5" aria-hidden="true" />
          </button>
        }
      />
      <TooltipContent side="top" align="center" className="max-w-[240px] text-left leading-relaxed">
        {text}
      </TooltipContent>
    </Tooltip>
  )
}
