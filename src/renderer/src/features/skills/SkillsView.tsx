import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { cn } from '@/shared/lib/utils'
import { Panel } from '@/shared/components/Panel'
import { SegTabs } from '@/shared/components/SegTabs'
import { motionClass } from '@/shared/lib/motion'
import { providerOptionsFromDetected } from '@/shared/lib/shell'
import { formatCompact, formatUsd } from '@/shared/lib/models'
import { ErrorPanel } from '@/shared/components/ErrorPanel'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { LoadingRegion, SkeletonRows } from '@/shared/components/skeletons'
import { useSkillsStore } from '@/features/skills/store'
import { selectScope, useScopeStore } from '@/app/stores/scope-store'
import { useScanStore } from '@/app/stores/scan-store'
import type { SkillCandidate, SkillsSource } from '../../../../shared/schemas/skills.js'

const SOURCE_LABEL: Record<SkillsSource, string> = {
  skill: 'skill',
  bash: 'command',
  tool: 'tool',
}

const SOURCE_CLASS: Record<SkillsSource, string> = {
  skill: 'bg-violet-500/10 text-violet-400',
  bash: 'bg-emerald-500/10 text-emerald-400',
  tool: 'bg-amber-500/10 text-amber-400',
}

/** One draft card: the normalized pattern, its source badge, the frequency ×
 * spread evidence, and an expandable list of the source sessions behind it
 * (ticket 24 — read-only; the review flow lands with ticket 25). */
function DraftRows({ candidates }: { candidates: SkillCandidate[] }) {
  const [expandedName, setExpandedName] = useState<string | null>(null)

  if (candidates.length === 0) {
    return <p className="py-6 text-center text-[12px] text-muted-foreground">No draft skills in this range yet.</p>
  }

  return (
    <div className="flex flex-col">
      {candidates.map(candidate => {
        const expanded = expandedName === `${candidate.source}\0${candidate.name}`
        return (
          <div key={`${candidate.source}\0${candidate.name}`} className="border-b border-border last:border-b-0">
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpandedName(current => current === `${candidate.source}\0${candidate.name}` ? null : `${candidate.source}\0${candidate.name}`)}
              className="flex w-full cursor-pointer items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-accent"
            >
              <span className={cn('shrink-0 rounded px-1.5 py-[2px] text-[9.5px] font-semibold uppercase tracking-wide', SOURCE_CLASS[candidate.source])}>
                {SOURCE_LABEL[candidate.source]}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-mono text-[12px] font-medium text-foreground">{candidate.name}</span>
                <span className="text-[10.5px] text-muted-foreground">
                  ×{candidate.frequency} · {candidate.spreadSessions} {candidate.spreadSessions === 1 ? 'session' : 'sessions'} / {candidate.spreadProjects} {candidate.spreadProjects === 1 ? 'project' : 'projects'} · {candidate.turns} {candidate.turns === 1 ? 'turn' : 'turns'}
                </span>
              </span>
              <span className="shrink-0 font-mono text-[11.5px] text-foreground">{formatUsd(candidate.costUSD)}</span>
              <span className={cn('text-muted-foreground transition-transform', expanded && 'rotate-90')} aria-hidden="true">›</span>
            </button>
            {expanded && (
              <div className="px-3.5 pb-3 pt-0.5" role="region" aria-label={`${candidate.name} evidence`}>
                {candidate.sample && candidate.source === 'bash' && (
                  <pre className="mb-2 max-h-[120px] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background p-2 text-[10.5px] font-mono leading-relaxed text-muted-foreground">
                    <code>{candidate.sample}</code>
                  </pre>
                )}
                {candidate.sourceSessions.map(session => (
                  <div key={session.sessionId} className="flex items-center gap-2 border-b border-border/60 py-1.5 last:border-b-0">
                    <span className="w-16 shrink-0 font-mono text-[10px] text-muted-foreground">{session.date}</span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[11px] font-medium text-foreground">{session.project}</span>
                      <span className="truncate font-mono text-[9.5px] text-muted-foreground">{session.sessionId}</span>
                    </span>
                    <span className="shrink-0 text-[10.5px] text-muted-foreground">{session.turns} {session.turns === 1 ? 'turn' : 'turns'}</span>
                    <span className="shrink-0 font-mono text-[11px] text-foreground">{formatUsd(session.costUSD)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** Below-threshold but repeated patterns, as a plain-text list (ticket 24;
 * ticket 25 keeps them visible alongside the review board). */
function OpportunityList({ candidates }: { candidates: SkillCandidate[] }) {
  const [open, setOpen] = useState(true)

  if (candidates.length === 0) return null

  return (
    <Panel>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
        className="flex w-full cursor-pointer items-center justify-between px-3.5 py-2.5 text-left hover:bg-accent"
      >
        <span className="text-[12px] font-medium text-foreground">Opportunities</span>
        <span className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-muted-foreground">{candidates.length.toLocaleString('en-US')}</span>
          <span className={cn('text-muted-foreground transition-transform', open && 'rotate-90')} aria-hidden="true">›</span>
        </span>
      </button>
      {open && (
        <div className="flex flex-col">
          {candidates.map(candidate => (
            <div key={`${candidate.source}\0${candidate.name}`} className="flex items-center gap-2.5 border-t border-border px-3.5 py-2">
              <span className={cn('shrink-0 rounded px-1.5 py-[2px] text-[9.5px] font-semibold uppercase tracking-wide', SOURCE_CLASS[candidate.source])}>
                {SOURCE_LABEL[candidate.source]}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground">{candidate.name}</span>
              <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground">
                ×{candidate.frequency} · {candidate.spreadSessions}s / {candidate.spreadProjects}p
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}

/** On-disk skill inventory entries never invoked in the current scope. */
function GhostList({ ghosts }: { ghosts: Array<{ name: string; root: string }> }) {
  if (ghosts.length === 0) return null

  return (
    <Panel>
      <div className="flex items-center justify-between border-b border-border px-3.5 py-2.5">
        <span className="text-[12px] font-medium text-foreground">Ghost skills</span>
        <span className="font-mono text-[11px] text-muted-foreground">{ghosts.length.toLocaleString('en-US')}</span>
      </div>
      <div className="flex flex-col">
        {ghosts.map(ghost => (
          <div key={`${ghost.root}\0${ghost.name}`} className="flex items-center gap-2.5 px-3.5 py-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground">{ghost.name}</span>
            <span className="shrink-0 truncate text-[10px] text-muted-foreground">{ghost.root}</span>
          </div>
        ))}
      </div>
    </Panel>
  )
}

/** Stat chip for the summary strip. */
function Stat({ label, value, tone }: { label: string; value: number; tone?: 'accent' }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col rounded-lg border border-border bg-card px-3 py-2">
      <span className="font-mono text-[18px] font-semibold leading-none tabular-nums text-foreground">{value.toLocaleString('en-US')}</span>
      <span className={cn('mt-1 text-[10.5px]', tone === 'accent' ? 'font-medium text-primary' : 'text-muted-foreground')}>{label}</span>
    </div>
  )
}

/** The Skills Section (ticket 24): the deterministic, offline detection board
 * — draft candidates with evidence, repeated-but-below-threshold opportunities,
 * and ghost skills cluttering the inventory. Read-only here; the review flow
 * (accept/revise/dismiss + harness prose) lands with ticket 25. */
export function SkillsView(): React.JSX.Element {
  const scope = useScopeStore(useShallow(selectScope))
  const payload = useSkillsStore(s => s.view.data)
  const error = useSkillsStore(s => s.view.error)
  const load = useSkillsStore(s => s.view.load)
  const provider = useScopeStore(s => s.provider)
  const setProvider = useScopeStore(s => s.setProvider)
  const detectedProviders = useScanStore(s => s.detectedProviders)

  useEffect(() => {
    void load(scope)
  }, [load, scope])

  const providerOptions = useMemo(() => providerOptionsFromDetected(detectedProviders), [detectedProviders])

  return (
    <div className={cn('w-full max-w-[1180px]', motionClass('flex flex-col gap-3', 'section-fade'))}>
      {providerOptions.length > 1 && (
        <div className="flex justify-center">
          <SegTabs options={providerOptions} value={provider} onChange={setProvider} />
        </div>
      )}

      {payload === null ? (
        error ? <ErrorPanel message={error} /> : (
          <LoadingRegion label="Scanning skill patterns…" className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="grid grid-cols-4 gap-2 p-3">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
            <SkeletonRows rows={5} className="px-3.5" />
          </LoadingRegion>
        )
      ) : (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Draft skills" value={payload.summary.drafts} tone="accent" />
            <Stat label="Opportunities" value={payload.summary.opportunities} />
            <Stat label="Ghost skills" value={payload.summary.ghosts} />
            <Stat label="Sessions in scope" value={payload.summary.sessions} />
          </div>

          <Panel>
            <div className="flex items-center justify-between border-b border-border px-3.5 py-2.5">
              <div className="flex min-w-0 flex-col">
                <span className="text-[12px] font-medium text-foreground">Draft skills</span>
                <span className="text-[10.5px] text-muted-foreground">
                  {formatCompact(payload.summary.skillEvents)} skill events · {formatCompact(payload.summary.bashEvents)} commands · {formatCompact(payload.summary.toolEvents)} tools in this scope
                </span>
              </div>
              <span className="font-mono text-[11px] text-muted-foreground">{payload.summary.calls.toLocaleString('en-US')} calls</span>
            </div>
            <DraftRows candidates={payload.drafts} />
          </Panel>

          <OpportunityList candidates={payload.opportunities} />
          <GhostList ghosts={payload.ghosts} />
        </div>
      )}
    </div>
  )
}
