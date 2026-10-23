import { useAtomSet, useAtomValue } from '@effect/atom-react'
import { useMemo, useState } from 'react'

import { scanStateAtom } from '@/app/atoms/scan'
import { overviewScopeAtom, providerAtom, setProviderAtom } from '@/app/atoms/scope'
import { useRemoteQuery } from '@/app/hooks/use-remote-query'
import { optimizeQuery } from '@/features/optimize/atoms'
import { DeliveryOutcomes } from '@/features/optimize/DeliveryOutcomes'
import { OptimizeFindings } from '@/features/optimize/OptimizeFindings'
import { OptimizeSummary } from '@/features/optimize/OptimizeSummary'
import { Panel } from '@/shared/components/Panel'
import { QueryErrorNotice } from '@/shared/components/QueryErrorNotice'
import { SegTabs } from '@/shared/components/SegTabs'
import { LoadingRegion, SkeletonRows } from '@/shared/components/skeletons'
import { motionClass } from '@/shared/lib/motion'
import { keyOfScope } from '@/shared/lib/query-keys'
import { providerOptionsFromDetected } from '@/shared/lib/shell'
import { cn } from '@/shared/lib/utils'

type OptimizeTab = 'waste' | 'outcomes' | 'reverts'

export function OptimizeView(): React.JSX.Element {
  const scope = useAtomValue(overviewScopeAtom)
  const { data: payload, error } = useRemoteQuery(optimizeQuery, scope, keyOfScope)
  const provider = useAtomValue(providerAtom)
  const setProvider = useAtomSet(setProviderAtom)
  const detectedProviders = useAtomValue(scanStateAtom).detectedProviders
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
