import { useAtomSet, useAtomValue } from '@effect/atom-react'
import { Download } from 'lucide-react'

import { PaneHeader } from '@/features/settings/pane-parts'
import { SegTabs } from '@/shared/components/SegTabs'
import { Button } from '@/shared/components/ui/button'
import { Card } from '@/shared/components/ui/card'
import { Separator } from '@/shared/components/ui/separator'

import {
  exportMachineAtom,
  exportNowAtom,
  selectExportFormat,
  selectExportFormatAtom,
  selectExporting,
  selectExportMessage,
} from './export-atoms'

export function ExportPane() {
  const machine = useAtomValue(exportMachineAtom)
  const format = selectExportFormat(machine)
  const exporting = selectExporting(machine)
  const result = selectExportMessage(machine)
  const selectFormat = useAtomSet(selectExportFormatAtom)
  const exportNow = useAtomSet(exportNowAtom)

  return (
    <div className="flex max-w-md flex-col gap-3">
      <PaneHeader title="Export" subtitle="Save your usage as CSV or JSON. Everything stays on your machine." />
      <Card className="px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-foreground text-[12.5px]">Format</span>
          <SegTabs
            options={[
              { value: 'csv', label: 'CSV' },
              { value: 'json', label: 'JSON' },
            ]}
            value={format}
            onChange={value => selectFormat(value as 'csv' | 'json')}
          />
        </div>
        <Separator className="my-3" />
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground text-[11px]">Files are written in the selected display currency.</span>
          <Button type="button" size="sm" disabled={exporting} onClick={() => exportNow(undefined)}>
            <Download className="size-3.5" />
            {exporting ? 'Exporting…' : 'Export'}
          </Button>
        </div>
        {result && (
          <p className={result.ok ? 'text-success mt-2 text-[11px]' : 'text-destructive mt-2 text-[11px]'}>
            {result.text}
          </p>
        )}
      </Card>
      <p className="text-muted-foreground text-[11px]">
        CSV packs one CSV per table (daily, activity, models, records, projects, sessions, tools, mcp, shell-commands —
        plus a README) into a single ZIP file you name in the save dialog. JSON writes one file (schema
        watchtower.export.v1).
      </p>
    </div>
  )
}
