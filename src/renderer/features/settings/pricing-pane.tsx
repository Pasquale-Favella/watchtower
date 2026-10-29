import { useMemo, useState } from 'react'

import {
  dedupeGroups,
  ModelPickerCombobox,
  type ModelPickerGroup,
  uniqueAliasTargets,
  usagePickerItem,
} from '@/renderer/features/models/model-picker'
import { useOverridePricingStore } from '@/renderer/features/models/use-pricing-store'
import { validatePricing } from '@/renderer/features/settings/lib'
import { ConfirmRemove, PaneHeader } from '@/renderer/features/settings/pane-parts'
import { LoadingRegion } from '@/renderer/components/skeletons'
import { Button } from '@/renderer/components/ui/button'
import { Card } from '@/renderer/components/ui/card'
import { Input } from '@/renderer/components/ui/input'
import { Separator } from '@/renderer/components/ui/separator'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { useCurrencyFormatter } from '@/renderer/shared/lib/use-currency-formatter'

/** Settings › Pricing: full CRUD against the store's price-override config
 * table — set/update an override or add a new model, and remove one to revert
 * its stored calls to the pipeline-computed cost. Rates are USD per 1M tokens.
 * The model is picked with the shared model combobox — existing overrides,
 * aliased targets, and usage models not priced yet. */
export function PricingPane() {
  const {
    overrides: overrideQuery,
    aliases: aliasQuery,
    knownModels: knownModelsQuery,
    setOverride,
    removeOverride,
    commandErrors,
    unpriced,
  } = useOverridePricingStore()
  const { currency } = useCurrencyFormatter()
  // The usage models with no price yet — the same query-derived split the
  // aliases pane uses, so a not-yet-priced model can be priced directly.
  const overrides = overrideQuery.data
  const aliases = aliasQuery.data
  const [model, setModel] = useState('')
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Picker candidates: existing overrides with their rates, every aliased
  // target, and the query-derived usage models not priced yet — deduped so
  // each model appears once (first group wins).
  const modelGroups = useMemo<ModelPickerGroup[]>(
    () =>
      dedupeGroups([
        {
          label: 'Existing overrides',
          items: (overrides ?? []).map(override => ({
            id: `override:${override.model}`,
            value: override.model,
            label: override.model,
            dot: override.model,
            sub: `in ${override.inputPricePerMillion} · out ${override.outputPricePerMillion}`,
          })),
        },
        {
          label: 'Aliased targets',
          items: uniqueAliasTargets(aliases ?? []).map(alias => ({
            id: `aliased:${alias.aliasOf}`,
            value: alias.aliasOf,
            label: alias.aliasOf,
            dot: alias.aliasOf,
            sub: `target of ${alias.model}`,
          })),
        },
        {
          label: 'Not priced',
          items: unpriced.map(model => usagePickerItem(model, currency)),
        },
      ]),
    [overrides, aliases, unpriced, currency],
  )

  const add = async (): Promise<void> => {
    const pricing = validatePricing(model, input, output)
    if (!pricing.ok) {
      setError(pricing.error)
      return
    }
    setError(null)
    setBusy(true)
    try {
      const result = await setOverride({
        model: pricing.model,
        inputPricePerMillion: pricing.inputPricePerMillion,
        outputPricePerMillion: pricing.outputPricePerMillion,
      })
      if (result.ok) {
        setModel('')
        setInput('')
        setOutput('')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex max-w-md flex-col gap-3">
      <PaneHeader
        title="Pricing"
        subtitle="Override or add per-model rates so local or self-hosted models are priced. Rates are USD per 1,000,000 tokens."
      />
      <Card className="px-4 py-3">
        {overrides === null ? (
          <LoadingRegion label="Loading price overrides…" className="flex flex-col gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2">
                <Skeleton className="h-3.5 w-44" />
                <Skeleton className="ml-auto h-3 w-28" />
                <Skeleton className="h-6 w-16 rounded-md" />
              </div>
            ))}
          </LoadingRegion>
        ) : overrides.length === 0 ? (
          <p className="text-muted-foreground text-[11.5px]">
            No price overrides configured. Add one below to price an unrecognized or local model.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {overrides.map(override => (
              <li key={override.model} className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{override.model}</code>
                <span className="text-muted-foreground shrink-0 font-mono text-[10.5px]">
                  in {override.inputPricePerMillion} · out {override.outputPricePerMillion}
                </span>
                <ConfirmRemove label="Remove" prompt="Remove?" onConfirm={() => void removeOverride(override.model)} />
              </li>
            ))}
          </ul>
        )}
        <Separator className="my-3" />
        <div className="flex flex-col gap-2">
          <span className="text-muted-foreground text-[10.5px] font-medium">Model</span>
          <ModelPickerCombobox
            groups={modelGroups}
            value={model}
            onPick={setModel}
            placeholder="Select a model…"
            emptyText="No models configured yet — type a name."
            ariaLabel="Override model"
          />
          <div className="flex items-center gap-2">
            <Input
              aria-label="Input rate"
              value={input}
              onChange={event => setInput(event.target.value)}
              placeholder="input"
              inputMode="decimal"
              className="h-7 flex-1 font-mono text-[11.5px]"
            />
            <Input
              aria-label="Output rate"
              value={output}
              onChange={event => setOutput(event.target.value)}
              placeholder="output"
              inputMode="decimal"
              className="h-7 flex-1 font-mono text-[11.5px]"
            />
            <Button
              type="button"
              size="sm"
              className="shrink-0"
              disabled={busy || !model.trim() || !input.trim() || !output.trim()}
              onClick={() => void add()}
            >
              Add
            </Button>
          </div>
        </div>
        {(error ??
          overrideQuery.error ??
          aliasQuery.error ??
          knownModelsQuery.error ??
          commandErrors.setOverride ??
          commandErrors.removeOverride) && (
          <p className="text-destructive mt-2 text-[11px]">
            {error ??
              overrideQuery.error ??
              aliasQuery.error ??
              knownModelsQuery.error ??
              commandErrors.setOverride ??
              commandErrors.removeOverride}
          </p>
        )}
      </Card>
      <p className="text-muted-foreground text-[11px]">
        A configured model is overridden; an unknown one is added. Removing an override reverts its stored calls to the
        standard pricing — no rescan needed.
      </p>
    </div>
  )
}
