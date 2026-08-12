import { useMemo, useState } from 'react'

import { Cpu, Loader2 } from 'lucide-react'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/components/ui/button'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
} from '@/shared/components/ui/combobox'
import type { CoachModelInfo } from '../../../../shared/schemas/agents.js'

/** One selectable row: the agent-declared model, plus a synthetic "default"
 *  row (value null) that resets selection to the agent's own choice. */
type ModelOption = {
  id: string
  value: string | null
  label: string
  description?: string | null
}

/** The chat's model picker — an elements.ai-sdk.dev ModelSelector-inspired
 *  command palette adapted to this app: a compact trigger that matches the
 *  composer footer's small selects opens a searchable popup (name + optional
 *  description rows, check on the current pick, empty state). Built on the
 *  app's Base UI Combobox, which is this project's equivalent of the
 *  reference's cmdk/Popover pair. Selection stays PROGRESSIVE (map 47 ticket
 *  50): only the agent's own handshake-declared models are offered, and the
 *  first row returns to the agent default (modelId null). The picker is
 *  LAZY: the trigger always renders, but the models load on first open —
 *  `onOpen` fires the store's probe (which also warms a session for the
 *  first run), and `loading` swaps the list for a loading row. */
export function ModelSelector({
  models,
  value,
  onSelect,
  loading = false,
  onOpen,
}: {
  models: CoachModelInfo[]
  value: string | null
  onSelect: (modelId: string | null) => void
  /** The agent's set is being probed right now (first open). */
  loading?: boolean
  /** Fired when the popup opens — the lazy probe trigger. */
  onOpen?: () => void
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)

  // Memoized so the option references stay stable for Base UI's selection
  // comparison across re-renders (same pattern as ModelPickerCombobox).
  const options = useMemo<ModelOption[]>(
    () => [
      { id: 'default', value: null, label: 'Model: default', description: 'Let the agent choose' },
      ...models.map(model => ({
        id: model.modelId,
        value: model.modelId,
        label: model.name,
        description: model.description,
      })),
    ],
    [models],
  )
  // While the first probe is in flight there is nothing to list yet — an
  // empty item set surfaces the ComboboxEmpty loading row. The SELECTED
  // value keeps mapping against the full options so the trigger label stays
  // stable ("Model: default") throughout.
  const groups = useMemo(
    () => (loading && models.length === 0 ? [] : [{ label: 'Models', items: options }]),
    [loading, models.length, options],
  )
  const selected = useMemo(
    () => options.find(option => option.value === value) ?? options[0],
    [options, value],
  )

  return (
    <Combobox
      items={groups}
      itemToStringValue={item => item.label}
      value={selected}
      onValueChange={next => { if (next) onSelect(next.value) }}
      autoHighlight
      open={open}
      onOpenChange={next => { setOpen(next); if (next) { setQuery(''); onOpen?.() } }}
    >
      <ComboboxTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Model"
            title="Agent-declared model"
            className="h-7 gap-1.5 border-border pr-1.5 text-[11.5px] font-normal"
          >
            {loading && models.length === 0 ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <Cpu className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate text-left">
              {loading && models.length === 0 ? 'Loading models…' : <ComboboxValue />}
            </span>
          </Button>
        }
      />
      <ComboboxContent className="w-[280px]" align="start" side="top" sideOffset={8}>
        <ComboboxInput
          showTrigger={false}
          aria-label="Search models"
          placeholder="Search models…"
          onChange={event => setQuery(event.target.value)}
          autoFocus
        />
        <ComboboxEmpty>
          {loading ? (
            <span className="flex items-center justify-center gap-1.5">
              <Loader2 className="size-3.5 animate-spin" />
              Loading models…
            </span>
          ) : (
            (query.trim() ? 'No matching models' : 'No models available')
          )}
        </ComboboxEmpty>
        <ComboboxList>
          {group => (
            <ComboboxGroup key={group.label}>
              <ComboboxLabel>{group.label}</ComboboxLabel>
              {group.items.map((item: ModelOption) => (
                <ComboboxItem key={item.id} value={item}>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span
                      className={cn(
                        'truncate text-[12px] font-medium',
                        item.value === null && 'font-normal text-muted-foreground',
                      )}
                    >
                      {item.label}
                    </span>
                    {item.description && (
                      <span className="truncate text-[9.5px] text-muted-foreground">{item.description}</span>
                    )}
                  </span>
                </ComboboxItem>
              ))}
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
