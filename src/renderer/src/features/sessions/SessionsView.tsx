import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { cn } from '@/shared/lib/utils'
import { SegTabs, type SegOption } from '@/shared/components/SegTabs'
import { motionClass } from '@/shared/lib/motion'
import { providerOptionsFromDetected } from '@/shared/lib/shell'
import {
  filterSessions, sortSessions, groupSessionsByProvider, summarizeSessions,
  type SessionSort
} from '@/features/sessions/sessions-lib'
import { formatUsd } from '@/shared/lib/models'
import { ErrorPanel } from '@/shared/components/ErrorPanel'
import { useSessionsStore } from '@/features/sessions/store'
import { selectScope, useShellStore } from '@/app/stores/shell-store'
import { useScanStore } from '@/app/stores/scan-store'
import type { SessionRow } from '@/features/sessions/drilldown'

const SORT_OPTIONS: SegOption[] = [
  { value: 'cost', label: 'Cost' },
  { value: 'recent', label: 'Recent' },
  { value: 'turns', label: 'Turns' },
  { value: 'tokens', label: 'Tokens' },
]

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function formatDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function titleCase(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1)
}

const COLUMNS = 'grid-cols-[minmax(0,1.4fr)_88px_minmax(0,1fr)_136px_44px_76px_84px]'

function ColumnHeaders(): React.JSX.Element {
  return (
    <div className={cn('grid items-center gap-3 px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-mut2', COLUMNS)}>
      <span>Session</span>
      <span>Provider</span>
      <span>Models</span>
      <span>Ended</span>
      <span className="text-right">Turns</span>
      <span className="text-right">Cost</span>
      <span className="text-right">Tokens</span>
    </div>
  )
}

function SessionListRow({ row, onOpen }: { row: SessionRow; onOpen: (sessionId: string) => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onOpen(row.sessionId)}
      className={cn(
        'grid w-full items-center gap-3 border-t border-line2 px-3 py-1.5 text-left transition-colors hover:bg-hover',
        COLUMNS,
      )}
    >
      <span className="min-w-0">
        <span className="block truncate text-[12.5px] font-medium text-foreground">{row.title || row.project || 'Untitled session'}</span>
        <span className="block truncate font-mono text-[10px] text-mut2">{row.project} · {row.sessionId}</span>
      </span>
      <span className="truncate text-[11px] text-muted-foreground">{row.provider}</span>
      <span className="truncate text-[11px] text-muted-foreground">{row.models.join(', ') || '—'}</span>
      <span className="truncate text-[11px] text-muted-foreground">{formatDate(row.endedAt)}</span>
      <span className="text-right font-mono text-[11px] tabular-nums text-muted-foreground">{row.turns.toLocaleString('en-US')}</span>
      <span className="text-right font-mono text-[11.5px] tabular-nums text-foreground">{formatUsd(row.cost)}</span>
      <span className="text-right font-mono text-[11px] tabular-nums text-muted-foreground">{formatCompact(row.inputTokens + row.outputTokens)}</span>
    </button>
  )
}

export function SessionsView(): React.JSX.Element {
  const scope = useShellStore(useShallow(selectScope))
  const rows = useSessionsStore(s => s.data)
  const error = useSessionsStore(s => s.error)
  const load = useSessionsStore(s => s.load)
  const provider = useShellStore(s => s.provider)
  const setProvider = useShellStore(s => s.setProvider)
  const detectedProviders = useScanStore(s => s.detectedProviders)
  const openSessionById = useShellStore(s => s.openSessionById)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SessionSort>('cost')
  const [grouped, setGrouped] = useState(true)

  useEffect(() => {
    void load(scope)
  }, [load, scope])

  const filtered = useMemo(() => filterSessions(rows ?? [], query), [rows, query])
  const summary = useMemo(() => summarizeSessions(filtered), [filtered])
  const groups = useMemo(() => (grouped ? groupSessionsByProvider(filtered, sort) : []), [filtered, sort, grouped])
  const flat = useMemo(() => (grouped ? [] : sortSessions(filtered, sort)), [filtered, sort, grouped])
  const providerOptions = useMemo(() => providerOptionsFromDetected(detectedProviders), [detectedProviders])

  return (
    <div className={cn('w-full max-w-[1180px]', motionClass('flex flex-col gap-3', 'section-fade'))}>
      {providerOptions.length > 1 && (
        <div className="flex justify-center">
          <SegTabs options={providerOptions} value={provider} onChange={setProvider} />
        </div>
      )}

      {rows === null ? (
        error ? <ErrorPanel message={error} /> : (
          <div className="rounded-lg border border-border bg-card px-3.5 py-6 text-[12px] text-muted-foreground">Loading sessions…</div>
        )
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-card px-3.5 py-6 text-[12px] text-muted-foreground">No sessions in this range yet.</div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2.5">
            <input
              aria-label="Search sessions"
              placeholder="Search project, model, or id…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="h-[25px] w-full max-w-xs rounded-md border border-line2 bg-card px-2 text-[11px] text-foreground outline-none placeholder:text-mut2 focus:border-brand"
            />
            <SegTabs options={SORT_OPTIONS} value={sort} onChange={value => setSort(value as SessionSort)} />
            <button
              type="button"
              aria-pressed={grouped}
              onClick={() => setGrouped(v => !v)}
              className={cn(
                'rounded-md border px-2.5 py-[3px] text-[11px] transition-colors',
                grouped ? 'border-brand bg-card font-medium text-foreground' : 'border-line2 text-muted-foreground hover:text-foreground',
              )}
            >
              Group by provider
            </button>
          </div>

          <div className="text-[11px] text-mut2">
            {summary.count.toLocaleString('en-US')} {summary.count === 1 ? 'session' : 'sessions'} · {formatUsd(summary.costUSD)} · {formatCompact(summary.tokens)} tokens
          </div>

          {filtered.length === 0 ? (
            <div className="rounded-lg border border-border bg-card px-3.5 py-6 text-center">
              <p className="text-[12px] text-muted-foreground">No sessions match “{query}”.</p>
              <button type="button" onClick={() => setQuery('')} className="mt-2 text-[11px] font-medium text-brand-text hover:underline">
                Clear search
              </button>
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <ColumnHeaders />
              {grouped
                ? groups.map(group => (
                  <div key={group.provider}>
                    <div className="flex items-center gap-2 border-t border-border bg-muted/30 px-3 py-1 text-[11px] text-muted-foreground">
                      <span className="font-medium text-foreground">{titleCase(group.provider)}</span>
                      <span>{group.count} {group.count === 1 ? 'session' : 'sessions'}</span>
                      <span className="ml-auto font-mono tabular-nums">{formatUsd(group.cost)}</span>
                    </div>
                    {group.rows.map(row => <SessionListRow key={row.sessionId} row={row} onOpen={openSessionById} />)}
                  </div>
                ))
                : flat.map(row => <SessionListRow key={row.sessionId} row={row} onOpen={openSessionById} />)}
            </div>
          )}
        </>
      )}
    </div>
  )
}
