import { useMemo, useState } from 'react'

import { ChevronDownIcon } from 'lucide-react'
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
  ComboboxSeparator,
  ComboboxTrigger,
  ComboboxValue,
} from '@/shared/components/ui/combobox'
import { formatUsd } from '@/shared/lib/currency'
import { providerTitle } from '@/shared/lib/models'
import type { ModelAlias, ModelReportRow } from '../../../../shared/schemas/models.js'
import { ModelDot } from './table-parts'

/** Dedupes aliases by their priced target so each target appears once. */
export function uniqueAliasTargets(aliases: ModelAlias[]): ModelAlias[] {
  return [...new Map(aliases.map(alias => [alias.aliasOf, alias] as const)).values()]
}

/** One row of the model picker: a value, its display label, an optional
 * series-color dot, and an optional muted detail line. */
export type ModelPickerItem = {
  id: string
  value: string
  label: string
  dot?: string
  sub?: string
}

export type ModelPickerGroup = {
  label: string
  items: ModelPickerItem[]
}

/** Filters a list of picker groups so each item value appears exactly once —
 * the first group that mentions a value wins (used by the Settings panes to
 * keep a model from showing under multiple groups). */
export function dedupeGroups(groups: ModelPickerGroup[]): ModelPickerGroup[] {
  const seen = new Set<string>()
  return groups.map(group => {
    const items = group.items.filter(item => !seen.has(item.value))
    items.forEach(item => seen.add(item.value))
    return { label: group.label, items }
  })
}

/** One recognized-model row (from the lifetime usage payload) shaped for
 * the model picker's item contract — the "Recognized models" candidates the
 * Settings › Aliases/Pricing panes offer. */
export function usagePickerItem(model: ModelReportRow): ModelPickerItem {
  return {
    id: `known:${model.provider}:${model.model}`,
    value: model.model,
    label: model.modelDisplayName,
    dot: model.modelDisplayName,
    sub: `${providerTitle(model.provider)} · ${model.calls.toLocaleString('en-US')} calls · ${formatUsd(model.costUSD)}`,
  }
}

/** The popup-pattern model combobox — trigger button showing the current
 * pick, search inside the popup, grouped results — shared by the Models
 * quick-add and the Settings › Aliases/Pricing panes. Base UI filters each
 * group against the search (empty groups drop), and a custom name can be
 * picked via the "Use 'query'" fallback. */
export function ModelPickerCombobox({
  groups,
  value,
  onPick,
  placeholder = 'Select a model…',
  emptyText = 'No models to pick from yet.',
  ariaLabel,
  className,
}: {
  groups: ModelPickerGroup[]
  value: string
  onPick: (value: string) => void
  placeholder?: string
  emptyText?: string
  ariaLabel?: string
  className?: string
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const trimmedQuery = query.trim()

  // Empty groups are dropped so Base UI hides a group only when its items
  // are filtered out. Built from the caller's memoized groups to keep item
  // references stable for Base UI's selection comparison.
  const groupedOptions = useMemo(() => groups.filter(group => group.items.length > 0), [groups])
  const selected = useMemo(
    () => groupedOptions.flatMap(group => group.items).find(item => item.value === value) ?? null,
    [groupedOptions, value],
  )

  return (
    <Combobox
      items={groupedOptions}
      itemToStringValue={item => item.label}
      value={selected ?? null}
      onValueChange={next => {
        if (next) onPick(next.value)
      }}
      autoHighlight
      open={open}
      onOpenChange={next => {
        setOpen(next)
        if (next) setQuery('')
      }}
    >
      <ComboboxTrigger
        render={
          <Button
            type="button"
            variant="outline"
            aria-label={ariaLabel}
            className={cn('w-full justify-between gap-2 font-normal', !value && 'text-muted-foreground', className)}
          >
            <span className="min-w-0 flex-1 truncate text-left">
              {selected ? <ComboboxValue /> : value ? value : placeholder}
            </span>
            <ChevronDownIcon className="text-muted-foreground pointer-events-none size-4 shrink-0" />
          </Button>
        }
      />
      <ComboboxContent>
        <ComboboxInput
          showTrigger={false}
          placeholder="Search models… or type a custom name"
          onChange={event => setQuery(event.target.value)}
          autoFocus
        />
        <ComboboxEmpty>
          {trimmedQuery ? (
            <button
              type="button"
              onClick={() => {
                onPick(trimmedQuery)
                setOpen(false)
              }}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onPick(trimmedQuery)
                  setOpen(false)
                }
              }}
              className="text-primary cursor-pointer text-[12.5px] font-medium hover:underline"
            >
              Use “{trimmedQuery}”
            </button>
          ) : (
            emptyText
          )}
        </ComboboxEmpty>
        <ComboboxList>
          {(group, index) => (
            <ComboboxGroup key={group.label}>
              {index > 0 && <ComboboxSeparator />}
              <ComboboxLabel>{group.label}</ComboboxLabel>
              {group.items.map((item: ModelPickerItem) => (
                <ComboboxItem key={item.id} value={item}>
                  {item.dot && <ModelDot model={item.dot} />}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-foreground truncate text-[12px] font-medium">{item.label}</span>
                    {item.sub && <span className="text-muted-foreground truncate text-[9.5px]">{item.sub}</span>}
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
