import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { cn } from '@/shared/lib/utils'
import { SegTabs, type SegOption } from '@/shared/components/SegTabs'
import { motionClass } from '@/shared/lib/motion'
import { providerOptionsFromDetected } from '@/shared/lib/shell'
import { seriesColorForModel } from '@/shared/lib/modelSeries'
import {
  categoryLabel, formatCompact, formatUsd, groupTaskRows,
  isAuditEstimated, isUnpriced, providerTitle, sumGroup, type ModelTaskGroup,
} from '@/shared/lib/models'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/shared/components/ui/table'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/shared/components/ui/dialog'
import { fetchAddModelAlias, fetchSetModelPrice } from '@/shared/lib/api'
import { ErrorPanel } from '@/shared/components/ErrorPanel'
import { useModelsStore } from '@/features/models/store'
import { selectScope, useShellStore } from '@/app/stores/shell-store'
import { useScanStore } from '@/app/stores/scan-store'
import type { AuditRow, ModelReportRow } from '../../../../shared/schemas/models.js'

type ModelsLens = 'model' | 'task' | 'audit'

const LENSES: SegOption[] = [
  { value: 'model', label: 'By model' },
  { value: 'task', label: 'By task' },
  { value: 'audit', label: 'Audit' },
]

const NUM_CELL = 'text-right font-mono tabular-nums'
const MUT_CELL = `${NUM_CELL} text-muted-foreground`

function AddAliasButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="font-medium text-brand-text hover:underline"
      onClick={onClick}
    >
      add alias ›
    </button>
  )
}

function ModelDot({ model }: { model: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-[8px] shrink-0 rounded-full"
      style={{ background: seriesColorForModel(model) }}
    />
  )
}

/** The unpriced-row dimming treatment (ADR 0010): rows with
 * `costUSD === 0 && savingsUSD === 0` are dimmed and their token/cost cells
 * collapse to em dashes. */
function cellClass(row: ModelReportRow): string | undefined {
  return isUnpriced(row) ? 'opacity-50' : undefined
}

function tokenValue(row: ModelReportRow, value: number): string {
  return isUnpriced(row) ? '—' : formatCompact(value)
}

function savedCell(row: ModelReportRow): string {
  if (isUnpriced(row)) return '—'
  return row.savingsUSD > 0 ? formatUsd(row.savingsUSD) : formatUsd(0)
}

const TH = 'text-[10.5px] uppercase tracking-wide text-mut2'

/** The Calls/Input/Output/Cache read/Cost/Saved header cells shared by the
 * by-model and by-task tables (only the first column's label differs). */
function MetricHeaders({ firstLabel }: { firstLabel: string }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableHead className={TH}>{firstLabel}</TableHead>
      <TableHead className={cn(TH, 'text-right')}>Calls</TableHead>
      <TableHead className={cn(TH, 'text-right')}>Input</TableHead>
      <TableHead className={cn(TH, 'text-right')}>Output</TableHead>
      <TableHead className={cn(TH, 'text-right')}>Cache read</TableHead>
      <TableHead className={cn(TH, 'text-right')}>Cost</TableHead>
      <TableHead className={cn(TH, 'text-right')}>Saved</TableHead>
    </TableRow>
  )
}

/** The six metric cells a model/category row renders, carrying the same
 * unpriced dimming treatment as the model cell that precedes them. */
function MetricCells({ row }: { row: ModelReportRow }) {
  const dim = isUnpriced(row)
  return (
    <>
      <TableCell className={cn(MUT_CELL, 'text-[11px]', dim && 'opacity-50')}>{row.calls.toLocaleString('en-US')}</TableCell>
      <TableCell className={cn(MUT_CELL, 'text-[11px]', dim && 'opacity-50')}>{tokenValue(row, row.inputTokens)}</TableCell>
      <TableCell className={cn(MUT_CELL, 'text-[11px]', dim && 'opacity-50')}>{tokenValue(row, row.outputTokens)}</TableCell>
      <TableCell className={cn(MUT_CELL, 'text-[11px]', dim && 'opacity-50')}>{tokenValue(row, row.cacheReadTokens)}</TableCell>
      <TableCell className={cn(NUM_CELL, 'text-[11.5px]', dim ? 'opacity-50 text-muted-foreground' : 'text-foreground')}>{dim ? '—' : formatUsd(row.costUSD)}</TableCell>
      <TableCell className={cn('text-right font-mono text-[11.5px] tabular-nums', row.savingsUSD > 0 ? 'text-success' : 'text-muted-foreground', dim && 'opacity-50')}>
        {savedCell(row)}
      </TableCell>
    </>
  )
}

function ModelsTable({ rows, onAddAlias }: { rows: ModelReportRow[]; onAddAlias: (row: ModelReportRow) => void }) {
  return (
    <Table>
      <TableHeader>
        <MetricHeaders firstLabel="Model" />
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => {
          const unpriced = isUnpriced(row)
          return (
            <TableRow key={`${row.provider}-${row.model}-${index}`}>
              <TableCell className={cn('text-[12px] font-medium text-foreground', cellClass(row))}>
                <span className="flex items-center gap-2">
                  <ModelDot model={row.modelDisplayName || row.model} />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate" title={row.model}>{row.modelDisplayName}</span>
                    <span className="truncate text-[9.5px] font-normal text-mut2">{providerTitle(row.provider)}</span>
                  </span>
                  {unpriced && <AddAliasButton onClick={() => onAddAlias(row)} />}
                </span>
              </TableCell>
              <MetricCells row={row} />
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

function ModelsByTaskTable({ rows, onAddAlias }: { rows: ModelReportRow[]; onAddAlias: (row: ModelReportRow) => void }) {
  const groups = useMemo(() => groupTaskRows(rows), [rows])

  return (
    <Table>
      <TableHeader>
        <MetricHeaders firstLabel="Task" />
      </TableHeader>
      {groups.map(group => (
        <ModelsByTaskGroup key={`${group.provider}-${group.model}`} group={group} onAddAlias={onAddAlias} />
      ))}
    </Table>
  )
}

function ModelsByTaskGroup({ group, onAddAlias }: { group: ModelTaskGroup; onAddAlias: (row: ModelReportRow) => void }) {
  const lead = group.rows[0]!
  const total = sumGroup(group)
  const unpriced = isUnpriced(total)

  return (
    <TableBody>
      <TableRow className="bg-muted/30 hover:bg-muted/30">
        <TableCell className="text-[12px] font-medium text-foreground">
          <span className="flex items-center gap-2">
            <ModelDot model={lead.modelDisplayName || lead.model} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{lead.modelDisplayName}</span>
              <span className="truncate text-[9.5px] font-normal text-mut2">{providerTitle(lead.provider)}</span>
            </span>
            {unpriced && <AddAliasButton onClick={() => onAddAlias(lead)} />}
          </span>
        </TableCell>
        <TableCell className={cn(MUT_CELL, 'text-[11px]', unpriced && 'opacity-50')}>{total.calls.toLocaleString('en-US')}</TableCell>
        <TableCell aria-label="No aggregate input" />
        <TableCell aria-label="No aggregate output" />
        <TableCell aria-label="No aggregate cache read" />
        <TableCell className={cn(NUM_CELL, 'text-[11.5px]', unpriced ? 'opacity-50 text-muted-foreground' : 'text-foreground')}>{unpriced ? '—' : formatUsd(total.costUSD)}</TableCell>
        <TableCell className={cn('text-right font-mono text-[11.5px] tabular-nums', total.savingsUSD > 0 ? 'text-success' : 'text-muted-foreground', unpriced && 'opacity-50')}>
          {unpriced ? '—' : total.savingsUSD > 0 ? formatUsd(total.savingsUSD) : formatUsd(0)}
        </TableCell>
      </TableRow>
      {group.rows.map((row, index) => (
        <TableRow key={`${row.category ?? 'all'}-${index}`}>
          <TableCell className={cn('text-[11.5px] text-muted-foreground', cellClass(row))}>{categoryLabel(row.category)}</TableCell>
          <MetricCells row={row} />
        </TableRow>
      ))}
    </TableBody>
  )
}

function AuditTable({ rows }: { rows: AuditRow[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="text-[10.5px] uppercase tracking-wide text-mut2">Model</TableHead>
          <TableHead className="text-right text-[10.5px] uppercase tracking-wide text-mut2">Calls</TableHead>
          <TableHead className="text-right text-[10.5px] uppercase tracking-wide text-mut2">Input</TableHead>
          <TableHead className="text-right text-[10.5px] uppercase tracking-wide text-mut2">Output</TableHead>
          <TableHead className="text-right text-[10.5px] uppercase tracking-wide text-mut2">Reasoning</TableHead>
          <TableHead className="text-right text-[10.5px] uppercase tracking-wide text-mut2">Norm out</TableHead>
          <TableHead className="text-right text-[10.5px] uppercase tracking-wide text-mut2">Cache wr</TableHead>
          <TableHead className="text-right text-[10.5px] uppercase tracking-wide text-mut2">Cache rd</TableHead>
          <TableHead className="text-right text-[10.5px] uppercase tracking-wide text-mut2">Cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => {
          const estimated = isAuditEstimated(row)
          return (
            <TableRow key={`${row.provider}-${row.model}-${index}`}>
              <TableCell className="text-[12px] font-medium text-foreground">
                <span className="flex items-center gap-2">
                  <ModelDot model={row.modelDisplayName || row.model} />
                  <span className="min-w-0 truncate" title={row.model}>{row.modelDisplayName}</span>
                </span>
              </TableCell>
              <TableCell className={cn(MUT_CELL, 'text-[11px]')}>{row.calls.toLocaleString('en-US')}</TableCell>
              <TableCell className={cn(MUT_CELL, 'text-[11px]')}>{formatCompact(row.raw.inputTokens)}</TableCell>
              <TableCell className={cn(MUT_CELL, 'text-[11px]')}>{formatCompact(row.raw.outputTokens)}</TableCell>
              <TableCell className={cn(MUT_CELL, 'text-[11px]')}>{formatCompact(row.raw.reasoningTokens)}</TableCell>
              <TableCell className={cn(MUT_CELL, 'text-[11px]')}>{formatCompact(row.displayed.outputTokens)}</TableCell>
              <TableCell className={cn(MUT_CELL, 'text-[11px]')}>{formatCompact(row.displayed.cacheWriteTokens)}</TableCell>
              <TableCell className={cn(MUT_CELL, 'text-[11px]')}>{formatCompact(row.displayed.cacheReadTokens)}</TableCell>
              <TableCell className={cn(NUM_CELL, 'text-[11.5px] text-foreground')}>
                {formatUsd(row.attributedCostUSD)}
                {estimated && (
                  <span className="ml-1 text-[9px] font-normal uppercase text-warning" title="Cost is estimated (no live pricing or derived rate)"> est</span>
                )}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

type QuickAddTarget = { provider: string; model: string; modelDisplayName: string }

function QuickAddModal({
  target,
  onClose,
  onSaved,
}: {
  target: QuickAddTarget
  onClose: () => void
  onSaved: () => void
}) {
  const [mode, setMode] = useState<'alias' | 'price'>('alias')
  const [aliasTarget, setAliasTarget] = useState('')
  const [inputPrice, setInputPrice] = useState('')
  const [outputPrice, setOutputPrice] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

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
        const result = await fetchAddModelAlias(target.model, targetModel)
        if (!result.ok) {
          setError(result.error)
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
      const result = await fetchSetModelPrice(target.model, input, output)
      if (!result.ok) {
        setError(result.error)
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
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-[13px] tracking-tight">Price {target.modelDisplayName}</DialogTitle>
          <DialogDescription className="truncate text-[10px] text-mut2">{providerTitle(target.provider)} · {target.model}</DialogDescription>
        </DialogHeader>

        <SegTabs
          options={[
            { value: 'alias', label: 'Map to model' },
            { value: 'price', label: 'Manual price' },
          ]}
          value={mode}
          onChange={value => { setMode(value as 'alias' | 'price'); setError(null) }}
        />

        {mode === 'alias' ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="models-alias-target" className="text-[10.5px] font-medium text-muted-foreground">Price this model as</label>
            <Input
              id="models-alias-target"
              value={aliasTarget}
              onChange={event => setAliasTarget(event.target.value)}
              placeholder="claude-sonnet-4-5"
              className="h-7 text-[12px]"
            />
            <p className="text-[10px] text-mut2">Adds a <code className="font-mono">{target.model}</code> → target model alias. Existing calls repriced from their token usage, no rescan needed.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="models-price-input" className="text-[10.5px] font-medium text-muted-foreground">Input price · USD per 1M tokens</label>
            <Input
              id="models-price-input"
              value={inputPrice}
              onChange={event => setInputPrice(event.target.value)}
              inputMode="decimal"
              placeholder="0"
              className="h-7 text-[12px]"
            />
            <label htmlFor="models-price-output" className="text-[10.5px] font-medium text-muted-foreground">Output price · USD per 1M tokens</label>
            <Input
              id="models-price-output"
              value={outputPrice}
              onChange={event => setOutputPrice(event.target.value)}
              inputMode="decimal"
              placeholder="0"
              className="h-7 text-[12px]"
            />
            <p className="text-[10px] text-mut2">Writes a manual price override; the affected rows update without a rescan.</p>
          </div>
        )}

        {error && <p className="text-[11px] text-destructive">{error}</p>}

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="button" size="sm" onClick={() => void submit()} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ModelsView(): React.JSX.Element {
  const scope = useShellStore(useShallow(selectScope))
  const payload = useModelsStore(s => s.data)
  const error = useModelsStore(s => s.error)
  const load = useModelsStore(s => s.load)
  const reload = useModelsStore(s => s.reload)
  const provider = useShellStore(s => s.provider)
  const setProvider = useShellStore(s => s.setProvider)
  const detectedProviders = useScanStore(s => s.detectedProviders)
  const [lens, setLens] = useState<ModelsLens>('model')
  const [quickAdd, setQuickAdd] = useState<QuickAddTarget | null>(null)

  useEffect(() => {
    void load(scope)
  }, [load, scope])

  const providerOptions = useMemo(() => providerOptionsFromDetected(detectedProviders), [detectedProviders])

  const byModel = payload?.byModel ?? []
  const byTask = payload?.byTask ?? []
  const audit = payload?.audit ?? []

  const openQuickAdd = (row: ModelReportRow) => setQuickAdd({
    provider: row.provider,
    model: row.model,
    modelDisplayName: row.modelDisplayName,
  })

  const onSaved = (): void => {
    setQuickAdd(null)
    void reload()
  }

  const emptyText = lens === 'audit'
    ? 'No model usage to audit in this range yet.'
    : 'No model usage in this range yet.'

  return (
    <div className={cn('w-full max-w-[1180px]', motionClass('flex flex-col gap-3', 'section-fade'))}>
      {providerOptions.length > 1 && (
        <div className="flex justify-center">
          <SegTabs options={providerOptions} value={provider} onChange={setProvider} />
        </div>
      )}

      <div className="flex justify-center">
        <SegTabs options={LENSES} value={lens} onChange={value => setLens(value as ModelsLens)} />
      </div>

      {payload === null ? (
        error ? <ErrorPanel message={error} /> : (
          <div className="rounded-lg border border-border bg-card px-3.5 py-6 text-[12px] text-muted-foreground">Loading models…</div>
        )
      ) : lens === 'audit' ? (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {audit.length ? <AuditTable rows={audit} /> : <p className="px-3.5 py-6 text-center text-[11.5px] text-muted-foreground">{emptyText}</p>}
        </div>
      ) : lens === 'task' ? (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {byTask.length ? <ModelsByTaskTable rows={byTask} onAddAlias={openQuickAdd} /> : <p className="px-3.5 py-6 text-center text-[11.5px] text-muted-foreground">{emptyText}</p>}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {byModel.length ? <ModelsTable rows={byModel} onAddAlias={openQuickAdd} /> : <p className="px-3.5 py-6 text-center text-[11.5px] text-muted-foreground">{emptyText}</p>}
        </div>
      )}

      {quickAdd && (
        <QuickAddModal
          target={quickAdd}
          onClose={() => setQuickAdd(null)}
          onSaved={onSaved}
        />
      )}
    </div>
  )
}
