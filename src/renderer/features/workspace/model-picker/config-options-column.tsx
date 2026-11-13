import { Check, ChevronDown } from 'lucide-react'
import { type KeyboardEvent, useRef, useState } from 'react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/renderer/components/ui/dropdown-menu'
import { cn } from '@/renderer/shared/lib/utils'
import type { AgentConfigOption } from '@/shared/schemas/execution.js'

import {
  configValueForOption,
  configValuesForOptions,
  isModelSpecificConfigOption,
  orderedConfigOptions,
} from '../config-values.js'
import type { EffortChoice } from './catalog.js'

const ROW =
  'text-foreground hover:bg-foreground/10 focus-visible:bg-foreground/10 flex h-8 w-full shrink-0 cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-[12px] outline-none'

function moveBetweenRows(event: KeyboardEvent<HTMLDivElement>): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-config-option-row]'))
  const index = rows.findIndex(row => row === document.activeElement)
  const next = rows[Math.min(rows.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))]
  if (!next) return
  event.preventDefault()
  event.stopPropagation()
  next.focus()
}

export function ConfigOptionsColumn({
  options,
  values,
  effort,
  onPick,
  onLeave,
}: {
  readonly options: readonly AgentConfigOption[]
  readonly values: Readonly<Record<string, string>>
  readonly effort?: {
    readonly title: string
    readonly modelLabel: string
    readonly options: readonly EffortChoice[]
    readonly value: string
    readonly onPick: (value: string) => void
  }
  readonly onPick: (id: string, value: string) => void
  readonly onLeave: () => void
}): React.JSX.Element {
  const validValues = configValuesForOptions(options, values)

  return (
    <div
      data-effort-column
      className="border-border/70 bg-muted/40 flex min-h-0 w-48 shrink-0 flex-col border-l"
      onKeyDown={event => {
        if (event.key !== 'ArrowLeft') return
        event.preventDefault()
        event.stopPropagation()
        onLeave()
      }}
    >
      <div className="shrink-0 px-3 pt-2">
        <div className="border-border/70 flex h-[37px] items-center border-b pb-2 text-[12px]">
          <span className="text-muted-foreground">Agent options</span>
        </div>
      </div>
      <div
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-1.5 pt-1.5 pb-1.5"
        onKeyDownCapture={moveBetweenRows}
      >
        {effort?.title === 'Effort' && <EffortRows effort={effort} />}
        {orderedConfigOptions(options).map(option => {
          const value = configValueForOption(option, validValues)
          const selected = option.options.find(choice => choice.id === value)
          return (
            <section key={option.id} className="min-w-0">
              {isEffortOption(option) ? (
                <>
                  <div className="px-2 pb-1">
                    <p className="truncate text-[11px] font-medium" title={option.description ?? option.label}>
                      {option.label}
                    </p>
                    {option.description && (
                      <p className="text-muted-foreground truncate text-[10px]" title={option.description}>
                        {option.description}
                      </p>
                    )}
                  </div>
                  <div role="radiogroup" aria-label={option.label}>
                    {option.options.map((choice, index) => {
                      const checked = choice.id === value
                      return (
                        <button
                          key={choice.id}
                          type="button"
                          role="radio"
                          aria-checked={checked}
                          aria-label={choice.description ? `${choice.label}: ${choice.description}` : choice.label}
                          data-config-option-row
                          tabIndex={checked || (!selected && index === 0) ? 0 : -1}
                          className={cn(ROW, checked && 'bg-foreground/5')}
                          onClick={() => onPick(option.id, choice.id)}
                        >
                          <span className="min-w-0 flex-1 truncate" title={choice.description ?? choice.label}>
                            {choice.label}
                          </span>
                          {checked && <Check aria-hidden className="size-3.5" />}
                        </button>
                      )
                    })}
                  </div>
                </>
              ) : (
                <ConfigOptionPicker option={option} value={value} selectedLabel={selected?.label} onPick={onPick} />
              )}
            </section>
          )
        })}
        {effort?.title === 'Mode' && <EffortRows effort={effort} />}
      </div>
    </div>
  )
}

function EffortRows({
  effort,
}: {
  readonly effort: {
    readonly title: string
    readonly modelLabel: string
    readonly options: readonly EffortChoice[]
    readonly value: string
    readonly onPick: (value: string) => void
  }
}): React.JSX.Element {
  const rows = [{ id: '', label: 'Default' }, ...effort.options]
  const hasSelectedRow = rows.some(row => row.id === effort.value)
  return (
    <section className="min-w-0">
      <div className="flex items-center gap-2 px-2 pb-1">
        <p className="truncate text-[11px] font-medium">{effort.title}</p>
        <p className="text-muted-foreground ms-auto min-w-0 truncate text-[10px]">{effort.modelLabel}</p>
      </div>
      <div role="radiogroup" aria-label={effort.title}>
        {rows.map((choice, index) => {
          const checked = choice.id === effort.value
          return (
            <button
              key={choice.id || 'default'}
              type="button"
              role="radio"
              aria-checked={checked}
              data-config-option-row
              tabIndex={checked || (!hasSelectedRow && index === 0) ? 0 : -1}
              className={cn(ROW, checked && 'bg-foreground/5')}
              onClick={() => effort.onPick(choice.id)}
            >
              <span className={cn('min-w-0 flex-1 truncate', choice.id === '' && 'text-muted-foreground')}>
                {choice.label}
              </span>
              {checked && <Check aria-hidden className="size-3.5" />}
            </button>
          )
        })}
      </div>
    </section>
  )
}

function ConfigOptionPicker({
  option,
  value,
  selectedLabel,
  onPick,
}: {
  readonly option: AgentConfigOption
  readonly value: string
  readonly selectedLabel: string | undefined
  readonly onPick: (id: string, value: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const keyboardOpenRef = useRef(false)

  return (
    <DropdownMenu
      open={open}
      onOpenChange={next => {
        if (!next) keyboardOpenRef.current = false
        setOpen(next)
      }}
      onOpenChangeComplete={next => {
        if (!next || !keyboardOpenRef.current) return
        keyboardOpenRef.current = false
        const items = Array.from(contentRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])
        const selected = items.find(item => item.getAttribute('aria-checked') === 'true')
        ;(selected ?? items[0])?.focus()
      }}
    >
      <DropdownMenuTrigger
        ref={triggerRef}
        aria-label={`${option.label}: ${selectedLabel ?? 'Default'}`}
        data-config-option-row
        onKeyDown={event => {
          if (event.key !== 'ArrowRight') return
          event.preventDefault()
          event.stopPropagation()
          keyboardOpenRef.current = true
          setOpen(true)
        }}
        className="text-foreground hover:bg-foreground/10 focus-visible:bg-foreground/10 flex h-8 w-full cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-[12px] outline-none"
      >
        <span className="text-muted-foreground w-12 shrink-0 truncate">{option.label}</span>
        <span className="min-w-0 flex-1 truncate">{selectedLabel ?? 'Default'}</span>
        <ChevronDown aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        ref={contentRef}
        align="start"
        className="min-w-44"
        onKeyDown={event => {
          if (event.key !== 'ArrowLeft') return
          event.preventDefault()
          event.stopPropagation()
          setOpen(false)
          requestAnimationFrame(() => triggerRef.current?.focus())
        }}
      >
        <DropdownMenuRadioGroup aria-label={option.label} value={value} onValueChange={next => onPick(option.id, next)}>
          <DropdownMenuLabel>{option.label}</DropdownMenuLabel>
          {option.options.map(choice => (
            <DropdownMenuRadioItem key={choice.id} value={choice.id} aria-label={choice.label} closeOnClick>
              {choice.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function isEffortOption(option: AgentConfigOption): boolean {
  return isModelSpecificConfigOption(option.id, [option])
}
