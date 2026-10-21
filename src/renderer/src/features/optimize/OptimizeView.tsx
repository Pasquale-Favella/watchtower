import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { useScanStore } from '@/app/stores/scan-store'
import { selectScope, useScopeStore } from '@/app/stores/scope-store'
import { DeliveryOutcomes } from '@/features/optimize/DeliveryOutcomes'
import { healthClass } from '@/features/optimize/lib'
import { OptimizeFindings } from '@/features/optimize/OptimizeFindings'
import { useOptimizeStore } from '@/features/optimize/store'
import { ErrorPanel } from '@/shared/components/ErrorPanel'
import { Panel } from '@/shared/components/Panel'
import { SegTabs } from '@/shared/components/SegTabs'
import { LoadingRegion, SkeletonRows } from '@/shared/components/skeletons'
import { formatUsd } from '@/shared/lib/models'
import { motionClass } from '@/shared/lib/motion'
import { providerOptionsFromDetected } from '@/shared/lib/shell'
import { cn } from '@/shared/lib/utils'

import type { OptimizePayload } from '../../../../shared/schemas/optimize.js'

type OptimizeTab = 'waste' | 'outcomes' | 'reverts' | 'fixes'

type FindingSummaryProps = { payload: OptimizePayload }

function FindingSummary({ payload }: FindingSummaryProps): React.JSX.Element {
  const { summary } = payload
  return (
    <div className="border-border mb-3 flex flex-wrap items-start justify-between gap-3 border-b pb-3">
      <div>
        <h2 className="text-foreground text-[12px] font-medium">Review opportunities</h2>
        <p className="text-muted-foreground mt-1 text-[11px]">
          {summary.findingCount} findings · {formatUsd(summary.periodCostUSD)} scoped spend · {summary.behaviorSessions}{' '}
          work sessions
        </p>
        <p className="text-muted-foreground mt-1 max-w-[720px] text-[10.5px] leading-relaxed">
          Findings describe observed patterns and modeled opportunities. Associated spend shows the supporting sessions'
          cost. Recoverable savings have not been established.
        </p>
        {summary.excludedSidechainSessions > 0 && (
          <p className="text-muted-foreground mt-1 text-[10.5px]">
            {summary.excludedSidechainSessions} delegated sessions retained in spend and excluded from standalone
            behavior comparisons.
          </p>
        )}
      </div>
      <div className="text-muted-foreground max-w-[240px] text-right text-[10.5px]">
        <span className="block">Setup health</span>
        {summary.healthGrade !== null && summary.healthScore !== null ? (
          <>
            <span className={cn('block font-mono text-[22px] font-semibold', healthClass(summary.healthGrade))}>
              {summary.healthGrade}
            </span>
            <span>{summary.healthScore}/100 · setup findings only</span>
          </>
        ) : (
          <span className="text-foreground mt-1 block">Insufficient setup evidence</span>
        )}
        <span className="mt-1 block">
          MCP inventory observed in {summary.setupCoverage.observedSessions} of {summary.setupCoverage.eligibleSessions}{' '}
          eligible sessions
        </span>
      </div>
    </div>
  )
}

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
        <FindingSummary payload={payload} />
        <OptimizeFindings key={tab} findings={payload.findings} showFix={tab === 'fixes'} />
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
            { value: 'fixes', label: `Fixes ${payload?.summary.findingCount ?? 0}` },
          ]}
          value={tab}
          onChange={value => setTab(value as OptimizeTab)}
        />
      </div>
      <Panel>{renderContent()}</Panel>
    </div>
  )
}
