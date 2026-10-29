import { useMemo, useState } from 'react'

import {
  dedupeGroups,
  ModelPickerCombobox,
  type ModelPickerGroup,
  uniqueAliasTargets,
  usagePickerItem,
} from '@/features/models/model-picker'
import { useAliasPricingStore } from '@/features/models/use-pricing-store'
import { ConfirmRemove, PaneHeader } from '@/features/settings/pane-parts'
import { LoadingRegion } from '@/components/skeletons'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { useCurrencyFormatter } from '@/shared/lib/use-currency-formatter'

/** Settings › Model aliases: full CRUD against the store's alias config
 * table. An alias maps an unrecognized model name to a priced model so its
 * cost shows up (the same table the Models section's quick-add writes to).
 * Both sides are picked with the shared model combobox — the unrecognized
 * side lists the not-yet-mapped models, the priced side the already-priced
 * models. */
export function AliasesPane() {
  const { aliases, overrides, knownModels, addAlias, removeAlias, commandErrors, unpriced, priced } =
    useAliasPricingStore()
  const { currency } = useCurrencyFormatter()
  // The lifetime models split by price status are shared with the Models
  // quick-add picker.
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)

  const aliasRows = aliases.data
  const overrideRows = overrides.data

  const aliasedModels = useMemo(() => new Set((aliasRows ?? []).map(alias => alias.model)), [aliasRows])

  // The two disjoint sets each combobox shows, shaped from the query-derived
  // split: the unpriced usage models (the Models view's "add alias" rows) for
  // "unrecognized", and the priced ones (cost > 0) for the target.
  const unpricedItems = useMemo(() => unpriced.map(model => usagePickerItem(model, currency)), [unpriced, currency])
  const pricedItems = useMemo(() => priced.map(model => usagePickerItem(model, currency)), [priced, currency])

  // Unrecognized model candidates: models already aliased plus the usage
  // models that are not mapped yet (the unpriced ones).
  const fromGroups = useMemo<ModelPickerGroup[]>(
    () => [
      {
        label: 'Already mapped',
        items: (aliasRows ?? []).map(alias => ({
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
    ],
    [aliasRows, unpricedItems, aliasedModels],
  )

  // Priced model candidates: targets already aliased (deduped) plus the
  // already-priced models — explicit overrides and priced usage models.
  // Values are deduped so each model appears once (first group wins).
  const toGroups = useMemo<ModelPickerGroup[]>(
    () =>
      dedupeGroups([
        {
          label: 'Already mapped',
          items: uniqueAliasTargets(aliasRows ?? []).map(alias => ({
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
            ...(overrideRows ?? []).map(override => ({
              id: `override:${override.model}`,
              value: override.model,
              label: override.model,
              dot: override.model,
              sub: `in ${override.inputPricePerMillion} · out ${override.outputPricePerMillion}`,
            })),
            ...pricedItems,
          ],
        },
      ]),
    [aliasRows, overrideRows, pricedItems],
  )

  const add = async (): Promise<void> => {
    const model = from.trim()
    const aliasOf = to.trim()
    if (!model || !aliasOf) return
    setBusy(true)
    try {
      const result = await addAlias({ model, aliasOf })
      if (result.ok) {
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
        {aliasRows === null ? (
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
        ) : aliasRows.length === 0 ? (
          <p className="text-muted-foreground text-[11.5px]">
            No aliases configured. Unknown models are priced at $0 until aliased.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {aliasRows.map(alias => (
              <li key={alias.model} className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{alias.model}</code>
                <span className="text-muted-foreground">→</span>
                <code className="text-foreground min-w-0 flex-1 truncate font-mono text-[11.5px]">{alias.aliasOf}</code>
                <ConfirmRemove label="Remove" prompt="Remove?" onConfirm={() => void removeAlias(alias.model)} />
              </li>
            ))}
          </ul>
        )}
        <Separator className="my-3" />
        <div className="flex flex-col gap-2">
          <span className="text-muted-foreground text-[10.5px] font-medium">Unrecognized model</span>
          <ModelPickerCombobox
            groups={fromGroups}
            value={from}
            onPick={setFrom}
            placeholder="Select an unrecognized model…"
            emptyText="No unmapped models detected yet — type a name."
            ariaLabel="Unrecognized model"
          />
          <span className="text-muted-foreground text-[10.5px] font-medium">Priced model</span>
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
        {(aliases.error ??
          overrides.error ??
          knownModels.error ??
          commandErrors.addAlias ??
          commandErrors.removeAlias) && (
          <p className="text-destructive mt-2 text-[11px]">
            {aliases.error ??
              overrides.error ??
              knownModels.error ??
              commandErrors.addAlias ??
              commandErrors.removeAlias}
          </p>
        )}
      </Card>
      <p className="text-muted-foreground text-[11px]">
        Unknown models are priced at $0 until aliased. A local model can instead be credited with what it would have
        cost via model-savings.
      </p>
    </div>
  )
}
