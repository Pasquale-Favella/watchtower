import { useState } from 'react'

import { navigateToSession } from '@/app/navigation'
import { impactDot, trendLabel } from '@/features/optimize/lib'
import { formatCompact } from '@/shared/lib/models'
import { useCurrencyFormatter } from '@/shared/lib/use-currency-formatter'
import { cn } from '@/shared/lib/utils'

import type { OptimizeFinding, WasteAction } from '../../../../shared/schemas/optimize.js'

type FindingProps = { finding: OptimizeFinding }
type FindingRowProps = FindingProps & { defaultExpanded?: boolean }
type OptimizeFindingsProps = { findings: OptimizeFinding[] }

const GROUPS = [
  { value: 'setup', label: 'Setup', description: 'Review your current configuration and its observed usage.' },
  { value: 'habit', label: 'Habits', description: 'Patterns to consider when starting or continuing work.' },
  { value: 'information', label: 'For review', description: 'These costs may be justified by the work.' },
] as const

function fixText(fix: WasteAction): string {
  return fix.type === 'file-content' ? fix.content : fix.text
}

function quantityLabel(finding: OptimizeFinding): string {
  const prefix = finding.basis === 'modeled' ? 'Modeled ' : 'Observed '
  if (finding.quantity.unit === 'ratio') return `${prefix}${finding.quantity.value.toFixed(1)} reads per edit`
  return `${prefix}${formatCompact(finding.quantity.value)} ${finding.quantity.unit}`
}

function FindingEvidence({ finding }: FindingProps): React.JSX.Element {
  const { formatUsd } = useCurrencyFormatter()
  return (
    <div className="flex flex-col gap-2.5 text-[11.5px]">
      <p className="text-muted-foreground leading-relaxed">{finding.explanation}</p>
      {finding.assumptions.length > 0 && (
        <ul className="text-muted-foreground list-disc space-y-1 pl-4">
          {finding.assumptions.map(assumption => (
            <li key={assumption}>{assumption}</li>
          ))}
        </ul>
      )}
      {finding.affectedSessions.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-muted-foreground text-[10.5px]">Supporting sessions. Amounts show their scoped spend.</p>
          {finding.affectedSessions.map(session => (
            <button
              key={session.key}
              type="button"
              onClick={() => navigateToSession(session.sessionId, session.sourceId)}
              className="border-border hover:bg-accent flex items-start justify-between gap-3 rounded border px-2 py-1.5 text-left"
              aria-label={`Open supporting session ${session.sessionId}`}
            >
              <span className="min-w-0">
                <span className="text-foreground block truncate">
                  {session.project} · {session.sessionId}
                </span>
                {session.reasons.map(reason => (
                  <span key={reason} className="text-muted-foreground block">
                    {reason}
                  </span>
                ))}
              </span>
              <span className="text-muted-foreground shrink-0 font-mono">{formatUsd(session.costUSD)}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground text-[10.5px]">
          Session-level attribution is unavailable for this finding.
        </p>
      )}
    </div>
  )
}

function FixBlock({ finding }: FindingProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const text = fixText(finding.fix)

  async function copyFix(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="border-border bg-background rounded-md border p-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <b className="text-foreground block text-[10.5px]">{finding.fix.label}</b>
          {finding.fix.type === 'file-content' && (
            <span className="text-muted-foreground font-mono text-[10px]">{finding.fix.path}</span>
          )}
        </div>
        <button
          type="button"
          onClick={() => void copyFix()}
          className="border-border bg-card text-muted-foreground hover:text-foreground shrink-0 rounded-md border px-2 py-[3px] text-[10.5px]"
        >
          {copied ? 'Copied' : 'Copy suggestion'}
        </button>
      </div>
      <pre className="text-muted-foreground max-h-[240px] overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
        <code>{text}</code>
      </pre>
      <p className="text-muted-foreground mt-2 text-[10px]">
        Review before applying. Watchtower does not change your setup.
      </p>
    </div>
  )
}

export function FindingRow({ finding, defaultExpanded = false }: FindingRowProps): React.JSX.Element {
  const { formatUsd } = useCurrencyFormatter()
  const [expanded, setExpanded] = useState(defaultExpanded)
  return (
    <div className="border-border border-b last:border-b-0">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(current => !current)}
        className="hover:bg-accent flex w-full cursor-pointer items-center gap-2.5 px-3.5 py-2.5 text-left"
      >
        <span className={cn('size-[8px] shrink-0 rounded-full', impactDot(finding.severity))} aria-hidden="true" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-foreground text-[12px] font-medium">{finding.title}</span>
          <span className="text-muted-foreground text-[10.5px]">
            {quantityLabel(finding)} · {trendLabel(finding.trend)}
          </span>
        </span>
        {finding.associatedSpendUSD !== null && (
          <span className="text-muted-foreground shrink-0 text-right text-[10px]">
            Associated spend
            <span className="text-foreground block font-mono text-[11.5px]">
              {formatUsd(finding.associatedSpendUSD)}
            </span>
          </span>
        )}
        <span className={cn('text-muted-foreground transition-transform', expanded && 'rotate-90')} aria-hidden="true">
          ›
        </span>
      </button>
      {expanded && (
        <div className="flex flex-col gap-3 px-3.5 pt-0.5 pb-3" role="region" aria-label={`${finding.title} details`}>
          <FindingEvidence finding={finding} />
          <FixBlock finding={finding} />
        </div>
      )}
    </div>
  )
}

export function OptimizeFindings({ findings }: OptimizeFindingsProps): React.JSX.Element {
  if (findings.length === 0)
    return (
      <p className="text-muted-foreground py-6 text-center text-[12px]">
        No findings with sufficient evidence in this range.
      </p>
    )
  return (
    <div className="flex flex-col gap-4">
      {GROUPS.map(group => {
        const rows = findings.filter(finding => finding.findingClass === group.value)
        if (rows.length === 0) return null
        return (
          <section key={group.value} aria-label={`${group.label} findings`}>
            <div className="border-border border-b px-0.5 pb-2">
              <h3 className="text-foreground text-[12px] font-medium">
                {group.label} · {rows.length}
              </h3>
              <p className="text-muted-foreground text-[10.5px]">{group.description}</p>
            </div>
            {rows.map(finding => (
              <FindingRow key={finding.id} finding={finding} />
            ))}
          </section>
        )
      })}
    </div>
  )
}
