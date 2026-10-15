import { useState } from 'react'

import { cn } from '@/shared/lib/utils'
import { seriesColorForModel } from '@/shared/lib/modelSeries'
import { formatCompact, formatUsd, isUnpriced } from '@/shared/lib/models'
import { TableCell, TableHead, TableRow } from '@/shared/components/ui/table'
import type { ModelReportRow } from '../../../../shared/schemas/models.js'

export const NUM_CELL = 'text-right font-mono tabular-nums'
export const MUT_CELL = `${NUM_CELL} text-muted-foreground`
export const TH = 'text-[10.5px] uppercase tracking-wide text-muted-foreground'

export function AddAliasButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="text-primary font-medium hover:underline" onClick={onClick}>
      add alias ›
    </button>
  )
}

/** Compact two-click remove for dense table rows: first click arms ("sure?"),
 * second confirms; Escape or Cancel disarms. Smaller than the Settings
 * ConfirmRemove so merged-row lines stay one line tall. */
export function RemoveButton({ label, onRemove }: { label: string; onRemove: () => void }) {
  const [armed, setArmed] = useState(false)
  if (!armed) {
    return (
      <button
        type="button"
        className="text-muted-foreground hover:text-destructive font-medium hover:underline"
        onClick={() => setArmed(true)}
      >
        {label}
      </button>
    )
  }
  return (
    <span
      className="inline-flex items-center gap-1"
      onKeyDown={event => {
        if (event.key === 'Escape') setArmed(false)
      }}
    >
      <button
        type="button"
        autoFocus
        className="text-destructive font-medium hover:underline"
        onClick={() => {
          setArmed(false)
          onRemove()
        }}
      >
        confirm
      </button>
      <button type="button" className="text-muted-foreground hover:underline" onClick={() => setArmed(false)}>
        cancel
      </button>
    </span>
  )
}

/** One "original → target" line per raw model folded into a merged row, each
 * with retarget/remove so an alias is managed where it is seen. */
export function AliasLines({
  target,
  sources,
  onEdit,
  onRemove,
}: {
  target: string
  sources: string[]
  onEdit: (source: string) => void
  onRemove: (source: string) => void
}) {
  return (
    <>
      {sources.map(source => (
        <span key={source} className="text-muted-foreground flex items-center gap-1 truncate text-[9.5px] font-normal">
          <span className="truncate" title={`${source} → ${target}`}>
            alias · <span className="font-mono">{source}</span> → <span className="font-mono">{target}</span>
          </span>
          <button
            type="button"
            className="text-primary shrink-0 font-medium hover:underline"
            onClick={() => onEdit(source)}
          >
            edit
          </button>
          <RemoveButton label="remove" onRemove={() => onRemove(source)} />
        </span>
      ))}
    </>
  )
}

/** "Repriced" line for a row priced by a Price override, with edit/remove so
 * override rates are managed where they apply. */
export function OverrideLine({
  inputPricePerMillion,
  outputPricePerMillion,
  onEdit,
  onRemove,
}: {
  inputPricePerMillion: number
  outputPricePerMillion: number
  onEdit: () => void
  onRemove: () => void
}) {
  return (
    <span className="text-muted-foreground flex items-center gap-1 truncate text-[9.5px] font-normal">
      <span className="truncate" title={`in ${inputPricePerMillion} · out ${outputPricePerMillion} USD per 1M tokens`}>
        repriced · in {inputPricePerMillion} · out {outputPricePerMillion} /1M
      </span>
      <button type="button" className="text-primary shrink-0 font-medium hover:underline" onClick={onEdit}>
        edit
      </button>
      <RemoveButton label="remove" onRemove={onRemove} />
    </span>
  )
}

export function ModelDot({ model }: { model: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-[8px] shrink-0 rounded-full"
      style={{ background: seriesColorForModel(model) }}
    />
  )
}

/** The unpriced-row dimming treatment (ADR 0010): rows with
 * `costUSD === 0 && savingsUSD === 0` are dimmed and only their cost/saved
 * cells collapse to em dashes — token counts stay visible so alias work
 * can be prioritized by volume. */
export function cellClass(row: ModelReportRow): string | undefined {
  return isUnpriced(row) ? 'opacity-50' : undefined
}

export function tokenValue(_row: ModelReportRow, value: number): string {
  return formatCompact(value)
}

export function savedCell(row: ModelReportRow): string {
  if (isUnpriced(row)) return '—'
  return row.savingsUSD > 0 ? formatUsd(row.savingsUSD) : formatUsd(0)
}

/** The Calls/Input/Output/Cache read/Cost/Saved header cells shared by the
 * by-model and by-task tables (only the first column's label differs). */
export function MetricHeaders({ firstLabel }: { firstLabel: string }) {
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

/** The six metric cells a model/category row renders: token counts are
 * always shown (even when unpriced), only cost/saved collapse to dashes
 * with the dimming treatment from `cellClass`. */
export function MetricCells({ row }: { row: ModelReportRow }) {
  const dim = isUnpriced(row)
  return (
    <>
      <TableCell className={cn(MUT_CELL, 'text-[11px]', dim && 'opacity-50')}>
        {row.calls.toLocaleString('en-US')}
      </TableCell>
      <TableCell className={cn(MUT_CELL, 'text-[11px]', dim && 'opacity-50')}>
        {tokenValue(row, row.inputTokens)}
      </TableCell>
      <TableCell className={cn(MUT_CELL, 'text-[11px]', dim && 'opacity-50')}>
        {tokenValue(row, row.outputTokens)}
      </TableCell>
      <TableCell className={cn(MUT_CELL, 'text-[11px]', dim && 'opacity-50')}>
        {tokenValue(row, row.cacheReadTokens)}
      </TableCell>
      <TableCell
        className={cn(NUM_CELL, 'text-[11.5px]', dim ? 'text-muted-foreground opacity-50' : 'text-foreground')}
      >
        {dim ? '—' : formatUsd(row.costUSD)}
      </TableCell>
      <TableCell
        className={cn(
          'text-right font-mono text-[11.5px] tabular-nums',
          row.savingsUSD > 0 ? 'text-success' : 'text-muted-foreground',
          dim && 'opacity-50',
        )}
      >
        {savedCell(row)}
      </TableCell>
    </>
  )
}
