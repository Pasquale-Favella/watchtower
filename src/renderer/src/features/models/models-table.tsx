import { useMemo } from 'react'

import { cn } from '@/shared/lib/utils'
import {
  categoryLabel, formatUsd, groupTaskRows, isUnpriced, providerTitle, sumGroup, type ModelTaskGroup,
} from '@/shared/lib/models'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/shared/components/ui/table'
import type { ModelReportRow } from '../../../../shared/schemas/models.js'
import {
  AddAliasButton, cellClass, MetricCells, MetricHeaders, ModelDot, MUT_CELL, NUM_CELL,
} from './table-parts'

export function ModelsTable({ rows, onAddAlias }: { rows: ModelReportRow[]; onAddAlias: (row: ModelReportRow) => void }) {
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
                    <span className="truncate text-[9.5px] font-normal text-muted-foreground">{providerTitle(row.provider)}</span>
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

export function ModelsByTaskTable({ rows, onAddAlias }: { rows: ModelReportRow[]; onAddAlias: (row: ModelReportRow) => void }) {
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
              <span className="truncate text-[9.5px] font-normal text-muted-foreground">{providerTitle(lead.provider)}</span>
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
