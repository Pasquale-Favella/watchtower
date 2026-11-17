import { ArrowDown, ArrowLeft, ArrowUp } from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import { cn } from '@/renderer/shared/lib/utils'

import { isMac, submitModifier } from './platform-labels.js'

export interface PaletteRow {
  readonly id: string
  readonly icon: ReactNode
  readonly title: string
  readonly description?: string
  readonly trailing?: ReactNode
  readonly disabled?: boolean
  readonly onActivate: () => void
}

export interface PaletteSubmit {
  readonly label: string
  readonly disabled: boolean
  readonly onSubmit: () => void
}

export function Kbd({ children }: { readonly children: ReactNode }) {
  return (
    <kbd className="bg-muted text-muted-foreground inline-flex h-5 min-w-5 items-center justify-center rounded px-1 font-sans text-[0.6875rem] font-medium [&_svg]:size-3">
      {children}
    </kbd>
  )
}

export function FooterAction({
  children,
  disabled,
  onClick,
}: {
  readonly children: ReactNode
  readonly disabled?: boolean
  readonly onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="hover:text-foreground focus-visible:outline-ring cursor-pointer font-medium underline-offset-2 hover:underline focus-visible:outline-2 disabled:pointer-events-none disabled:opacity-50"
    >
      {children}
    </button>
  )
}

interface Props {
  readonly inputLabel: string
  readonly placeholder: string
  readonly value: string
  readonly onValueChange: (value: string) => void
  readonly icon: ReactNode
  readonly onBack?: () => void
  readonly disabled?: boolean
  /** Highlight state resets whenever this changes, e.g. after browsing into another folder. */
  readonly resetKey: string
  readonly rows: readonly PaletteRow[]
  readonly groupLabel?: string
  /** Enter activates the first enabled row while nothing is highlighted. */
  readonly autoHighlight?: boolean
  readonly submit?: PaletteSubmit
  readonly onTab?: (active: PaletteRow | null) => void
  readonly header?: ReactNode
  readonly hint?: string | null
  readonly emptyMessage?: string | null
  readonly error?: string | null
  readonly footerTrailing?: ReactNode
}

/** The add-project palette: one input, a keyboard-driven option list and a shortcut footer. */
export function WorkspaceAddProjectFrame({
  inputLabel,
  placeholder,
  value,
  onValueChange,
  icon,
  onBack,
  disabled,
  resetKey,
  rows,
  groupLabel,
  autoHighlight = false,
  submit,
  onTab,
  header,
  hint,
  emptyMessage,
  error,
  footerTrailing,
}: Props) {
  const listId = useId()
  const [highlight, setHighlight] = useState<{ readonly key: string; readonly id: string | null }>({
    key: resetKey,
    id: null,
  })
  const enabledRows = rows.filter(row => !row.disabled)
  const chosen = highlight.key === resetKey ? enabledRows.find(row => row.id === highlight.id) : undefined
  const active = chosen ?? (autoHighlight ? enabledRows[0] : undefined) ?? null
  const optionId = (row: PaletteRow) => `${listId}-${rows.indexOf(row)}`
  const highlightRow = (row: PaletteRow | null) => setHighlight({ key: resetKey, id: row?.id ?? null })
  const submitShortcut = chosen ? `${submitModifier} Enter` : 'Enter'
  const enterLabel = active ? 'Select' : (submit?.label ?? 'Select')

  const move = (offset: 1 | -1) => {
    if (enabledRows.length === 0) return
    const index = active === null ? (offset === 1 ? 0 : enabledRows.length - 1) : enabledRows.indexOf(active) + offset
    const next = enabledRows[(index + enabledRows.length) % enabledRows.length] ?? null
    highlightRow(next)
    if (next) document.getElementById(optionId(next))?.scrollIntoView({ block: 'nearest' })
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    const modifier = isMac ? event.metaKey : event.ctrlKey
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault()
        move(event.key === 'ArrowDown' ? 1 : -1)
        return
      case 'Enter':
        event.preventDefault()
        if (active && !(modifier && submit)) active.onActivate()
        else if (submit && !submit.disabled) submit.onSubmit()
        return
      case 'Tab':
        if (!onTab || event.shiftKey) return
        event.preventDefault()
        onTab(chosen ?? null)
        return
      case 'Backspace':
        if (value === '' && onBack) {
          event.preventDefault()
          onBack()
        }
    }
  }

  return (
    <div className="flex flex-col">
      <div className="relative flex items-center gap-2 border-b px-3">
        {onBack ? (
          <button
            type="button"
            aria-label="Back"
            onClick={onBack}
            className="text-muted-foreground hover:text-foreground focus-visible:outline-ring flex shrink-0 cursor-pointer items-center rounded-sm focus-visible:outline-2 [&_svg]:size-4"
          >
            <ArrowLeft />
          </button>
        ) : (
          <span aria-hidden="true" className="text-muted-foreground flex shrink-0 [&_svg]:size-4">
            {icon}
          </span>
        )}
        <input
          role="combobox"
          aria-label={inputLabel}
          aria-expanded={rows.length > 0}
          aria-controls={listId}
          aria-activedescendant={active ? optionId(active) : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          onChange={event => {
            highlightRow(null)
            onValueChange(event.target.value)
          }}
          onKeyDown={onKeyDown}
          className={cn(
            'placeholder:text-muted-foreground h-11 min-w-0 flex-1 bg-transparent text-sm outline-hidden disabled:opacity-50',
            submit && 'pe-36',
          )}
        />
        {submit && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            tabIndex={-1}
            className="absolute top-1/2 right-2.5 -translate-y-1/2"
            aria-label={`${submit.label} (${submitShortcut})`}
            disabled={submit.disabled}
            onMouseDown={event => event.preventDefault()}
            onClick={submit.onSubmit}
          >
            {submit.label}
            <Kbd>{submitShortcut}</Kbd>
          </Button>
        )}
      </div>
      {header}
      <div className="max-h-[min(24rem,60vh)] overflow-y-auto p-1">
        {error && (
          <p role="alert" className="text-destructive px-2 py-2 text-sm">
            {error}
          </p>
        )}
        {hint && <p className="text-muted-foreground px-2 py-1.5 text-xs">{hint}</p>}
        {emptyMessage ? (
          <p role="status" className="text-muted-foreground px-2 py-6 text-center text-sm">
            {emptyMessage}
          </p>
        ) : (
          rows.length > 0 && (
            <>
              {groupLabel && <div className="text-muted-foreground px-2 py-1.5 text-xs font-medium">{groupLabel}</div>}
              <div role="listbox" id={listId} aria-label={groupLabel ?? inputLabel}>
                {rows.map(row => (
                  <div
                    key={row.id}
                    id={optionId(row)}
                    role="option"
                    aria-selected={row === active}
                    aria-disabled={row.disabled || undefined}
                    title={row.description}
                    onMouseMove={() => !row.disabled && highlightRow(row)}
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => !row.disabled && row.onActivate()}
                    className={cn(
                      'flex min-h-8 cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm select-none [&_svg]:size-4 [&_svg]:shrink-0',
                      row === active && 'bg-muted text-foreground',
                      row.disabled && 'cursor-default opacity-50',
                    )}
                  >
                    <span aria-hidden="true" className="text-muted-foreground flex">
                      {row.icon}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{row.title}</span>
                      {row.description && (
                        <span className="text-muted-foreground truncate text-xs">{row.description}</span>
                      )}
                    </span>
                    {row.trailing}
                  </div>
                ))}
              </div>
            </>
          )
        )}
      </div>
      <div className="bg-muted/50 text-muted-foreground flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-1">
            <Kbd>
              <ArrowUp />
            </Kbd>
            <Kbd>
              <ArrowDown />
            </Kbd>
            Navigate
          </span>
          <span className="flex items-center gap-1">
            <Kbd>Enter</Kbd>
            {enterLabel}
          </span>
          {onTab && (
            <span className="flex items-center gap-1">
              <Kbd>Tab</Kbd>
              Complete
            </span>
          )}
          {onBack && (
            <span className="flex items-center gap-1">
              <Kbd>Backspace</Kbd>
              Back
            </span>
          )}
          <span className="flex items-center gap-1">
            <Kbd>Esc</Kbd>
            Close
          </span>
        </div>
        {footerTrailing}
      </div>
    </div>
  )
}
