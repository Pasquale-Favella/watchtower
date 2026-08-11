import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { cn } from '@/shared/lib/utils'
import { Panel } from '@/shared/components/Panel'
import { SegTabs } from '@/shared/components/SegTabs'
import { motionClass } from '@/shared/lib/motion'
import { providerOptionsFromDetected } from '@/shared/lib/shell'
import { formatCompact, formatUsd } from '@/shared/lib/models'
import { assembleDraftMarkdown, describeCandidate } from '../../../../shared/lib/skills-draft.js'
import { fetchSaveSkill } from '@/shared/lib/api'
import { ErrorPanel } from '@/shared/components/ErrorPanel'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { LoadingRegion, SkeletonRows } from '@/shared/components/skeletons'
import { useSkillsStore } from '@/features/skills/store'
import { useSettingsStore } from '@/features/settings/store'
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

const DISMISS_REASONS = ['not-a-skill', 'one-off', 'too-specific', 'other'] as const

/** One draft card (ticket 25): name + description, the evidence row, the
 *  monospace SKILL.md preview labeled template-vs-harness-authored, and the
 *  review action bar — Save (clipboard + OS save dialog), Revise (inline
 *  editor, local until saved), Generate (harness prose, consent-on only), and
 *  Dismiss (feeds the not-a-skill signal back into the detector). */
function DraftCard({ candidate }: { candidate: SkillCandidate }) {
  const dismiss = useSkillsStore(s => s.dismiss)
  const generateProse = useSkillsStore(s => s.generateProse)
  const prose = useSkillsStore(s => s.prose[`${candidate.source}\0${candidate.name}`])
  const consent = useSettingsStore(s => s.agentsConsent)

  const [expanded, setExpanded] = useState(false)
  const [revising, setRevising] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const [reason, setReason] = useState<(typeof DISMISS_REASONS)[number]>('not-a-skill')
  const [content, setContent] = useState(() => assembleDraftMarkdown(candidate))
  const [copied, setCopied] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)

  const authored = prose?.status === 'ready' && !!prose.markdown

  // When the harness prose lands, it becomes the card's content (labeled
  // harness-authored); the template remains the default until then.
  useEffect(() => {
    if (authored && prose?.markdown) setContent(prose.markdown)
  }, [authored, prose?.markdown])

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(content)
    } catch {
      return
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1_500)
  }

  const save = async (): Promise<void> => {
    setFeedback(null)
    const result = await fetchSaveSkill({ name: candidate.name, content })
    if (!result.ok) setFeedback(result.error)
    else if (result.data.ok) setFeedback(`Saved to ${result.data.path}`)
    else setFeedback(result.data.error)
  }

  const confirmDismiss = async (): Promise<void> => {
    await dismiss(candidate.source, candidate.name, reason)
    setDismissing(false)
  }

  return (
    <div className="border-b border-border last:border-b-0">
      <div className="px-3.5 py-2.5">
        <div className="flex items-start gap-2.5">
          <span className={cn('mt-0.5 shrink-0 rounded px-1.5 py-[2px] text-[9.5px] font-semibold uppercase tracking-wide', SOURCE_CLASS[candidate.source])}>
            {SOURCE_LABEL[candidate.source]}
          </span>
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded(current => !current)}
            className="flex min-w-0 flex-1 cursor-pointer flex-col text-left"
          >
            <span className="truncate font-mono text-[12px] font-medium text-foreground">{candidate.name}</span>
            <span className="truncate text-[10.5px] text-muted-foreground">{describeCandidate(candidate)}</span>
          </button>
          <span className="shrink-0 font-mono text-[11.5px] text-foreground">{formatUsd(candidate.costUSD)}</span>
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded(current => !current)}
            className={cn('shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')}
            aria-label="Evidence"
          >
            ›
          </button>
        </div>

        <p className="mt-1.5 text-[10.5px] tabular-nums text-muted-foreground">
          ×{candidate.frequency} · {candidate.spreadSessions} {candidate.spreadSessions === 1 ? 'session' : 'sessions'} / {candidate.spreadProjects} {candidate.spreadProjects === 1 ? 'project' : 'projects'} · {candidate.turns} {candidate.turns === 1 ? 'turn' : 'turns'}
        </p>

        {expanded && (
          <div className="mt-2 rounded-md border border-border bg-background" role="region" aria-label={`${candidate.name} evidence`}>
            {candidate.sourceSessions.map(session => (
              <div key={session.sessionId} className="flex items-center gap-2 border-b border-border/60 px-2.5 py-1.5 last:border-b-0">
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

        {revising ? (
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            rows={12}
            spellCheck={false}
            className="mt-2 w-full resize-y rounded-md border border-border bg-background p-2.5 font-mono text-[11px] leading-relaxed text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        ) : (
          <div className="mt-2">
            <div className="flex items-center justify-between">
              <span className={cn('text-[9.5px] font-semibold uppercase tracking-wide', authored ? 'text-primary' : 'text-muted-foreground')}>
                {authored ? 'Harness-authored draft' : 'Template draft'}
              </span>
              {prose?.status === 'loading' && <span className="text-[10px] text-muted-foreground">Generating…</span>}
              {prose?.status === 'error' && <span className="text-[10px] text-destructive">{prose.error}</span>}
            </div>
            <pre className="mt-1 max-h-[240px] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background p-2.5 font-mono text-[10.5px] leading-relaxed text-muted-foreground">
              <code>{content}</code>
            </pre>
          </div>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <CardAction onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</CardAction>
          <CardAction onClick={() => void save()}>Save…</CardAction>
          <CardAction onClick={() => setRevising(current => !current)}>{revising ? 'Done editing' : 'Revise'}</CardAction>
          {consent && !authored && (
            <CardAction onClick={() => void generateProse(candidate)} disabled={prose?.status === 'loading'}>
              {prose?.status === 'loading' ? 'Generating…' : 'Write with harness'}
            </CardAction>
          )}
          <CardAction onClick={() => setDismissing(current => !current)}>{dismissing ? 'Cancel' : 'Dismiss'}</CardAction>
          {feedback && <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">{feedback}</span>}
        </div>

        {!consent && (
          <p className="mt-1.5 text-[10px] text-muted-foreground">
            Template draft — allow AI agents in Settings › Privacy &amp; data to have the harness write the prose.
          </p>
        )}

        {dismissing && (
          <div className="mt-2 flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-2">
            <select
              value={reason}
              onChange={e => setReason(e.target.value as (typeof DISMISS_REASONS)[number])}
              className="rounded-md border border-border bg-card px-2 py-1 text-[11px] text-foreground focus:outline-none"
            >
              {DISMISS_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <CardAction onClick={() => void confirmDismiss()}>Not a skill — hide</CardAction>
          </div>
        )}
      </div>
    </div>
  )
}

function CardAction({ onClick, disabled, children }: {
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-md border border-border bg-card px-2 py-[3px] text-[10.5px] text-muted-foreground hover:text-foreground disabled:opacity-50"
    >
      {children}
    </button>
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

/** The Skills Section (tickets 24–25): the detection board plus the review
 * half — draft cards with evidence and proposed SKILL.md content, a
 * user-initiated save/copy, inline revise, and a dismiss flow that feeds the
 * not-a-skill signal back into the detector. Harness prose is consent-gated;
 * template drafts are the default and never break the board. */
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
            {payload.drafts.length === 0 ? (
              <p className="py-6 text-center text-[12px] text-muted-foreground">No draft skills in this range yet.</p>
            ) : (
              <div className="flex flex-col">
                {payload.drafts.map(candidate => <DraftCard key={`${candidate.source}\0${candidate.name}`} candidate={candidate} />)}
              </div>
            )}
          </Panel>

          <OpportunityList candidates={payload.opportunities} />
          <GhostList ghosts={payload.ghosts} />
        </div>
      )}
    </div>
  )
}
