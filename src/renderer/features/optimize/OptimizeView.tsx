import { useMemo, useState } from 'react'

import { DeliveryOutcomes } from '@/renderer/features/optimize/DeliveryOutcomes'
import { OptimizeFindings } from '@/renderer/features/optimize/OptimizeFindings'
import { OptimizeSummary } from '@/renderer/features/optimize/OptimizeSummary'
import { useOptimizeStore } from '@/renderer/features/optimize/use-optimize-store'
import { Panel } from '@/renderer/components/Panel'
import { QueryErrorNotice } from '@/renderer/components/QueryErrorNotice'
import { SegTabs } from '@/renderer/components/SegTabs'
import { LoadingRegion, SkeletonRows } from '@/renderer/components/skeletons'
import { motionClass } from '@/renderer/shared/lib/motion'
import { providerOptionsFromDetected } from '@/renderer/shared/lib/shell'
import { cn } from '@/renderer/shared/lib/utils'

type OptimizeTab = 'waste' | 'outcomes' | 'reverts'

export function OptimizeView(): React.JSX.Element {
  const { data: payload, error, scope, provider, setProvider, detectedProviders } = useOptimizeStore()
  const [tab, setTab] = useState<OptimizeTab>('waste')
  const providerOptions = useMemo(() => providerOptionsFromDetected(detectedProviders), [detectedProviders])

  function renderContent(): React.JSX.Element {
    if (tab === 'outcomes' || tab === 'reverts')
      return <DeliveryOutcomes scope={scope} revertsOnly={tab === 'reverts'} />
    if (payload === null) {
      if (error) return <QueryErrorNotice error={error} hasData={false} />
      return (
        <LoadingRegion label="Loading Optimize findings…">
          <SkeletonRows rows={6} />
        </LoadingRegion>
      )
    }
    return (
      <>
        <QueryErrorNotice error={error} hasData />
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
