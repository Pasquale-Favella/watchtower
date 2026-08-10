import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { cn } from '@/shared/lib/utils'
import { SegTabs } from '@/shared/components/SegTabs'
import { Panel } from '@/shared/components/Panel'
import { motionClass } from '@/shared/lib/motion'
import { providerOptionsFromDetected } from '@/shared/lib/shell'
import { formatCompact, formatUsd } from '@/shared/lib/models'
import { impactDot, healthClass, trendLabel } from '@/features/optimize/lib'
import { ErrorPanel } from '@/shared/components/ErrorPanel'
import { useOptimizeStore } from '@/features/optimize/store'
import { selectScope, useShellStore } from '@/app/stores/shell-store'
import { useScanStore } from '@/app/stores/scan-store'
import type { OptimizeFinding, WasteAction } from '../../../../shared/schemas/optimize.js'
import type { YieldCategory, YieldPayload } from '../../../../shared/schemas/yield.js'
import type { OverviewScope } from '../../../../shared/schemas/overview.js'

type OptimizeTab = 'waste' | 'reverts' | 'abandoned' | 'fixes'

function fixText(fix: WasteAction): string {
  return fix.type === 'file-content' ? fix.content : fix.text
}

/** Read-only finding row: severity dot, title, trend, and token/dollar savings,
 * expanding to the clipboard-copyable fix snippet (ADR 0008). */
function FindingRows({ findings }: { findings: OptimizeFinding[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  if (findings.length === 0) {
    return <p className="py-6 text-center text-[12px] text-muted-foreground">No waste findings in this range yet.</p>
  }

  const copyFix = async (finding: OptimizeFinding): Promise<void> => {
    try {
      await navigator.clipboard.writeText(fixText(finding.fix))
    } catch {
      return
    }
    setCopiedId(finding.id)
    window.setTimeout(() => setCopiedId(current => current === finding.id ? null : current), 1_500)
  }

  return (
    <div className="flex flex-col">
      {findings.map(finding => {
        const expanded = expandedId === finding.id
        return (
          <div key={finding.id} className="border-b border-border last:border-b-0">
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpandedId(current => current === finding.id ? null : finding.id)}
              className="flex w-full cursor-pointer items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-accent"
            >
              <span className={cn('size-[8px] shrink-0 rounded-full', impactDot(finding.severity))} aria-hidden="true" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[12px] font-medium text-foreground">{finding.title}</span>
                <span className="text-[10.5px] text-muted-foreground">
                  {trendLabel(finding.trend)} · {formatCompact(finding.tokensSaved)} tokens
                </span>
              </span>
              <span className="shrink-0 font-mono text-[11.5px] text-foreground">{formatUsd(finding.estimatedSavingsUSD)}</span>
              <span className={cn('text-muted-foreground transition-transform', expanded && 'rotate-90')} aria-hidden="true">›</span>
            </button>
            {expanded && (
              <div className="px-3.5 pb-3 pt-0.5" role="region" aria-label={`${finding.title} details`}>
                <p className="mb-2.5 text-[11.5px] leading-relaxed text-muted-foreground">{finding.explanation}</p>
                <FixBlock finding={finding} copied={copiedId === finding.id} onCopy={() => void copyFix(finding)} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** The clipboard-copyable fix snippet block, shared by the Waste expand and the
 * Fixes tab (ADR 0008). */
function FixBlock({
  finding,
  copied,
  onCopy,
}: {
  finding: OptimizeFinding
  copied: boolean
  onCopy: () => void
}) {
  return (
    <div className="rounded-md border border-border bg-background p-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <b className="block text-[10.5px] text-foreground">{finding.fix.label}</b>
          {finding.fix.type === 'file-content' && (
            <span className="text-[10px] font-mono text-muted-foreground">{finding.fix.path}</span>
          )}
        </div>
        <button
          type="button"
          onClick={onCopy}
          className="shrink-0 rounded-md border border-border bg-card px-2 py-[3px] text-[10.5px] text-muted-foreground hover:text-foreground"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="max-h-[240px] overflow-auto whitespace-pre-wrap text-[11px] font-mono leading-relaxed text-muted-foreground">
        <code>{fixText(finding.fix)}</code>
      </pre>
    </div>
  )
}

/** Fixes tab: every finding's copyable fix snippet shown directly (no expand). */
function FixRows({ findings }: { findings: OptimizeFinding[] }) {
  const [copiedId, setCopiedId] = useState<string | null>(null)

  if (findings.length === 0) {
    return <p className="py-6 text-center text-[12px] text-muted-foreground">No fixes in this range yet.</p>
  }

  const copyFix = async (finding: OptimizeFinding): Promise<void> => {
    try {
      await navigator.clipboard.writeText(fixText(finding.fix))
    } catch {
      return
    }
    setCopiedId(finding.id)
    window.setTimeout(() => setCopiedId(current => current === finding.id ? null : current), 1_500)
  }

  return (
    <div className="flex flex-col">
      {findings.map(finding => (
        <div key={finding.id} className="border-b border-border last:border-b-0">
          <div className="flex items-center gap-2.5 px-3.5 pb-1 pt-2.5">
            <span className={cn('size-[8px] shrink-0 rounded-full', impactDot(finding.severity))} aria-hidden="true" />
            <span className="truncate text-[12px] font-medium text-foreground">{finding.title}</span>
            <span className="ml-auto shrink-0 font-mono text-[11.5px] text-muted-foreground">{formatUsd(finding.estimatedSavingsUSD)}</span>
          </div>
          <div className="px-3.5 pb-3">
            <FixBlock finding={finding} copied={copiedId === finding.id} onCopy={() => void copyFix(finding)} />
          </div>
        </div>
      ))}
    </div>
  )
}

/** Read-only yield rows for one category (ADR 0008): the bucket summary line
 * plus each session's project, commit count, and cost.
 * Read-only: no editable or inline bits. */
function YieldRows({ payload, category, empty }: {
  payload: YieldPayload | null
  category: YieldCategory
  empty: string
}) {
  if (payload === null) {
    return <p className="py-6 text-center text-[12px] text-muted-foreground">Scanning yield data…</p>
  }

  const bucket = payload.summary[category]
  const rows = payload.details.filter(row => row.category === category)
  if (rows.length === 0) {
    return <p className="py-6 text-center text-[12px] text-muted-foreground">{empty}</p>
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b border-border px-0.5 pb-2">
        <div>
          <b className="text-[12px] text-foreground">{category === 'reverted' ? 'Reverted' : 'Abandoned'}</b>
          <p className="text-[10.5px] text-muted-foreground">
            {bucket.sessions.toLocaleString('en-US')} {bucket.sessions === 1 ? 'session' : 'sessions'} ·{' '}
            {bucket.costPercent.toFixed(1)}% of period cost · {bucket.sessionPercent.toFixed(1)}% of sessions
          </p>
        </div>
        <div className="text-right">
          <span className="font-mono text-[22px] font-semibold leading-none text-foreground">{formatUsd(bucket.costUSD)}</span>
        </div>
      </div>

      {rows.map((row, i) => (
        <div key={row.sessionId} className="flex items-center gap-3 border-b border-border px-3.5 py-2.5 last:border-b-0">
          <span className="w-6 shrink-0 font-mono text-[11px] text-muted-foreground">{String(i + 1).padStart(2, '0')}</span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[12px] font-medium text-foreground">{row.project}</span>
            <span className="truncate text-[10.5px] text-muted-foreground">
              {row.commitCount.toLocaleString('en-US')} {row.commitCount === 1 ? 'commit' : 'commits'} · {row.sessionId}
            </span>
          </span>
          <span className="shrink-0 font-mono text-[11.5px] text-foreground">{formatUsd(row.costUSD)}</span>
        </div>
      ))}
    </div>
  )
}

/** Reverts / Abandoned tab body (ADR 0008). Mounts only when its tab is
 * active, so the yield payload is fetched lazily on demand — never at scan
 * time — and refetched whenever the scope changes. */
function YieldTab({ scope, category }: {
  scope: OverviewScope
  category: 'reverted' | 'abandoned'
}) {
  const payload = useOptimizeStore(s => s.yieldData.data)
  const error = useOptimizeStore(s => s.yieldData.error)
  const load = useOptimizeStore(s => s.yieldData.load)

  useEffect(() => {
    void load(scope)
  }, [scope, load])

  if (error) {
    return <ErrorPanel message={error} />
  }

  return (
    <YieldRows
      payload={payload}
      category={category}
      empty={`No ${category === 'reverted' ? 'reverted' : 'abandoned'} sessions in this range yet.`}
    />
  )
}

export function OptimizeView(): React.JSX.Element {
  const scope = useShellStore(useShallow(selectScope))
  const payload = useOptimizeStore(s => s.waste.data)
  const error = useOptimizeStore(s => s.waste.error)
  const load = useOptimizeStore(s => s.waste.load)
  const provider = useShellStore(s => s.provider)
  const setProvider = useShellStore(s => s.setProvider)
  const detectedProviders = useScanStore(s => s.detectedProviders)
  const [tab, setTab] = useState<OptimizeTab>('waste')

  useEffect(() => {
    void load(scope)
  }, [load, scope])

  const providerOptions = useMemo(() => providerOptionsFromDetected(detectedProviders), [detectedProviders])

  const wasteCount = payload?.summary.findingCount ?? 0
  const savingsUSD = payload?.summary.potentialSavingsCostUSD ?? 0
  const healthGrade = payload?.summary.healthGrade
  const healthScore = payload?.summary.healthScore

  const options: Array<{ value: OptimizeTab; label: string }> = [
    { value: 'waste', label: `Waste ${formatUsd(savingsUSD)}` },
    { value: 'reverts', label: 'Reverts' },
    { value: 'abandoned', label: 'Abandoned' },
    { value: 'fixes', label: `Fixes ${wasteCount.toLocaleString('en-US')}` },
  ]

  return (
    <div className={cn('w-full max-w-[1180px]', motionClass('flex flex-col gap-3', 'section-fade'))}>
      {providerOptions.length > 1 && (
        <div className="flex justify-center">
          <SegTabs options={providerOptions} value={provider} onChange={setProvider} />
        </div>
      )}

      <div className="flex justify-center">
        <SegTabs options={options} value={tab} onChange={value => setTab(value as OptimizeTab)} />
      </div>

      {payload === null ? (
        error ? <ErrorPanel message={error} /> : (
          <div className="rounded-lg border border-border bg-card px-3.5 py-6 text-center text-[12px] text-muted-foreground">
            Scanning optimize findings…
          </div>
        )
      ) : (
        <Panel>
          {healthGrade && (
            <div className="mb-2 flex items-center justify-between border-b border-border px-0.5 pb-2">
              <div>
                <b className="text-[12px] text-foreground">Setup health</b>
                <p className="text-[10.5px] text-muted-foreground">
                  {wasteCount.toLocaleString('en-US')} findings · {formatUsd(savingsUSD)} potential savings
                  {payload.summary.periodCostUSD > 0 && payload.summary.potentialSavingsPercent !== null
                    ? ` · ${payload.summary.potentialSavingsPercent.toFixed(1)}% of period cost`
                    : ''}
                </p>
              </div>
              <div className="text-right">
                <span className={cn('font-mono text-[22px] font-semibold leading-none', healthClass(healthGrade))}>
                  {healthGrade}
                </span>
                <p className="text-[10.5px] text-muted-foreground">{healthScore}/100</p>
              </div>
            </div>
          )}

          {tab === 'waste' ? (
            <FindingRows findings={payload.findings} />
          ) : tab === 'reverts' ? (
            <YieldTab scope={scope} category="reverted" />
          ) : tab === 'abandoned' ? (
            <YieldTab scope={scope} category="abandoned" />
          ) : (
            <FixRows findings={payload.findings} />
          )}
        </Panel>
      )}
    </div>
  )
}
