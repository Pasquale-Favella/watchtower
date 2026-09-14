import type { KeyboardEvent, MouseEvent } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { GitPullRequest, ChevronRight } from 'lucide-react'
import { cn } from '@/shared/lib/utils'
import { Panel } from '@/shared/components/Panel'
import { MetricCard } from '@/features/overview/MetricCard'
import { Card } from '@/shared/components/ui/card'
import { SegTabs } from '@/shared/components/SegTabs'
import { motionClass } from '@/shared/lib/motion'
import { providerOptionsFromDetected } from '@/shared/lib/shell'
import { spanLabel, sessionWord, summarizePullRequests, payloadSpan } from '@/features/pull-requests/lib'
import { formatUsd } from '@/shared/lib/models'
import { ErrorPanel } from '@/shared/components/ErrorPanel'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { LoadingRegion, SkeletonCard, SkeletonMetricCard, SkeletonRows } from '@/shared/components/skeletons'
import { usePullRequestsStore } from '@/features/pull-requests/store'
import { selectScope, useScopeStore } from '@/app/stores/scope-store'
import { useScanStore } from '@/app/stores/scan-store'
import type { PullRequestsPayload, PullRequestRow } from '../../../../shared/schemas/pull-requests.js'

function openPr(event: MouseEvent<HTMLAnchorElement>, url: string): void {
  event.preventDefault()
  event.stopPropagation()
  void window.api.openExternal(url)
}

// Keyboard activation for the button-role row, guarded so Enter/Space fired on
// the inner link (its own control) never doubles up as a row toggle.
function rowKeyDown(event: KeyboardEvent<HTMLDivElement>, toggle: () => void): void {
  if (event.target !== event.currentTarget) return
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    toggle()
  }
}

function ModelChips({ models }: { models: string[] }) {
  return (
    <div className="flex flex-wrap gap-1" aria-label={models.length ? `Models used: ${models.join(', ')}` : 'No model data'}>
      {models.map(model => (
        <span key={model} className="rounded border border-border bg-background px-1.5 py-px font-mono text-[10px] text-muted-foreground">
          {model}
        </span>
      ))}
    </div>
  )
}

function PrRowView({ pr, expanded, onToggle }: { pr: PullRequestRow; expanded: boolean; onToggle: () => void }) {
  const models = pr.models ?? []
  const categories = pr.categories ?? []
  const catMax = categories.length ? Math.max(...categories.map(cat => cat.cost)) : 0

  return (
    <div className={cn('border-t border-border first:border-t-0', expanded && 'bg-accent/40')}>
      <div
        className="flex cursor-pointer select-none items-center gap-3 px-3.5 py-2 transition-colors hover:bg-accent"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={event => rowKeyDown(event, onToggle)}
      >
        <GitPullRequest className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="min-w-0">
            <a className="truncate text-[12.5px] font-medium text-foreground hover:text-primary hover:underline" href={pr.url} title={pr.url} onClick={event => openPr(event, pr.url)}>
              {pr.label}
            </a>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-muted-foreground">
            <span>{spanLabel(pr.firstStarted, pr.lastEnded)}</span>
            <span>{pr.sessions.toLocaleString('en-US')} {sessionWord(pr.sessions)}</span>
            <span>{pr.calls.toLocaleString('en-US')} calls</span>
          </div>
        </div>
        <div className="hidden min-w-0 max-w-[260px] shrink-0 flex-col items-end gap-1 lg:flex">
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Models</span>
          <ModelChips models={models} />
        </div>
        <div className="w-20 shrink-0 text-right">
          <span className="block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Spend</span>
          <strong className="font-mono text-[12.5px] tabular-nums text-foreground">{formatUsd(pr.cost)}</strong>
        </div>
        <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} aria-hidden="true" />
      </div>
      {expanded && (
        <div className="px-3.5 pb-2.5">
          {categories.length > 0 ? (
            <div role="region" aria-label={`${pr.label} cost breakdown`} className="flex flex-col gap-1.5 border-t border-border pt-2">
              <div className="flex items-center justify-between text-[10.5px]">
                <span className="font-medium text-muted-foreground">Work breakdown</span>
                <strong className="font-mono tabular-nums text-foreground">{formatUsd(pr.cost)} total</strong>
              </div>
              <div className="flex flex-col gap-1.5">
                {categories.map(cat => (
                  <div className="flex items-center gap-2.5" key={cat.name}>
                    <span className="w-28 shrink-0 truncate text-[11px] text-muted-foreground">{cat.name}</span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-background" aria-hidden="true">
                      <span
                        className="block h-full rounded-full"
                        style={{ width: `${catMax > 0 ? (cat.cost / catMax) * 100 : 0}%`, background: 'var(--primary)' }}
                      />
                    </div>
                    <strong className="w-16 shrink-0 text-right font-mono text-[11px] tabular-nums text-foreground">{formatUsd(cat.cost)}</strong>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="border-t border-border pt-2 text-[11px] text-muted-foreground">No per-category breakdown for this pull request.</p>
          )}
        </div>
      )}
    </div>
  )
}

/** Bento summary: the hero card carries the salient number (attributed spend)
 * with its supporting details, flanked by two compact MetricCards for the
 * pull-request and session counts. */
function HeroMini({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 min-w-0 text-[12.5px]">{children}</div>
    </div>
  )
}

function SummaryBento({ payload }: { payload: PullRequestsPayload }) {
  const { attributedCost } = useMemo(() => summarizePullRequests(payload.rows), [payload])
  const top = payload.rows[0]
  const coveragePct = payload.distinctCost > 0
    ? Math.min(100, Math.max(0, Math.round((attributedCost / payload.distinctCost) * 100)))
    : null

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <Card className="flex flex-col gap-0 rounded-lg border border-border bg-card px-4 py-3 shadow-[var(--card-shadow)] ring-0 [--card-spacing:0px] sm:col-span-2">
        <div className="grid flex-1 grid-cols-2 content-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <div className="truncate text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Attributed spend</div>
            <div className="mt-2 truncate font-mono text-3xl font-semibold tracking-tight tabular-nums text-primary">
              {formatUsd(attributedCost)}
            </div>
          </div>
          {coveragePct !== null ? (
            <HeroMini label="Coverage">
              <span className="block truncate">
                <span className="font-mono text-2xl font-semibold tabular-nums text-foreground">
                  {coveragePct.toLocaleString('en-US')}%
                </span>{' '}
                <span className="text-muted-foreground">of linked spend</span>
              </span>
              <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-background" aria-hidden="true">
                <span className="block h-full rounded-full" style={{ width: `${coveragePct}%`, background: 'var(--primary)' }} />
              </span>
            </HeroMini>
          ) : (
            <HeroMini label="Coverage">
              <span className="block truncate">
                <span className="font-mono text-2xl font-semibold tabular-nums text-foreground">—</span>{' '}
                <span className="text-muted-foreground">of linked spend</span>
              </span>
              <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-background" aria-hidden="true">
                <span className="block h-full rounded-full" style={{ width: '0%', background: 'var(--primary)' }} />
              </span>
            </HeroMini>
          )}
          {top ? (
            <HeroMini label="Top PR by spend">
              <span className="flex min-w-0 items-center gap-1.5">
                <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <a
                  className="truncate font-medium text-foreground hover:text-primary hover:underline"
                  href={top.url}
                  title={top.url}
                  onClick={event => openPr(event, top.url)}
                >
                  {top.label}
                </a>
                <strong className="shrink-0 font-mono tabular-nums text-foreground">{formatUsd(top.cost)}</strong>
              </span>
            </HeroMini>
          ) : (
            <HeroMini label="Top PR by spend">
              <span className="block truncate text-muted-foreground">—</span>
            </HeroMini>
          )}
          <HeroMini label="Unattributed">
            <strong className="block truncate font-mono tabular-nums text-foreground">{formatUsd(payload.unattributedCost)}</strong>
          </HeroMini>
        </div>
      </Card>
      <div className="grid grid-cols-2 gap-3 sm:col-span-1 sm:grid-cols-1">
        <MetricCard
          label="Pull requests"
          value={payload.rows.length.toLocaleString('en-US')}
          sub={payloadSpan(payload.rows)}
          subInline
        />
        <MetricCard
          label="Linked sessions"
          value={payload.distinctSessions.toLocaleString('en-US')}
          sub={payload.rows.length > 0 ? `Avg ${(payload.distinctSessions / payload.rows.length).toFixed(1)} per PR` : undefined}
          subInline
        />
      </div>
    </div>
  )
}

export function PullRequestsView(): React.JSX.Element {
  const scope = useScopeStore(useShallow(selectScope))
  const payload = usePullRequestsStore(s => s.data)
  const error = usePullRequestsStore(s => s.error)
  const load = usePullRequestsStore(s => s.load)
  const provider = useScopeStore(s => s.provider)
  const setProvider = useScopeStore(s => s.setProvider)
  const detectedProviders = useScanStore(s => s.detectedProviders)
  const [expandedUrl, setExpandedUrl] = useState<string | null>(null)

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
          <LoadingRegion label="Loading pull requests…" className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-border bg-card p-4 sm:col-span-2">
                <div className="grid grid-cols-2 gap-x-4 gap-y-4">
                  <div>
                    <Skeleton className="h-3 w-28" />
                    <Skeleton className="mt-2 h-8 w-32" />
                  </div>
                  <div>
                    <Skeleton className="h-3 w-20" />
                    <Skeleton className="mt-2 h-6 w-24" />
                    <Skeleton className="mt-1.5 h-1.5 w-full rounded-full" />
                  </div>
                  <div>
                    <Skeleton className="h-3 w-24" />
                    <Skeleton className="mt-2 h-6 w-20" />
                  </div>
                  <div>
                    <Skeleton className="h-3 w-24" />
                    <Skeleton className="mt-1 h-3.5 w-full" />
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:col-span-1 sm:grid-cols-1">
                <SkeletonMetricCard />
                <SkeletonMetricCard />
              </div>
            </div>
            <SkeletonCard title>
              <div className="mt-1 pt-2">
                <Skeleton className="h-3.5 w-48" />
              </div>
              <SkeletonRows rows={5} className="mt-1 px-3.5" />
            </SkeletonCard>
          </LoadingRegion>
        )
      ) : payload.rows.length === 0 ? (
        <Panel title="Pull request spend">
          <p className="py-3 text-center text-[11.5px] text-muted-foreground">
            PR links are captured as sessions are parsed. Once a session references a pull request, it appears here.
          </p>
        </Panel>
      ) : (
        <>
          <SummaryBento payload={payload} />
          <Panel title="Pull request spend">
            <div className="flex items-center justify-between">
              <div className="text-[11.5px]">
                <strong className="text-foreground">Attributed pull requests</strong>
                <span className="ml-1.5 text-muted-foreground">Sorted by spend, highest first</span>
              </div>
              <span className="font-mono text-[11px] text-muted-foreground">{payload.rows.length.toLocaleString('en-US')} total</span>
            </div>

          <div className="mt-1" aria-label="Spend by pull request">
            {payload.rows.map(pr => (
              <PrRowView
                key={pr.url}
                pr={pr}
                expanded={expandedUrl === pr.url}
                onToggle={() => setExpandedUrl(current => current === pr.url ? null : pr.url)}
              />
            ))}
          </div>

            <p className="mt-2.5 border-t border-border pt-2 text-[10.5px] leading-relaxed text-muted-foreground">
              Costs are attributed turn by turn, so every row adds up without double counting.
              {payload.subagentSessions > 0 && ` ${payload.subagentSessions.toLocaleString('en-US')} subagent ${payload.subagentSessions === 1 ? 'run is' : 'runs are'} included in the PR where the work happened.`}
            </p>
            {payload.unattributedCost > 0 && (
              <p className="mt-1 text-[10.5px] text-muted-foreground">Not tied to a specific PR: {formatUsd(payload.unattributedCost)}</p>
            )}
          </Panel>
        </>
      )}
    </div>
  )
}
