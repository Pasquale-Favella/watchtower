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
    <button
      type="button"
      className="font-medium text-primary hover:underline"
      onClick={onClick}
    >
      add alias ›
    </button>
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
 * `costUSD === 0 && savingsUSD === 0` are dimmed and their token/cost cells
 * collapse to em dashes. */
export function cellClass(row: ModelReportRow): string | undefined {
  return isUnpriced(row) ? 'opacity-50' : undefined
}

export function tokenValue(row: ModelReportRow, value: number): string {
  return isUnpriced(row) ? '—' : formatCompact(value)
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

/** The six metric cells a model/category row renders, carrying the same
 * unpriced dimming treatment as the model cell that precedes them. */
export function MetricCells({ row }: { row: ModelReportRow }) {
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
