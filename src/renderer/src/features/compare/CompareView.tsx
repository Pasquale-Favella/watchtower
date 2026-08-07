import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { cn } from '@/shared/lib/utils'
import { SegTabs } from '@/shared/components/SegTabs'
import { Panel } from '@/shared/components/Panel'
import { motionClass } from '@/shared/lib/motion'
import { providerOptionsFromDetected } from '@/shared/lib/shell'
import { seriesColorForModel } from '@/shared/lib/modelSeries'
import { categoryLabel } from '@/shared/lib/models'
import { compareValue } from '@/features/compare/lib'
import { ErrorPanel } from '@/shared/components/ErrorPanel'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/components/ui/select'
import { useCompareStore } from '@/features/compare/store'
import { selectScope, useShellStore } from '@/app/stores/shell-store'
import { useScanStore } from '@/app/stores/scan-store'
import type {
  CategoryComparison,
  CompareModelStat,
  ComparePair,
  CompareWinner,
  ComparisonRow,
  WorkingStyleRow,
} from '../../../../shared/schemas/compare.js'

const ROW_GRID = 'grid grid-cols-[minmax(0,1fr)_150px_150px] gap-x-3'
const VALUE_CELL = 'text-right font-mono tabular-nums'

function modelOptionLabel(model: CompareModelStat): string {
  return `${model.displayName} · ${model.calls.toLocaleString('en-US')} calls`
}

function winnerClass(winner: CompareWinner, side: 'a' | 'b'): string {
  return winner === side ? 'text-success' : 'text-muted-foreground'
}

/** Shared Metric | A | B row grid used by the metrics and working-style cards
 * (ticket 27): the model names in the header, then one row per metric with
 * each side's formatted value, green when it wins (metrics card only). */
function CompareRows({
  rows,
  modelA,
  modelB,
  showWinners,
}: {
  rows: Array<ComparisonRow | WorkingStyleRow>
  modelA: string
  modelB: string
  showWinners: boolean
}) {
  return (
    <div className="flex flex-col">
      <div className={cn(ROW_GRID, 'border-b border-line2 pb-1.5')}>
        <span className="text-[10.5px] uppercase tracking-wide text-mut2">Metric</span>
        <span className={cn(VALUE_CELL, 'truncate text-[10.5px] font-medium text-foreground')} title={modelA}>{modelA}</span>
        <span className={cn(VALUE_CELL, 'truncate text-[10.5px] font-medium text-foreground')} title={modelB}>{modelB}</span>
      </div>
      {rows.map(row => {
        const winner = 'winner' in row ? row.winner : 'none'
        return (
          <div key={row.label} className={cn(ROW_GRID, 'items-center py-[5px]')}>
            <span className="truncate text-[11.5px] text-muted-foreground" title={row.label}>{row.label}</span>
            <span className={cn(VALUE_CELL, 'text-[11.5px]', showWinners ? winnerClass(winner, 'a') : 'text-foreground')}>
              {compareValue(row.valueA, row.formatFn)}
            </span>
            <span className={cn(VALUE_CELL, 'text-[11.5px]', showWinners ? winnerClass(winner, 'b') : 'text-foreground')}>
              {compareValue(row.valueB, row.formatFn)}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function MetricsCard({ rows, modelA, modelB }: { rows: ComparisonRow[]; modelA: string; modelB: string }) {
  return (
    <Panel title="Metrics comparison" right="Green = better">
      <CompareRows rows={rows} modelA={modelA} modelB={modelB} showWinners />
    </Panel>
  )
}

function CategoryCard({ categories, modelA, modelB }: { categories: CategoryComparison[]; modelA: string; modelB: string }) {
  return (
    <Panel title="Category head-to-head" right="One-shot rate · edit turns">
      <div className="mb-2.5 flex items-center gap-3">
        <span className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
          <span className="size-[8px] rounded-full" style={{ background: seriesColorForModel(modelA) }} />
          {modelA}
        </span>
        <span className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
          <span className="size-[8px] rounded-full" style={{ background: seriesColorForModel(modelB) }} />
          {modelB}
        </span>
      </div>
      <div className="flex flex-col">
        {categories.map(category => (
          <div key={category.category} className="grid grid-cols-[minmax(0,1fr)_170px] items-center gap-x-3 py-[5px]">
            <span className="truncate text-[11.5px] text-muted-foreground" title={category.category}>{categoryLabel(category.category)}</span>
            <div className="flex flex-col gap-[3px]">
              <BarRow rate={category.oneShotRateA} turns={category.editTurnsA} winner={category.winner === 'a'} color={seriesColorForModel(modelA)} />
              <BarRow rate={category.oneShotRateB} turns={category.editTurnsB} winner={category.winner === 'b'} color={seriesColorForModel(modelB)} />
            </div>
          </div>
        ))}
      </div>
    </Panel>
  )
}

function BarRow({ rate, turns, winner, color }: { rate: number | null; turns: number; winner: boolean; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="h-[6px] flex-1 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full" style={{ width: `${rate ?? 0}%`, background: color }} />
      </span>
      <span className={cn(VALUE_CELL, 'w-[72px] text-[10.5px]', winner ? 'text-success' : 'text-muted-foreground')}>
        {compareValue(rate, 'percent')} <span className="text-mut2">({turns})</span>
      </span>
    </div>
  )
}

function WorkingStyleCard({ rows, modelA, modelB }: { rows: WorkingStyleRow[]; modelA: string; modelB: string }) {
  return (
    <Panel title="Working style" right="per turn">
      <CompareRows rows={rows} modelA={modelA} modelB={modelB} showWinners={false} />
    </Panel>
  )
}

function ModelPicker({
  models,
  value,
  onChange,
  label,
}: {
  models: CompareModelStat[]
  value: string | null
  onChange: (model: string) => void
  label: string
}) {
  const selected = models.find(model => model.model === value)
  return (
    <Select value={value ?? ''} onValueChange={next => { if (next) onChange(next) }}>
      <SelectTrigger size="sm" aria-label={label} className="h-[26px] rounded-md border-line2 px-2 text-[11px] text-foreground">
        <SelectValue>{selected?.displayName ?? 'Pick a model'}</SelectValue>
      </SelectTrigger>
      <SelectContent align="center">
        {models.map(model => (
          <SelectItem key={model.model} value={model.model}>
            {modelOptionLabel(model)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function CompareView(): React.JSX.Element {
  const scope = useShellStore(useShallow(selectScope))
  const payload = useCompareStore(s => s.data)
  const error = useCompareStore(s => s.error)
  const pair = useCompareStore(s => s.pair)
  const load = useCompareStore(s => s.load)
  const provider = useShellStore(s => s.provider)
  const setProvider = useShellStore(s => s.setProvider)
  const detectedProviders = useScanStore(s => s.detectedProviders)

  // Load on mount and on shell scope changes; the store keeps the committed
  // pair across refresh ticks (recorded deviation), so a scope change while a
  // pair is picked refetches that same pair.
  useEffect(() => {
    void load(scope, pair)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, load])

  // On each payload, keep the current pair if it is still detectable, otherwise
  // fall back to the top two by cost (the builder's own default).
  useEffect(() => {
    const models = payload?.models
    if (!models) return
    const available = new Set(models.map(model => model.model))
    const nextA = pair?.modelA && available.has(pair.modelA) ? pair.modelA : (models[0]?.model ?? null)
    const nextB = pair?.modelB && available.has(pair.modelB) ? pair.modelB : (models[1]?.model ?? null)
    if (nextA && nextB && (nextA !== pair?.modelA || nextB !== pair?.modelB)) {
      void load(scope, { modelA: nextA, modelB: nextB } satisfies ComparePair)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload])

  const providerOptions = useMemo(() => providerOptionsFromDetected(detectedProviders), [detectedProviders])

  // Keep the two pickers distinct: picking a model already held by the other
  // side nudges that side to the next available model.
  const pick = (side: 'a' | 'b', next: string): void => {
    const other = side === 'a' ? pair?.modelB : pair?.modelA
    const nudge = other !== next
      ? other
      : (payload?.models.find(model => model.model !== next)?.model ?? null)
    const modelA = side === 'a' ? next : nudge
    const modelB = side === 'b' ? next : nudge
    if (modelA && modelB && modelA !== modelB) {
      void load(scope, { modelA, modelB } satisfies ComparePair)
    }
  }

  const models = payload?.models ?? []

  return (
    <div className={cn('w-full max-w-[1180px]', motionClass('flex flex-col gap-3', 'section-fade'))}>
      {providerOptions.length > 1 && (
        <div className="flex justify-center">
          <SegTabs options={providerOptions} value={provider} onChange={setProvider} />
        </div>
      )}

      {payload === null ? (
        error ? <ErrorPanel message={error} /> : (
          <div className="rounded-lg border border-border bg-card px-3.5 py-6 text-center text-[12px] text-muted-foreground">Loading comparison…</div>
        )
      ) : models.length < 2 ? (
        <div className="rounded-lg border border-border bg-card px-3.5 py-6 text-center text-[12px] text-muted-foreground">
          Need at least two models with usage in this range to compare.
        </div>
      ) : (
        <>
          <div className="flex items-center justify-center gap-2.5" aria-label="Models being compared">
            <ModelPicker
              models={models}
              value={pair?.modelA ?? null}
              onChange={next => pick('a', next)}
              label="First model"
            />
            <span className="text-[11px] font-medium uppercase tracking-wide text-mut2">vs</span>
            <ModelPicker
              models={models}
              value={pair?.modelB ?? null}
              onChange={next => pick('b', next)}
              label="Second model"
            />
          </div>

          {payload.report && (
            <>
              <MetricsCard rows={payload.report.metrics} modelA={payload.report.modelA.displayName} modelB={payload.report.modelB.displayName} />

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <CategoryCard categories={payload.report.categories} modelA={payload.report.modelA.displayName} modelB={payload.report.modelB.displayName} />
                <WorkingStyleCard rows={payload.report.workingStyle} modelA={payload.report.modelA.displayName} modelB={payload.report.modelB.displayName} />
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
