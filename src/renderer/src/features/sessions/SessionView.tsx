import { useEffect, useState } from 'react'
import { ArrowLeft, ChevronDown, GitBranch, Link2, Tag } from 'lucide-react'
import { useParams } from '@tanstack/react-router'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/shared/components/ui/card'
import { Button } from '@/shared/components/ui/button'
import { Badge } from '@/shared/components/ui/badge'
import { cn } from '@/shared/lib/utils'
import { formatUsd } from '@/shared/lib/models'
import { ErrorPanel } from '@/shared/components/ErrorPanel'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { LoadingRegion, SkeletonCard, SkeletonLines } from '@/shared/components/skeletons'
import { useSessionsStore } from '@/features/sessions/store'
import { navigateToSection } from '@/app/navigation'
import type { SessionDetail } from '@/features/sessions/drilldown'

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-medium">{value}</div>
    </div>
  )
}

function CallCard({ call }: { call: SessionDetail['turns'][number]['assistantCalls'][number] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-md border bg-muted/30">
      <button className="flex w-full items-center gap-2 px-3 py-2 text-left" onClick={() => setOpen(!open)}>
        <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', open && 'rotate-180')} />
        <span className="font-mono text-xs">{call.model}</span>
        <span className="text-xs text-muted-foreground">{call.provider}</span>
        {call.isEstimated && <Badge variant="secondary" className="text-[10px]">estimated</Badge>}
        {call.savingsUSD != null && <Badge variant="secondary" className="text-[10px]">saved {formatUsd(call.savingsUSD)}</Badge>}
        <span className="ml-auto text-xs font-medium">{formatUsd(call.costUSD)}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t px-3 py-2 text-xs">
          <div className="flex flex-wrap gap-3">
            <span>in {call.usage.inputTokens.toLocaleString()}</span>
            <span>out {call.usage.outputTokens.toLocaleString()}</span>
            {call.usage.reasoningTokens > 0 && <span>reasoning {call.usage.reasoningTokens.toLocaleString()}</span>}
            {call.usage.cacheReadInputTokens > 0 && <span>cache-read {call.usage.cacheReadInputTokens.toLocaleString()}</span>}
            {call.usage.cacheCreationInputTokens > 0 && <span>cache-write {call.usage.cacheCreationInputTokens.toLocaleString()}</span>}
          </div>
          {call.speed !== 'standard' && <div>speed: <Badge variant="outline">{call.speed}</Badge></div>}
          {call.hasPlanMode && <div>plan mode</div>}
          {call.tools.length > 0 && <div>tools: {call.tools.join(', ')}</div>}
          {call.mcpTools.length > 0 && <div>mcp: {call.mcpTools.join(', ')}</div>}
          {call.skills.length > 0 && <div>skills: {call.skills.join(', ')}</div>}
          {call.subagentTypes.length > 0 && <div>subagents: {call.subagentTypes.join(', ')}</div>}
        </div>
      )}
    </div>
  )
}

function Turn({ turn }: { turn: SessionDetail['turns'][number] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-md border bg-card">
      <button className="flex w-full items-start gap-3 px-3 py-2.5 text-left" onClick={() => setOpen(!open)}>
        <ChevronDown className={cn('mt-0.5 h-3.5 w-3.5 text-muted-foreground transition-transform', open && 'rotate-180')} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">{formatDate(turn.timestamp)}</span>
            <Badge variant="outline" className="text-[10px]">{turn.category}</Badge>
            {turn.gitBranch && (
              <Badge variant="outline" className="text-[10px]"><GitBranch className="mr-0.5 h-3 w-3" />{turn.gitBranch}</Badge>
            )}
            {turn.hasEdits && <Badge variant="outline" className="text-[10px]">edited</Badge>}
            {turn.retries > 0 && <Badge variant="destructive" className="text-[10px]">{turn.retries} retries</Badge>}
          </div>
          <p className="mt-1 line-clamp-2 text-sm">{turn.userMessage || '(no prompt)'}</p>
          {turn.prRefs.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {turn.prRefs.map((pr) => (
                <a key={pr} href={pr} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-xs text-brand-text hover:underline">
                  <Link2 className="h-3 w-3" />PR
                </a>
              ))}
            </div>
          )}
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">{turn.assistantCalls.length} call{turn.assistantCalls.length === 1 ? '' : 's'}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t px-3 py-2">
          {turn.assistantCalls.map((call, i) => <CallCard key={i} call={call} />)}
        </div>
      )}
    </div>
  )
}

export function SessionView(): React.JSX.Element {
  const { sessionId } = useParams({ strict: false })
  const session = useSessionsStore(s => s.session)
  const error = useSessionsStore(s => s.sessionError)
  const loadSession = useSessionsStore(s => s.loadSession)

  useEffect(() => {
    if (sessionId) void loadSession(sessionId)
  }, [sessionId, loadSession])

  // Owns its max-w-[1180px] column like every other section view (ADR 0014);
  // the router no longer wraps session detail in a width container. The
  // container always renders — error/loading/content all sit inside it.
  return (
    <div className="w-full max-w-[1180px] space-y-4">
      {error ? (
        <ErrorPanel message={error} />
      ) : !session ? (
        <LoadingRegion label="Loading session…" className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Skeleton className="h-7 w-16 rounded-md" />
            <div className="flex flex-col gap-1.5">
              <Skeleton className="h-4 w-64" />
              <Skeleton className="h-3 w-40" />
            </div>
          </div>
          <div className="grid grid-cols-4 gap-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="rounded-lg border bg-card p-3">
                <Skeleton className="h-3 w-14" />
                <Skeleton className="mt-1.5 h-4 w-20" />
              </div>
            ))}
          </div>
          <SkeletonCard title>
            <SkeletonLines lines={6} />
          </SkeletonCard>
        </LoadingRegion>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => navigateToSection('sessions')}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            <div>
              <h2 className="text-lg font-semibold">{session.title || session.sessionId}</h2>
              <p className="text-xs text-muted-foreground">
                {session.project} · {session.provider} · {formatDate(session.firstTimestamp)}
              </p>
            </div>
          </div>

          {session.prLinks.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {session.prLinks.map((pr) => (
                <a key={pr} href={pr} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-brand-text hover:bg-muted">
                  <Link2 className="h-3 w-3" />{pr.split('/').slice(-2).join('/')}
                </a>
              ))}
            </div>
          )}

          <div className="grid grid-cols-4 gap-3">
            <Stat label="Cost" value={formatUsd(session.totalCostUSD)} />
            <Stat label="Estimated" value={formatUsd(session.totalEstimatedCostUSD)} />
            <Stat label="Calls" value={String(session.apiCalls)} />
            <Stat label="Turns" value={String(session.turns.length)} />
            <Stat label="Input tokens" value={session.totalInputTokens.toLocaleString()} />
            <Stat label="Output tokens" value={session.totalOutputTokens.toLocaleString()} />
            <Stat label="Cache read" value={session.totalCacheReadTokens.toLocaleString()} />
            <Stat label="Cache write" value={session.totalCacheWriteTokens.toLocaleString()} />
          </div>

          {session.workingDirectory && (
            <Card>
              <CardHeader><CardTitle className="text-base"><Tag className="mr-1 inline h-4 w-4" />Working directory</CardTitle></CardHeader>
              <CardContent className="font-mono text-xs">{session.workingDirectory}</CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Timeline</CardTitle>
              <CardDescription>Tap a turn to expand its assistant calls</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {session.turns.map((turn, i) => <Turn key={i} turn={turn} />)}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}