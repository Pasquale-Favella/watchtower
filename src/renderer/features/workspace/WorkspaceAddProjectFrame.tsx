import { useHotkeys } from '@tanstack/react-hotkeys'
import { ArrowLeft } from 'lucide-react'
import { type ReactNode, useId, useRef, useState } from 'react'

import { displayShortcut, displayShortcutText } from '@/renderer/app/shortcuts'
import { Button } from '@/renderer/components/ui/button'
import { Kbd } from '@/renderer/components/ui/kbd'
import { TextTooltip } from '@/renderer/components/ui/tooltip'
import { cn } from '@/renderer/shared/lib/utils'

import {
  PALETTE_BACK_HOTKEY,
  PALETTE_CLOSE_HOTKEY,
  PALETTE_COMPLETE_HOTKEY,
  PALETTE_FORCE_SUBMIT_HOTKEY,
  PALETTE_NEXT_HOTKEY,
  PALETTE_PREVIOUS_HOTKEY,
  PALETTE_SUBMIT_HOTKEY,
  paletteBackspaceGoesBack,
  paletteEnterIntent,
  paletteMoveTarget,
} from './project-browse-state.js'

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
    <Button type="button" variant="ghost" size="xs" disabled={disabled} onClick={onClick}>
      {children}
    </Button>
  )
}

function KeyHint({ keys, children }: { readonly keys: readonly string[]; readonly children: ReactNode }) {
  return (
    <span className="flex items-center gap-1">
      {keys.map(key => (
        <Kbd key={key}>{key}</Kbd>
      ))}
      {children}
    </span>
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
  /** Returns whether Tab completed something; when it did not, Tab keeps moving focus as usual. */
  readonly onTab?: (active: PaletteRow | null) => boolean
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
  const inputRef = useRef<HTMLInputElement>(null)
  const [highlight, setHighlight] = useState<{ readonly key: string; readonly id: string | null }>({
    key: resetKey,
    id: null,
  })
  const enabledRows = rows.filter(row => !row.disabled)
  const chosen = highlight.key === resetKey ? enabledRows.find(row => row.id === highlight.id) : undefined
  const active = chosen ?? (autoHighlight ? enabledRows[0] : undefined) ?? null
  const optionId = (row: PaletteRow) => `${listId}-${rows.indexOf(row)}`
  const highlightRow = (row: PaletteRow | null) => setHighlight({ key: resetKey, id: row?.id ?? null })
  const submitHotkey = chosen ? PALETTE_FORCE_SUBMIT_HOTKEY : PALETTE_SUBMIT_HOTKEY
  const submitShortcut = displayShortcutText(submitHotkey)
  const enterLabel = active ? 'Select' : (submit?.label ?? 'Select')

  const move = (offset: 1 | -1) => {
    const id = paletteMoveTarget(
      enabledRows.map(row => row.id),
      active?.id ?? null,
      offset,
    )
    const next = enabledRows.find(row => row.id === id) ?? null
    highlightRow(next)
    if (next) document.getElementById(optionId(next))?.scrollIntoView({ block: 'nearest' })
  }

  const enter = (forceSubmit: boolean) => {
    const intent = paletteEnterIntent({
      forceSubmit,
      hasActiveRow: active !== null,
      hasSubmit: submit !== undefined,
      submitDisabled: submit?.disabled ?? true,
    })
    if (intent === 'activate') active?.onActivate()
    else if (intent === 'submit') submit?.onSubmit()
  }

  // Scoped to the input. Each callback claims its key itself (the registrations leave preventDefault off)
  // so an Enter that confirms an IME composition, or a Backspace that deletes text, still reaches the input.
  const claim = (event: KeyboardEvent, run: () => void) => {
    if (event.isComposing) return
    event.preventDefault()
    run()
  }
  useHotkeys(
    [
      {
        hotkey: PALETTE_NEXT_HOTKEY,
        callback: event => claim(event, () => move(1)),
        options: { meta: { name: 'Next option', description: 'Highlight the next option' } },
      },
      {
        hotkey: PALETTE_PREVIOUS_HOTKEY,
        callback: event => claim(event, () => move(-1)),
        options: { meta: { name: 'Previous option', description: 'Highlight the previous option' } },
      },
      {
        hotkey: PALETTE_SUBMIT_HOTKEY,
        callback: event => claim(event, () => enter(false)),
        options: {
          meta: { name: 'Submit', description: 'Submit the typed value, or activate the highlighted option' },
        },
      },
      {
        hotkey: PALETTE_FORCE_SUBMIT_HOTKEY,
        callback: event => claim(event, () => enter(true)),
        options: {
          meta: { name: 'Submit typed value', description: 'Submit the typed value even with an option highlighted' },
        },
      },
      {
        hotkey: PALETTE_COMPLETE_HOTKEY,
        callback: event => {
          if (event.isComposing) return
          if (onTab?.(chosen ?? null)) event.preventDefault()
        },
        options: {
          enabled: onTab !== undefined,
          meta: { name: 'Complete', description: 'Complete the path or open the highlighted folder' },
        },
      },
      {
        hotkey: PALETTE_BACK_HOTKEY,
        callback: event => {
          if (event.isComposing || !paletteBackspaceGoesBack({ value, repeat: event.repeat })) return
          event.preventDefault()
          onBack?.()
        },
        options: { enabled: onBack !== undefined, meta: { name: 'Back', description: 'Go back from an empty input' } },
      },
    ],
    { target: inputRef, ignoreInputs: false, preventDefault: false, stopPropagation: false },
  )

  return (
    <div className="flex flex-col p-1">
      <div className="flex h-9 items-center gap-2 border-b px-3">
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
          <span aria-hidden="true" className="flex shrink-0 opacity-50 [&_svg]:size-4">
            {icon}
          </span>
        )}
        <input
          ref={inputRef}
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
          className="placeholder:text-muted-foreground flex h-9 min-w-0 flex-1 bg-transparent py-3 text-sm outline-hidden disabled:cursor-not-allowed disabled:opacity-50"
        />
        {submit && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            tabIndex={-1}
            className="shrink-0"
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
      <div className="no-scrollbar max-h-72 scroll-py-1 overflow-x-hidden overflow-y-auto outline-none">
        {error && (
          <p role="alert" className="text-destructive px-3 py-2 text-sm">
            {error}
          </p>
        )}
        {hint && <p className="text-muted-foreground px-3 py-1.5 text-xs">{hint}</p>}
        {emptyMessage ? (
          <p role="status" className="text-muted-foreground py-6 text-center text-sm">
            {emptyMessage}
          </p>
        ) : (
          rows.length > 0 && (
            <div className="text-foreground overflow-hidden p-1">
              {groupLabel && <div className="text-muted-foreground px-2 py-1.5 text-xs font-medium">{groupLabel}</div>}
              <div role="listbox" id={listId} aria-label={groupLabel ?? inputLabel}>
                {rows.map(row => (
                  <TextTooltip
                    key={row.id}
                    label={row.description}
                    trigger={
                      <div
                        id={optionId(row)}
                        role="option"
                        aria-selected={row === active}
                        aria-disabled={row.disabled || undefined}
                        onMouseMove={() => !row.disabled && highlightRow(row)}
                        onMouseDown={event => event.preventDefault()}
                        onClick={() => !row.disabled && row.onActivate()}
                        className={cn(
                          'relative flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-sm select-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4',
                          row === active && 'bg-muted text-foreground [&_svg]:text-foreground',
                          row.disabled && 'opacity-50',
                        )}
                      >
                        <span aria-hidden="true" className="flex">
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
                    }
                  />
                ))}
              </div>
            </div>
          )
        )}
      </div>
      <div className="bg-muted/50 text-muted-foreground -mx-1 mt-1 -mb-1 flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          <KeyHint keys={[displayShortcut(PALETTE_PREVIOUS_HOTKEY), displayShortcut(PALETTE_NEXT_HOTKEY)]}>
            Navigate
          </KeyHint>
          <KeyHint keys={[displayShortcutText(PALETTE_SUBMIT_HOTKEY)]}>{enterLabel}</KeyHint>
          {chosen && submit && (
            <KeyHint keys={[displayShortcutText(PALETTE_FORCE_SUBMIT_HOTKEY)]}>{submit.label}</KeyHint>
          )}
          {onTab && <KeyHint keys={[displayShortcutText(PALETTE_COMPLETE_HOTKEY)]}>Complete</KeyHint>}
          {onBack && <KeyHint keys={[displayShortcutText(PALETTE_BACK_HOTKEY)]}>Back</KeyHint>}
          <KeyHint keys={[displayShortcutText(PALETTE_CLOSE_HOTKEY)]}>Close</KeyHint>
        </div>
        {footerTrailing}
      </div>
    </div>
  )
}
