import { cn } from '@/shared/lib/utils'
import { formatCompact, formatUsd, isAuditEstimated } from '@/shared/lib/models'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/shared/components/ui/table'
import type { AuditRow } from '../../../../shared/schemas/models.js'
import { AliasLines, ModelDot, MUT_CELL, NUM_CELL, OverrideLine, TH } from './table-parts'
import type { PricingRowActions } from './models-table'

export function AuditTable({ rows, actions }: { rows: AuditRow[]; actions: PricingRowActions }) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className={TH}>Model</TableHead>
          <TableHead className="text-right text-[10.5px] uppercase tracking-wide text-muted-foreground">Calls</TableHead>
          <TableHead className="text-right text-[10.5px] uppercase tracking-wide text-muted-foreground">Input</TableHead>
          <TableHead className="text-right text-[10.5px] uppercase tracking-wide text-muted-foreground">Output</TableHead>
          <TableHead className="text-right text-[10.5px] uppercase tracking-wide text-muted-foreground">Reasoning</TableHead>
          <TableHead className="text-right text-[10.5px] uppercase tracking-wide text-muted-foreground">Norm out</TableHead>
          <TableHead className="text-right text-[10.5px] uppercase tracking-wide text-muted-foreground">Cache wr</TableHead>
          <TableHead className="text-right text-[10.5px] uppercase tracking-wide text-muted-foreground">Cache rd</TableHead>
          <TableHead className="text-right text-[10.5px] uppercase tracking-wide text-muted-foreground">Cost</TableHead>
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
                  <span className="flex min-w-0 flex-col">
                    <span className="min-w-0 truncate" title={row.model}>{row.modelDisplayName}</span>
                    {row.aliasOf ? (
                      <AliasLines
                        target={row.aliasOf}
                        sources={[row.model]}
                        onEdit={source => actions.onEditAlias({ provider: row.provider, model: source }, row.aliasOf!)}
                        onRemove={actions.onRemoveAlias}
                      />
                    ) : null}
                    {row.override ? (
                      <OverrideLine
                        inputPricePerMillion={row.override.inputPricePerMillion}
                        outputPricePerMillion={row.override.outputPricePerMillion}
                        onEdit={() => actions.onEditOverride({
                          provider: row.provider,
                          model: row.aliasOf ?? row.model,
                          modelDisplayName: row.aliasOf ?? row.modelDisplayName,
                          inputPricePerMillion: row.override!.inputPricePerMillion,
                          outputPricePerMillion: row.override!.outputPricePerMillion,
                        })}
                        onRemove={() => actions.onRemoveOverride(row.aliasOf ?? row.model)}
                      />
                    ) : null}
                  </span>
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
