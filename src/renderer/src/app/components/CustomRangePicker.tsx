import { useState } from 'react'
import type { DateRange as DayPickerRange } from 'react-day-picker'
import { CalendarIcon } from 'lucide-react'

import { Button } from '@/shared/components/ui/button'
import { Calendar } from '@/shared/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/components/ui/popover'
import { cn } from '@/shared/lib/utils'

import type { DateRange } from '../../../../shared/schemas/renderer.js'
export type { DateRange }

/** Local calendar-date key ("YYYY-MM-DD") — mirrors `main/overview.ts`'s
 * `localDateKey` so a picked range compares correctly against the report's
 * own date buckets. */
function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function fromDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}

/**
 * Custom date-range control — a shadcn Popover + Calendar (range mode) date
 * picker that opens from a "Custom" button next to the period SegTabs, so
 * users pick an exact historical window from a real calendar instead of
 * typing raw dates.
 */
export function CustomRangePicker({
  value,
  onApply,
  onClear,
}: {
  value: DateRange | null
  onApply: (range: DateRange) => void
  onClear: () => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<DayPickerRange | undefined>(
    value ? { from: fromDateKey(value.since), to: fromDateKey(value.until) } : undefined,
  )

  return (
    <Popover
      open={open}
      onOpenChange={next => {
        setOpen(next)
        if (next) {
          setDraft(value ? { from: fromDateKey(value.since), to: fromDateKey(value.until) } : undefined)
        }
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn('h-[25px] gap-1 rounded-md border-border px-2 text-[11px]', value && 'text-foreground')}
            aria-expanded={open}
          >
            <CalendarIcon className="size-3" />
            {value ? `${value.since} → ${value.until}` : 'Custom range'}
          </Button>
        }
      />
      <PopoverContent align="end" className="w-auto p-3">
        <Calendar
          mode="range"
          numberOfMonths={2}
          defaultMonth={draft?.from}
          selected={draft}
          onSelect={range => setDraft(range)}
        />
        <div className="flex justify-between gap-2 border-t border-border pt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft(undefined)
              onClear()
              setOpen(false)
            }}
          >
            Clear
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!draft?.from || !draft?.to}
            onClick={() => {
              if (!draft?.from || !draft?.to) return
              onApply({ since: toDateKey(draft.from), until: toDateKey(draft.to) })
              setOpen(false)
            }}
          >
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
