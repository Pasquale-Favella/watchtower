import { useState } from 'react'
import { Download } from 'lucide-react'

import { Button } from '@/shared/components/ui/button'
import { Card } from '@/shared/components/ui/card'
import { Separator } from '@/shared/components/ui/separator'
import { SegTabs } from '@/shared/components/SegTabs'
import { PaneHeader } from '@/features/settings/pane-parts'
import { fetchExport } from '@/shared/lib/api'

/** Settings › Export: CSV/JSON export through the export bridge, in the
 * currently selected display currency. The main process shows the folder/file
 * picker at export time — data never leaves the machine. */
export function ExportPane() {
  const [format, setFormat] = useState<'csv' | 'json'>('csv')
  const [exporting, setExporting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  const exportNow = async (): Promise<void> => {
    setResult(null)
    setExporting(true)
    try {
      const outcome = await fetchExport(format)
      setResult(outcome.ok
        ? { ok: true, text: `Exported to ${outcome.data.path}.` }
        : { ok: false, text: outcome.error ?? 'Export failed.' })
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : 'Export failed.' })
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="flex max-w-md flex-col gap-3">
      <PaneHeader
        title="Export"
        subtitle="Save your usage as CSV or JSON. Everything stays on your machine."
      />
      <Card className="px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12.5px] text-foreground">Format</span>
          <SegTabs
            options={[{ value: 'csv', label: 'CSV' }, { value: 'json', label: 'JSON' }]}
            value={format}
            onChange={value => { setFormat(value as 'csv' | 'json'); setResult(null) }}
          />
        </div>
        <Separator className="my-3" />
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-muted-foreground">Files are written in the selected display currency.</span>
          <Button type="button" size="sm" disabled={exporting} onClick={() => void exportNow()}>
            <Download className="size-3.5" />
            {exporting ? 'Exporting…' : 'Export'}
          </Button>
        </div>
        {result && (
          <p className={result.ok ? 'mt-2 text-[11px] text-success' : 'mt-2 text-[11px] text-destructive'}>
            {result.text}
          </p>
        )}
      </Card>
      <p className="text-[11px] text-muted-foreground">CSV writes a folder (summary, daily, models, projects, sessions, tools, mcp). JSON writes one file (schema watchtower.export.v1).</p>
    </div>
  )
}
