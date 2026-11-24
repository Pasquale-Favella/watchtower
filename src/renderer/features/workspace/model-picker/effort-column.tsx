import { Check } from 'lucide-react'
import type { KeyboardEvent } from 'react'

import { cn } from '@/renderer/shared/lib/utils'

import type { EffortChoice } from './catalog.js'

const ROW =
  'text-foreground hover:bg-foreground/10 focus-visible:bg-foreground/10 flex h-8 w-full shrink-0 cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-[12px] outline-none'

function moveBetweenRows(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-effort-row]'))
  const index = rows.findIndex(row => row === document.activeElement)
  const next = rows[Math.min(rows.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))]
  if (!next) return
  event.preventDefault()
  event.stopPropagation()
  next.focus()
}

/**
 * The model picker's effort column: the agent default, then the selected model's levels. The header names the
 * control and the model it applies to. A model without levels says so instead of hiding the column.
 */
export function EffortColumn({
  title,
  modelLabel,
  options,
  value,
  onPick,
  onLeave,
}: {
  readonly title: string
  readonly modelLabel: string
  /** Null while the model's levels are unknown. */
  readonly options: readonly EffortChoice[] | null
  readonly value: string
  readonly onPick: (modeId: string) => void
  /** ArrowLeft returns to the model search. */
  readonly onLeave: () => void
}) {
  const rows = options && options.length > 0 ? [{ id: '', label: 'Default' }, ...options] : []
  const shown = rows.some(row => row.id === value)
  return (
    <div
      data-effort-column
      className="border-border/70 bg-muted/40 flex min-h-0 w-44 shrink-0 flex-col border-l"
      onKeyDown={event => {
        if (event.key !== 'ArrowLeft') return
        event.preventDefault()
        event.stopPropagation()
        onLeave()
      }}
    >
      <div className="shrink-0 px-3 pt-2">
        <div className="border-border/70 flex h-[37px] items-center gap-2 border-b pb-2 text-[12px]">
          <span className="text-muted-foreground">{title}</span>
          <span className="text-muted-foreground ms-auto min-w-0 truncate text-[11px]">{modelLabel}</span>
        </div>
      </div>
      <div
        role="radiogroup"
        aria-label={title}
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain px-1.5 pt-1.5 pb-1.5"
        onKeyDownCapture={moveBetweenRows}
      >
        {rows.length === 0 ? (
          <div className="text-muted-foreground flex h-8 items-center px-2 text-[12px]">
            {options === null ? 'Choose a model' : `No ${title.toLowerCase()} levels`}
          </div>
        ) : (
          rows.map((row, index) => {
            const selected = row.id === value
            return (
              <button
                key={row.id || 'default'}
                type="button"
                role="radio"
                aria-checked={selected}
                data-effort-row
                tabIndex={(shown ? selected : index === 0) ? 0 : -1}
                className={cn(ROW, selected && 'bg-foreground/5')}
                onClick={() => onPick(row.id)}
              >
                <span className={cn('min-w-0 flex-1 truncate', row.id === '' && 'text-muted-foreground')}>
                  {row.label}
                </span>
                {selected && <Check aria-hidden className="size-3.5" />}
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
