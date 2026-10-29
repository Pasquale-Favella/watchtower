import { useMemo, useState } from 'react'

import { useModelsStore } from '@/features/models/use-models-store'
import { QueryErrorNotice } from '@/shared/components/QueryErrorNotice'
import { type SegOption, SegTabs } from '@/shared/components/SegTabs'
import { LoadingRegion, SkeletonRows } from '@/shared/components/skeletons'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { motionClass } from '@/shared/lib/motion'
import { providerOptionsFromDetected } from '@/shared/lib/shell'
import { cn } from '@/shared/lib/utils'

import type { ModelReportRow } from '../../../../shared/schemas/models.js'
import { AuditTable } from './audit-table'
import { ModelsByTaskTable, ModelsTable, type PricingRowActions } from './models-table'
import { QuickAddModal, type QuickAddTarget } from './quick-add-modal'

type ModelsLens = 'model' | 'task' | 'audit'

const LENSES: SegOption[] = [
  { value: 'model', label: 'By model' },
  { value: 'task', label: 'By task' },
  { value: 'audit', label: 'Audit' },
]

export function ModelsView(): React.JSX.Element {
  const {
    data: payload,
    error,
    removeAlias,
    removeOverride,
    provider,
    setProvider,
    detectedProviders,
  } = useModelsStore()
  const [lens, setLens] = useState<ModelsLens>('model')
  const [quickAdd, setQuickAdd] = useState<QuickAddTarget | null>(null)

  const providerOptions = useMemo(() => providerOptionsFromDetected(detectedProviders), [detectedProviders])

  const byModel = payload?.byModel ?? []
  const byTask = payload?.byTask ?? []
  const audit = payload?.audit ?? []

  const openQuickAdd = (row: ModelReportRow) =>
    setQuickAdd({
      provider: row.provider,
      model: row.model,
      modelDisplayName: row.modelDisplayName,
    })

  const onSaved = (): void => {
    setQuickAdd(null)
  }

  // Inline pricing management for aliased/repriced rows: the original name
  // stays visible with its alias target or rates, and each can be retargeted
  // (prefilled dialog — writes upsert) or removed (the row reverts to its
  // honest original treatment on the next query, no rescan).
  const pricingActions: PricingRowActions = {
    onEditAlias: (source, currentTarget) =>
      setQuickAdd({
        provider: source.provider,
        model: source.model,
        modelDisplayName: source.model,
        initialMode: 'alias',
        initialAliasTarget: currentTarget,
      }),
    onRemoveAlias: sourceModel => {
      void removeAlias(sourceModel)
    },
    onEditOverride: target =>
      setQuickAdd({
        provider: target.provider,
        model: target.model,
        modelDisplayName: target.modelDisplayName,
        initialMode: 'price',
        initialInputPrice: String(target.inputPricePerMillion),
        initialOutputPrice: String(target.outputPricePerMillion),
      }),
    onRemoveOverride: model => {
      void removeOverride(model)
    },
  }

  const emptyText =
    lens === 'audit' ? 'No model usage to audit in this range yet.' : 'No model usage in this range yet.'

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
        error ? (
          <QueryErrorNotice error={error} hasData={false} />
        ) : (
          <LoadingRegion label="Loading models…" className="border-border bg-card overflow-hidden rounded-lg border">
            <div className="border-border flex items-center gap-3 border-b px-3.5 py-2.5">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="ml-auto h-3 w-14" />
              <Skeleton className="h-3 w-14" />
              <Skeleton className="h-3 w-14" />
            </div>
            <SkeletonRows rows={9} className="px-3.5" />
          </LoadingRegion>
        )
      ) : lens === 'audit' ? (
        <>
          <QueryErrorNotice error={error} hasData />
          <div className="border-border bg-card overflow-hidden rounded-lg border">
            {audit.length ? (
              <AuditTable rows={audit} actions={pricingActions} />
            ) : (
              <p className="text-muted-foreground px-3.5 py-6 text-center text-[11.5px]">{emptyText}</p>
            )}
          </div>
        </>
      ) : lens === 'task' ? (
        <>
          <QueryErrorNotice error={error} hasData />
          <div className="border-border bg-card overflow-hidden rounded-lg border">
            {byTask.length ? (
              <ModelsByTaskTable rows={byTask} onAddAlias={openQuickAdd} actions={pricingActions} />
            ) : (
              <p className="text-muted-foreground px-3.5 py-6 text-center text-[11.5px]">{emptyText}</p>
            )}
          </div>
        </>
      ) : (
        <>
          <QueryErrorNotice error={error} hasData />
          <div className="border-border bg-card overflow-hidden rounded-lg border">
            {byModel.length ? (
              <ModelsTable rows={byModel} onAddAlias={openQuickAdd} actions={pricingActions} />
            ) : (
              <p className="text-muted-foreground px-3.5 py-6 text-center text-[11.5px]">{emptyText}</p>
            )}
          </div>
        </>
      )}

      {quickAdd && (
        <QuickAddModal
          key={`${quickAdd.provider}:${quickAdd.model}:${quickAdd.initialMode ?? 'price'}:${quickAdd.initialAliasTarget ?? ''}`}
          target={quickAdd}
          models={byModel}
          onClose={() => setQuickAdd(null)}
          onSaved={onSaved}
        />
      )}
    </div>
  )
}
