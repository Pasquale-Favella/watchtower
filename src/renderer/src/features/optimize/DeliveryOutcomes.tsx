import { type ReactNode, useEffect, useState } from 'react'

import { navigateToSession } from '@/app/navigation'
import { useOptimizeStore } from '@/features/optimize/store'
import { ErrorPanel } from '@/shared/components/ErrorPanel'
import { LoadingRegion, SkeletonRows } from '@/shared/components/skeletons'
import { formatUsd } from '@/shared/lib/models'
import { cn } from '@/shared/lib/utils'

import type { OverviewScope } from '../../../../shared/schemas/overview.js'
import type { YieldCategory, YieldDetail, YieldPayload } from '../../../../shared/schemas/yield.js'

type EvidenceRowProps = { row: YieldDetail }
type DeliveryEvidenceProps = { payload: YieldPayload; revertsOnly?: boolean }
type DeliveryOutcomesProps = { scope: OverviewScope; revertsOnly?: boolean }
type OutcomeFilterProps = { selected: boolean; onSelect: () => void; children: ReactNode }

const OUTCOMES: ReadonlyArray<{ category: YieldCategory; label: string }> = [
  { category: 'productive', label: 'Matched to main' },
  { category: 'mixed', label: 'Mixed changes' },
  { category: 'reverted', label: 'Reverted changes' },
  { category: 'unmerged', label: 'Unmerged' },
  { category: 'unmatched', label: 'Unmatched' },
  { category: 'ambiguous', label: 'Ambiguous' },
  { category: 'unknown', label: 'Unknown' },
]

function outcomeLabel(category: YieldCategory): string {
  return OUTCOMES.find(outcome => outcome.category === category)?.label ?? category
}

function isRevertOutcome(category: YieldCategory): boolean {
  return category === 'reverted' || category === 'mixed'
}

function mainMembershipLabel(inMain: boolean | null): string {
  if (inMain === null) return 'Main membership unknown'
  return inMain ? 'On main' : 'Off main'
}

function revertStatusLabel(wasReverted: boolean | null): string {
  if (wasReverted === null) return 'Revert status unknown'
  return wasReverted ? 'Revert recorded' : 'No revert recorded'
}

function OutcomeFilter({ selected, onSelect, children }: OutcomeFilterProps): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'border-border hover:bg-accent rounded-md border px-2 py-2 text-left text-[11px]',
        selected && 'bg-accent',
      )}
    >
      {children}
    </button>
  )
}

function EvidenceRow({ row }: EvidenceRowProps): React.JSX.Element {
  return (
    <details className="border-border border-b py-2.5 last:border-b-0">
      <summary className="hover:bg-accent flex cursor-pointer items-center gap-3 rounded px-2 py-1">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-foreground text-[12px] font-medium">{row.project}</span>
          <span className="text-muted-foreground text-[10.5px]">
            {outcomeLabel(row.category)} · {row.commitCount} matched commits
          </span>
        </span>
        <span className="text-muted-foreground shrink-0 text-right text-[10px]">
          Associated spend<span className="text-foreground block font-mono text-[12px]">{formatUsd(row.costUSD)}</span>
        </span>
      </summary>
      <div className="text-muted-foreground flex flex-col gap-2 px-2 pt-2 text-[11px]">
        <p>{row.explanation}</p>
        <button
          type="button"
          onClick={() => navigateToSession(row.sessionId, row.sourceId)}
          className="text-primary w-fit text-left underline underline-offset-2"
        >
          Open session {row.sessionId}
        </button>
        {row.mainRef && (
          <p>
            Main ref inspected: <code>{row.mainRef}</code>
          </p>
        )}
        {row.window.start && row.window.end && (
          <p>
            Attribution window: {new Date(row.window.start).toLocaleString()} to{' '}
            {new Date(row.window.end).toLocaleString()}
          </p>
        )}
        {row.inspectionIssues.length > 0 && (
          <ul className="list-disc space-y-1 pl-4">
            {row.inspectionIssues.map((issue, index) => (
              <li key={`${issue.operation}:${index}`}>{issue.message}</li>
            ))}
          </ul>
        )}
        {row.commits.length > 0 && (
          <ul className="border-border flex flex-col gap-1 rounded border p-2" aria-label="Matched commit evidence">
            {row.commits.map(commit => (
              <li key={commit.sha} className="flex flex-wrap gap-x-2 gap-y-0.5">
                <code className="text-foreground" title={commit.sha}>
                  {commit.sha.slice(0, 12)}
                </code>
                <span>{mainMembershipLabel(commit.inMain)}</span>
                <span>{revertStatusLabel(commit.wasReverted)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  )
}

export function DeliveryEvidence({ payload, revertsOnly = false }: DeliveryEvidenceProps): React.JSX.Element {
  const [selected, setSelected] = useState<YieldCategory | 'all'>('all')
  const available = revertsOnly ? OUTCOMES.filter(outcome => isRevertOutcome(outcome.category)) : OUTCOMES
  const candidates = payload.details.filter(row => !revertsOnly || isRevertOutcome(row.category))
  const rows = candidates.filter(row => selected === 'all' || row.category === selected)

  return (
    <div className="flex flex-col gap-3">
      <div className="border-border border-b pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-foreground text-[12px] font-medium">
              {revertsOnly ? 'Sessions with reverted changes' : 'Delivery evidence'}
            </h2>
            <p className="text-muted-foreground mt-1 max-w-[720px] text-[11px] leading-relaxed">
              Amounts show scoped session spend associated with each outcome. Research, reviews, and work in progress
              may have no matched commit.
            </p>
          </div>
          <span className="text-muted-foreground text-right text-[10px]">
            Total scoped spend
            <span className="text-foreground block font-mono text-[18px]">
              {formatUsd(payload.summary.total.costUSD)}
            </span>
          </span>
        </div>
        <p className="text-muted-foreground mt-2 text-[10.5px]">
          Inspected {payload.coverage.inspectedSessions} of {payload.coverage.totalSessions} sessions ·{' '}
          {payload.coverage.unknownSessions} unknown · Observed {new Date(payload.observedAt).toLocaleString()}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4" role="group" aria-label="Filter delivery outcomes">
        <OutcomeFilter selected={selected === 'all'} onSelect={() => setSelected('all')}>
          <span className="text-foreground block">{revertsOnly ? 'All reverted or mixed' : 'All outcomes'}</span>
          <span className="text-muted-foreground">{candidates.length} sessions</span>
        </OutcomeFilter>
        {available.map(outcome => {
          const bucket = payload.summary[outcome.category]
          return (
            <OutcomeFilter
              key={outcome.category}
              selected={selected === outcome.category}
              onSelect={() => setSelected(outcome.category)}
            >
              <span className="text-foreground block">{outcome.label}</span>
              <span className="text-foreground block font-mono">{formatUsd(bucket.costUSD)}</span>
              <span className="text-muted-foreground">
                {bucket.sessions} sessions · {bucket.costPercent.toFixed(1)}% of spend
              </span>
            </OutcomeFilter>
          )
        })}
      </div>
      {rows.length > 0 ? (
        <div>
          {rows.map(row => (
            <EvidenceRow key={row.key} row={row} />
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground py-6 text-center text-[12px]">
          No sessions match this outcome in the selected scope.
        </p>
      )}
      <details className="text-muted-foreground border-border border-t pt-2 text-[11px]">
        <summary className="cursor-pointer">How attribution works</summary>
        <p className="mt-2 leading-relaxed">
          Each commit is credited to the tightest containing session window, including a{' '}
          {payload.attribution.graceMinutes}-minute allowance after its last recorded call. Commit proximity is a
          heuristic and does not establish authorship.
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-4">
          {payload.attribution.limitations.map(limitation => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
      </details>
    </div>
  )
}

export function DeliveryOutcomes({ scope, revertsOnly = false }: DeliveryOutcomesProps): React.JSX.Element {
  const payload = useOptimizeStore(state => state.yieldData.data)
  const error = useOptimizeStore(state => state.yieldData.error)
  const load = useOptimizeStore(state => state.yieldData.load)

  useEffect(() => {
    void load(scope)
  }, [scope, load])

  if (error) return <ErrorPanel message={error} />
  if (payload === null)
    return (
      <LoadingRegion label="Loading delivery evidence…">
        <SkeletonRows rows={5} />
      </LoadingRegion>
    )
  return <DeliveryEvidence key={revertsOnly ? 'reverts' : 'outcomes'} payload={payload} revertsOnly={revertsOnly} />
}
