import { useEffect, useMemo, useState } from 'react'

import { Button } from '@/shared/components/ui/button'
import { Card } from '@/shared/components/ui/card'
import { Separator } from '@/shared/components/ui/separator'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { LoadingRegion } from '@/shared/components/skeletons'
import { dedupeGroups, ModelPickerCombobox, uniqueAliasTargets, usagePickerItem, type ModelPickerGroup } from '@/features/models/model-picker'
import { usePricingStore } from '@/features/models/pricing-store'
import { ConfirmRemove, PaneHeader } from '@/features/settings/pane-parts'

/** Settings › Model aliases: full CRUD against the store's alias config
 * table. An alias maps an unrecognized model name to a priced model so its
 * cost shows up (the same table the Models section's quick-add writes to).
 * Both sides are picked with the shared model combobox — the unrecognized
 * side lists the not-yet-mapped models, the priced side the already-priced
 * models. */
export function AliasesPane() {
  const aliases = usePricingStore(s => s.aliases)
  const overrides = usePricingStore(s => s.overrides)
  const storeError = usePricingStore(s => s.error)
  const loadAliases = usePricingStore(s => s.loadAliases)
  const loadOverrides = usePricingStore(s => s.loadOverrides)
  const loadKnownModels = usePricingStore(s => s.loadKnownModels)
  const addAlias = usePricingStore(s => s.addAlias)
  const removeAlias = usePricingStore(s => s.removeAlias)
  // The usage models split by price status — fetched (lifetime) and split in
  // the pricing store, so the pickers always see the same "Recognized
  // models" list as the Models quick-add popup. Stable references, so the
  // item memos below only re-run when the store actually reloads.
  const unpriced = usePricingStore(s => s.unpriced)
  const priced = usePricingStore(s => s.priced)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void loadAliases()
    void loadOverrides()
    void loadKnownModels()
  }, [loadAliases, loadOverrides, loadKnownModels])

  const aliasedModels = useMemo(() => new Set((aliases ?? []).map(alias => alias.model)), [aliases])

  // The two disjoint sets each combobox shows, shaped from the store-derived
  // split: the unpriced usage models (the Models view's "add alias" rows) for
  // "unrecognized", and the priced ones (cost > 0) for the target.
  const unpricedItems = useMemo(() => unpriced.map(usagePickerItem), [unpriced])
  const pricedItems = useMemo(() => priced.map(usagePickerItem), [priced])

  // Unrecognized model candidates: models already aliased plus the usage
  // models that are not mapped yet (the unpriced ones).
  const fromGroups = useMemo<ModelPickerGroup[]>(() => [
    {
      label: 'Already mapped',
      items: (aliases ?? []).map(alias => ({
        id: `mapped:${alias.model}`,
        value: alias.model,
        label: alias.model,
        dot: alias.model,
        sub: `→ ${alias.aliasOf}`,
      })),
    },
    {
      label: 'Not mapped',
      items: unpricedItems.filter(item => !aliasedModels.has(item.value)),
    },
  ], [aliases, unpricedItems, aliasedModels])

  // Priced model candidates: targets already aliased (deduped) plus the
  // already-priced models — explicit overrides and priced usage models.
  // Values are deduped so each model appears once (first group wins).
  const toGroups = useMemo<ModelPickerGroup[]>(() => dedupeGroups([
    {
      label: 'Already mapped',
      items: uniqueAliasTargets(aliases ?? []).map(alias => ({
        id: `mapped:${alias.aliasOf}`,
        value: alias.aliasOf,
        label: alias.aliasOf,
        dot: alias.aliasOf,
        sub: `from ${alias.model}`,
      })),
    },
    {
      label: 'Priced models',
      items: [
        ...(overrides ?? []).map(override => ({
          id: `override:${override.model}`,
          value: override.model,
          label: override.model,
          dot: override.model,
          sub: `in ${override.inputPricePerMillion} · out ${override.outputPricePerMillion}`,
        })),
        ...pricedItems,
      ],
    },
  ]), [aliases, overrides, pricedItems])

  const add = async (): Promise<void> => {
    const model = from.trim()
    const aliasOf = to.trim()
    if (!model || !aliasOf) return
    setBusy(true)
    try {
      const ok = await addAlias(model, aliasOf)
      if (ok) {
        setFrom('')
        setTo('')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex max-w-md flex-col gap-3">
      <PaneHeader
        title="Model aliases"
        subtitle="Map an unrecognized model name to a priced model so its cost shows up."
      />
      <Card className="px-4 py-3">
        {aliases === null ? (
          <LoadingRegion label="Loading aliases…" className="flex flex-col gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2">
                <Skeleton className="h-3.5 w-40" />
                <Skeleton className="h-3 w-4" />
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="ml-auto h-6 w-16 rounded-md" />
              </div>
            ))}
          </LoadingRegion>
        ) : aliases.length === 0 ? (
          <p className="text-[11.5px] text-muted-foreground">No aliases configured. Unknown models are priced at $0 until aliased.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {aliases.map(alias => (
              <li key={alias.model} className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{alias.model}</code>
                <span className="text-muted-foreground">→</span>
                <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground">{alias.aliasOf}</code>
                <ConfirmRemove
                  label="Remove"
                  prompt="Remove?"
                  onConfirm={() => void removeAlias(alias.model)}
                />
              </li>
            ))}
          </ul>
        )}
        <Separator className="my-3" />
        <div className="flex flex-col gap-2">
          <span className="text-[10.5px] font-medium text-muted-foreground">Unrecognized model</span>
          <ModelPickerCombobox
            groups={fromGroups}
            value={from}
            onPick={setFrom}
            placeholder="Select an unrecognized model…"
            emptyText="No unmapped models detected yet — type a name."
            ariaLabel="Unrecognized model"
          />
          <span className="text-[10.5px] font-medium text-muted-foreground">Priced model</span>
          <ModelPickerCombobox
            groups={toGroups}
            value={to}
            onPick={setTo}
            placeholder="Select a priced model…"
            emptyText="No priced models configured yet — type a name."
            ariaLabel="Priced model"
          />
          <Button
            type="button"
            size="sm"
            className="self-end"
            disabled={busy || !from.trim() || !to.trim()}
            onClick={() => void add()}
          >
            Add
          </Button>
        </div>
        {storeError && <p className="mt-2 text-[11px] text-destructive">{storeError}</p>}
      </Card>
      <p className="text-[11px] text-muted-foreground">Unknown models are priced at $0 until aliased. A local model can instead be credited with what it would have cost via model-savings.</p>
    </div>
  )
}
