import { useEffect, useMemo, useState } from 'react'

import { Button } from '@/shared/components/ui/button'
import { Card } from '@/shared/components/ui/card'
import { Input } from '@/shared/components/ui/input'
import { Separator } from '@/shared/components/ui/separator'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { LoadingRegion } from '@/shared/components/skeletons'
import {
  dedupeGroups,
  ModelPickerCombobox,
  uniqueAliasTargets,
  usagePickerItem,
  type ModelPickerGroup,
} from '@/features/models/model-picker'
import { usePricingStore } from '@/features/models/pricing-store'
import { ConfirmRemove, PaneHeader } from '@/features/settings/pane-parts'
import { validatePricing } from '@/features/settings/lib'

/** Settings › Pricing: full CRUD against the store's price-override config
 * table — set/update an override or add a new model, and remove one to revert
 * its stored calls to the pipeline-computed cost. Rates are USD per 1M tokens.
 * The model is picked with the shared model combobox — existing overrides,
 * aliased targets, and the store-derived usage models not priced yet. */
export function PricingPane() {
  const overrides = usePricingStore(s => s.overrides)
  const aliases = usePricingStore(s => s.aliases)
  const storeError = usePricingStore(s => s.error)
  const loadOverrides = usePricingStore(s => s.loadOverrides)
  const loadAliases = usePricingStore(s => s.loadAliases)
  const loadKnownModels = usePricingStore(s => s.loadKnownModels)
  const setOverride = usePricingStore(s => s.setOverride)
  const removeOverride = usePricingStore(s => s.removeOverride)
  // The usage models with no price yet — the same store-derived split the
  // aliases pane uses, so a not-yet-priced model can be priced directly.
  const unpriced = usePricingStore(s => s.unpriced)
  const [model, setModel] = useState('')
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void loadOverrides()
    void loadAliases()
    void loadKnownModels()
  }, [loadOverrides, loadAliases, loadKnownModels])

  // Picker candidates: existing overrides with their rates, every aliased
  // target, and the store-derived usage models not priced yet — deduped so
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
          items: unpriced.map(usagePickerItem),
        },
      ]),
    [overrides, aliases, unpriced],
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
      const ok = await setOverride(pricing.model, pricing.inputPricePerMillion, pricing.outputPricePerMillion)
      if (ok) {
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
        {(error || storeError) && <p className="text-destructive mt-2 text-[11px]">{error ?? storeError}</p>}
      </Card>
      <p className="text-muted-foreground text-[11px]">
        A configured model is overridden; an unknown one is added. Removing an override reverts its stored calls to the
        standard pricing — no rescan needed.
      </p>
    </div>
  )
}
