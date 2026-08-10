import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { cn } from '@/shared/lib/utils'
import { SegTabs, type SegOption } from '@/shared/components/SegTabs'
import { motionClass } from '@/shared/lib/motion'
import { providerOptionsFromDetected } from '@/shared/lib/shell'
import { ErrorPanel } from '@/shared/components/ErrorPanel'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { LoadingRegion, SkeletonRows } from '@/shared/components/skeletons'
import { useModelsStore } from '@/features/models/store'
import { selectScope, useScopeStore } from '@/app/stores/scope-store'
import { useScanStore } from '@/app/stores/scan-store'
import type { ModelReportRow } from '../../../../shared/schemas/models.js'
import { AuditTable } from './audit-table'
import { ModelsByTaskTable, ModelsTable } from './models-table'
import { QuickAddModal, type QuickAddTarget } from './quick-add-modal'

type ModelsLens = 'model' | 'task' | 'audit'

const LENSES: SegOption[] = [
  { value: 'model', label: 'By model' },
  { value: 'task', label: 'By task' },
  { value: 'audit', label: 'Audit' },
]

export function ModelsView(): React.JSX.Element {
  const scope = useScopeStore(useShallow(selectScope))
  const payload = useModelsStore(s => s.data)
  const error = useModelsStore(s => s.error)
  const load = useModelsStore(s => s.load)
  const reload = useModelsStore(s => s.reload)
  const provider = useScopeStore(s => s.provider)
  const setProvider = useScopeStore(s => s.setProvider)
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
          <LoadingRegion label="Loading models…" className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="flex items-center gap-3 border-b border-border px-3.5 py-2.5">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="ml-auto h-3 w-14" />
              <Skeleton className="h-3 w-14" />
              <Skeleton className="h-3 w-14" />
            </div>
            <SkeletonRows rows={9} className="px-3.5" />
          </LoadingRegion>
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
          models={byModel}
          onClose={() => setQuickAdd(null)}
          onSaved={onSaved}
        />
      )}
    </div>
  )
}
