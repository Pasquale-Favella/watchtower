import { useEffect, useMemo, useState } from 'react'

import { SegTabs } from '@/shared/components/SegTabs'
import { formatUsd, providerTitle } from '@/shared/lib/models'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import type { ModelReportRow } from '../../../../shared/schemas/models.js'
import { ModelPickerCombobox, type ModelPickerGroup } from './model-picker'
import { usePricingStore } from './pricing-store'

export type QuickAddTarget = {
  provider: string
  model: string
  modelDisplayName: string
  /** Prefill for managing existing pricing from a Models row: alias retarget
   * opens in alias mode with the current target, override edit opens in price
   * mode with the current rates. Absent = fresh quick-add. */
  initialMode?: 'alias' | 'price'
  initialAliasTarget?: string
  initialInputPrice?: string
  initialOutputPrice?: string
}

export function QuickAddModal({
  target,
  models,
  onClose,
  onSaved,
}: {
  target: QuickAddTarget
  models: ModelReportRow[]
  onClose: () => void
  onSaved: () => void
}) {
  // Pricing is the point of this dialog (it customizes rates, it doesn't
  // rename models) — open on the Price override tab unless the caller
  // prefills an Alias retarget; the model search only appears once the user
  // opts into the alias tab.
  const [mode, setMode] = useState<'alias' | 'price'>(target.initialMode ?? 'price')
  const [aliasTarget, setAliasTarget] = useState(target.initialAliasTarget ?? '')
  const [inputPrice, setInputPrice] = useState(target.initialInputPrice ?? '')
  const [outputPrice, setOutputPrice] = useState(target.initialOutputPrice ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const aliases = usePricingStore(s => s.aliases)
  const loadAliases = usePricingStore(s => s.loadAliases)
  const loadOverrides = usePricingStore(s => s.loadOverrides)
  const addAlias = usePricingStore(s => s.addAlias)
  const setOverride = usePricingStore(s => s.setOverride)

  // Existing aliases ("already mapped") and overrides come from the shared
  // pricing store; always refetch on open so the picker never proposes
  // pre-open state (e.g. a mapping deleted in Settings just before).
  useEffect(() => {
    void loadAliases()
    void loadOverrides()
  }, [loadAliases, loadOverrides])

  // Recognized models the unrecognized one can be mapped to — the quick-add
  // row itself excluded, so a model is never aliased to itself. Memoized so
  // the picker groups below keep stable references for Base UI's selection
  // comparison.
  const candidates = useMemo(
    () => models.filter(m => m.model !== target.model && m.modelDisplayName !== target.modelDisplayName),
    [models, target.model, target.modelDisplayName],
  )
  const mappedCandidates = useMemo(
    () => (aliases ?? []).filter(alias => alias.model !== target.model),
    [aliases, target.model],
  )

  const pickerGroups = useMemo<ModelPickerGroup[]>(
    () => [
      {
        label: 'Already mapped',
        items: mappedCandidates.map(alias => ({
          id: `mapped:${alias.model}`,
          value: alias.aliasOf,
          label: alias.aliasOf,
          dot: alias.aliasOf,
          sub: `from ${alias.model}`,
        })),
      },
      {
        label: 'Recognized models',
        items: candidates.map(model => ({
          id: `recognized:${model.provider}:${model.model}`,
          value: model.model,
          label: model.modelDisplayName,
          dot: model.modelDisplayName,
          sub: `${providerTitle(model.provider)} · ${model.calls.toLocaleString('en-US')} calls · ${formatUsd(model.costUSD)}`,
        })),
      },
    ],
    [mappedCandidates, candidates],
  )

  const pick = (model: string): void => {
    setAliasTarget(model)
    setError(null)
  }

  const submit = async (): Promise<void> => {
    setError(null)
    if (mode === 'alias') {
      const targetModel = aliasTarget.trim()
      if (!targetModel) {
        setError('Enter the priced model to map this one to.')
        return
      }
      setSaving(true)
      try {
        // Writes go through the pricing store (upsert) so its alias,
        // override, and usage-derived picker lists refresh together — a
        // dialog opened right after never proposes pre-save state.
        const ok = await addAlias(target.model, targetModel)
        if (!ok) {
          setError(usePricingStore.getState().error ?? 'Save failed.')
          return
        }
        onSaved()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setSaving(false)
      }
      return
    }
    const input = Number(inputPrice)
    const output = Number(outputPrice)
    if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) {
      setError('Prices must be non-negative numbers (USD per 1M tokens).')
      return
    }
    setSaving(true)
    try {
      const ok = await setOverride(target.model, input, output)
      if (!ok) {
        setError(usePricingStore.getState().error ?? 'Save failed.')
        return
      }
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-[13px] tracking-tight">Price {target.modelDisplayName}</DialogTitle>
          <DialogDescription className="text-muted-foreground truncate text-[10px]">
            {providerTitle(target.provider)} · {target.model}
          </DialogDescription>
        </DialogHeader>

        <SegTabs
          options={[
            { value: 'price', label: 'Manual price' },
            { value: 'alias', label: 'Map to model' },
          ]}
          value={mode}
          onChange={value => {
            setMode(value as 'alias' | 'price')
            setError(null)
          }}
        />

        {mode === 'alias' ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-muted-foreground text-[10.5px] font-medium">Price this model as</span>

            <ModelPickerCombobox
              groups={pickerGroups}
              value={aliasTarget}
              onPick={pick}
              placeholder="Map to model…"
              emptyText="No models to map to yet."
            />

            {aliasTarget ? (
              <p className="text-muted-foreground text-[10.5px]">
                Mapping <code className="text-foreground font-mono">{target.model}</code> →{' '}
                <code className="text-primary font-mono">{aliasTarget}</code>
              </p>
            ) : (
              <p className="text-muted-foreground text-[10px]">
                Adds a <code className="font-mono">{target.model}</code> → target alias. Existing calls are repriced
                from their token usage, no rescan needed.
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="models-price-input" className="text-muted-foreground text-[10.5px] font-medium">
              Input price · USD per 1M tokens
            </label>
            <Input
              id="models-price-input"
              value={inputPrice}
              onChange={event => setInputPrice(event.target.value)}
              inputMode="decimal"
              placeholder="0"
              className="h-7 text-[12px]"
            />
            <label htmlFor="models-price-output" className="text-muted-foreground text-[10.5px] font-medium">
              Output price · USD per 1M tokens
            </label>
            <Input
              id="models-price-output"
              value={outputPrice}
              onChange={event => setOutputPrice(event.target.value)}
              inputMode="decimal"
              placeholder="0"
              className="h-7 text-[12px]"
            />
            <p className="text-muted-foreground text-[10px]">
              Writes a manual price override; the affected rows update without a rescan.
            </p>
          </div>
        )}

        {error && <p className="text-destructive text-[11px]">{error}</p>}

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void submit()}
            disabled={saving || (mode === 'alias' && !aliasTarget.trim())}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
