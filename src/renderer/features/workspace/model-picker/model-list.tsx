import { Check, Loader2, TriangleAlert } from 'lucide-react'
import type { KeyboardEvent, Ref } from 'react'
import { useId } from 'react'

import { Button } from '@/renderer/components/ui/button'
import { Input } from '@/renderer/components/ui/input'
import { cn } from '@/renderer/shared/lib/utils'

import type { CatalogView } from './catalog.js'
import { rankModelRows } from './search.js'

export interface ModelRow {
  readonly id: string
  readonly label: string
  readonly description?: string | undefined
}

/** The agent default. Its id is blank, so picking it clears the choice. */
const DEFAULT_MODEL_ROW: ModelRow = { id: '', label: 'Default', description: 'Let the agent choose' }

/** Search field and the model rows for the previewed agent. Keyboard: arrows move, Enter picks, Escape closes. */
export function ModelList({
  inputRef,
  view,
  query,
  onQueryChange,
  checkedId,
  highlightedId,
  onHighlight,
  onPick,
  onRetry,
  notice,
  onClose,
  onLeaveSearch,
}: {
  readonly inputRef: Ref<HTMLInputElement>
  readonly view: CatalogView
  readonly query: string
  readonly onQueryChange: (query: string) => void
  readonly checkedId: string
  readonly highlightedId: string | null
  readonly onHighlight: (modelId: string) => void
  readonly onPick: (modelId: string) => void
  readonly onRetry: () => void
  /** The previewed agent's sign-in: its account when ready, otherwise what to do. */
  readonly notice?: { readonly tone: 'info' | 'attention'; readonly text: string | null } | null
  readonly onClose: () => void
  /** ArrowLeft on an empty search moves focus to the rail. */
  readonly onLeaveSearch: () => void
}) {
  const listId = useId()
  const models = view.kind === 'listed' || view.kind === 'session' ? view.models : []
  // One row per ID: a repeated ID would show two checked rows and collide as a React key.
  const seen = new Set<string>()
  const unique = [DEFAULT_MODEL_ROW, ...models].filter(row => !seen.has(row.id) && Boolean(seen.add(row.id)))
  const rows = rankModelRows<ModelRow>(unique, query)
  const highlightIndex = Math.max(
    0,
    rows.findIndex(row => row.id === highlightedId),
  )
  const activeRow = rows[highlightIndex]
  const optionId = (index: number) => `${listId}-option-${index}`
  const blankQuery = query.trim() === ''

  function move(delta: number) {
    if (rows.length === 0) return
    const next = rows[(highlightIndex + delta + rows.length) % rows.length]
    if (next) onHighlight(next.id)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      move(event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Enter' && activeRow) {
      event.preventDefault()
      onPick(activeRow.id)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    } else if (event.key === 'ArrowLeft' && blankQuery) {
      event.preventDefault()
      onLeaveSearch()
    }
    event.stopPropagation()
  }

  return (
    <div className="bg-muted/40 flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="px-2 pt-2">
        <div className="border-border/70 focus-within:border-ring border-b pb-2.5 transition-colors">
          <Input
            ref={inputRef}
            role="combobox"
            aria-label="Search models"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={activeRow ? optionId(highlightIndex) : undefined}
            placeholder="Search models…"
            value={query}
            onChange={event => onQueryChange(event.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
            className="h-7 rounded-none border-0 bg-transparent px-0 text-[13px] shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {notice?.text && view.kind !== 'failed' && (
          <p
            role={notice.tone === 'attention' ? 'alert' : 'status'}
            className={cn(
              'mx-0.5 mb-1.5 flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[11px] leading-4',
              notice.tone === 'attention'
                ? 'bg-amber-500/10 text-amber-800 dark:text-amber-300'
                : 'text-muted-foreground',
            )}
          >
            {notice.tone === 'attention' && <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />}
            <span className="min-w-0 break-words">{notice.text}</span>
          </p>
        )}
        {view.kind === 'loading' ? (
          <p role="status" className="text-muted-foreground flex items-center justify-center gap-1.5 py-6 text-[12px]">
            <Loader2 className="size-3.5 animate-spin" />
            Loading models…
          </p>
        ) : (
          <>
            {view.kind === 'failed' && (
              <div role="alert" className="flex flex-col items-start gap-2 p-2 text-[12px]">
                <p className="text-muted-foreground">Could not read this agent&apos;s models.</p>
                <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                  Retry
                </Button>
              </div>
            )}
            <div id={listId} role="listbox" aria-label="Models">
              {rows.map((row, index) => {
                const checked = row.id === checkedId
                return (
                  <button
                    key={row.id}
                    id={optionId(index)}
                    type="button"
                    role="option"
                    aria-selected={checked}
                    onMouseEnter={() => onHighlight(row.id)}
                    onClick={() => onPick(row.id)}
                    className={cn(
                      'hover:bg-accent focus-visible:bg-accent relative flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors outline-none',
                      index === highlightIndex && 'bg-accent',
                      checked && 'bg-accent/60',
                    )}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span
                        className={cn(
                          'truncate text-[12px] font-medium',
                          row.id === '' && 'text-muted-foreground font-normal',
                        )}
                      >
                        {row.label}
                      </span>
                      {row.description && (
                        <span className="text-muted-foreground truncate text-[9.5px]">{row.description}</span>
                      )}
                    </span>
                    {checked && <Check className="text-primary size-4 shrink-0" aria-hidden />}
                  </button>
                )
              })}
            </div>
            {rows.length === 0 && (
              <p className="text-muted-foreground py-6 text-center text-[12px]">No matching models</p>
            )}
            {view.kind === 'listed' && models.length === 0 && blankQuery && (
              <p className="text-muted-foreground px-2 py-3 text-[12px]">No models available</p>
            )}
            {view.kind === 'session' && models.length === 0 && (
              <p className="text-muted-foreground px-2 py-3 text-[12px]">
                This agent did not list its models. It uses its own default.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
