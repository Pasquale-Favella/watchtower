import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { useScanStore } from '@/app/stores/scan-store'
import { selectScope, useScopeStore } from '@/app/stores/scope-store'
import { DeliveryOutcomes } from '@/features/optimize/DeliveryOutcomes'
import { OptimizeFindings } from '@/features/optimize/OptimizeFindings'
import { OptimizeSummary } from '@/features/optimize/OptimizeSummary'
import { useOptimizeStore } from '@/features/optimize/store'
import { ErrorPanel } from '@/shared/components/ErrorPanel'
import { Panel } from '@/shared/components/Panel'
import { SegTabs } from '@/shared/components/SegTabs'
import { LoadingRegion, SkeletonRows } from '@/shared/components/skeletons'
import { motionClass } from '@/shared/lib/motion'
import { providerOptionsFromDetected } from '@/shared/lib/shell'
import { cn } from '@/shared/lib/utils'

type OptimizeTab = 'waste' | 'outcomes' | 'reverts'

export function OptimizeView(): React.JSX.Element {
  const scope = useScopeStore(useShallow(selectScope))
  const payload = useOptimizeStore(state => state.waste.data)
  const error = useOptimizeStore(state => state.waste.error)
  const load = useOptimizeStore(state => state.waste.load)
  const provider = useScopeStore(state => state.provider)
  const setProvider = useScopeStore(state => state.setProvider)
  const detectedProviders = useScanStore(state => state.detectedProviders)
  const [tab, setTab] = useState<OptimizeTab>('waste')
  const providerOptions = useMemo(() => providerOptionsFromDetected(detectedProviders), [detectedProviders])

  useEffect(() => {
    void load(scope)
  }, [load, scope])

  function renderContent(): React.JSX.Element {
    if (tab === 'outcomes' || tab === 'reverts')
      return <DeliveryOutcomes scope={scope} revertsOnly={tab === 'reverts'} />
    if (error) return <ErrorPanel message={error} />
    if (payload === null)
      return (
        <LoadingRegion label="Loading Optimize findings…">
          <SkeletonRows rows={6} />
        </LoadingRegion>
      )
    return (
      <>
        <OptimizeSummary payload={payload} />
        <OptimizeFindings findings={payload.findings} />
      </>
    )
  }

  return (
    <div className={cn('w-full max-w-[1180px]', motionClass('flex flex-col gap-3', 'section-fade'))}>
      {providerOptions.length > 1 && (
        <div className="flex justify-center">
          <SegTabs options={providerOptions} value={provider} onChange={setProvider} />
        </div>
      )}
      <div className="flex justify-center">
        <SegTabs
          options={[
            { value: 'waste', label: 'Waste' },
            { value: 'outcomes', label: 'Outcomes' },
            { value: 'reverts', label: 'Reverts' },
          ]}
          value={tab}
          onChange={value => setTab(value as OptimizeTab)}
        />
      </div>
      <Panel>{renderContent()}</Panel>
    </div>
  )
}
