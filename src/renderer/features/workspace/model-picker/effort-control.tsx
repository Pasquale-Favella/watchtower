import { ChevronDown } from 'lucide-react'

import { Button } from '@/renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/renderer/components/ui/dropdown-menu'

import type { EffortChoice } from './catalog.js'

/** Compact effort control. Its menu lists the selected model's effort choices, with the agent default first. */
export function EffortControl({
  options,
  value,
  open,
  onOpenChange,
  onChange,
}: {
  readonly options: readonly EffortChoice[]
  readonly value: string
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onChange: (modeId: string) => void
}) {
  const label = options.find(option => option.id === value)?.label ?? 'Effort'
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Effort"
            title={label}
            className="border-border h-7 max-w-40 min-w-0 gap-1.5 text-[11.5px] font-normal"
          />
        }
      >
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" sideOffset={8} className="min-w-36">
        <DropdownMenuRadioGroup value={value} onValueChange={next => onChange(String(next))}>
          <DropdownMenuRadioItem value="">Default</DropdownMenuRadioItem>
          {options.map(option => (
            <DropdownMenuRadioItem key={option.id} value={option.id}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
