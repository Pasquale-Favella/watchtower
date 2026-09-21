import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { navigateToSession } from '@/app/navigation'
import { useScanStore } from '@/app/stores/scan-store'
import { selectScope, useScopeStore } from '@/app/stores/scope-store'
import type { SessionRow } from '@/features/sessions/drilldown'
import {
  filterSessions,
  groupSessionsByProvider,
  paginateSessions,
  SESSIONS_PAGE_SIZE,
  type SessionSort,
  sortSessions,
  summarizeSessions,
  visiblePageNumbers,
} from '@/features/sessions/sessions-lib'
import { useSessionsStore } from '@/features/sessions/store'
import { ErrorPanel } from '@/shared/components/ErrorPanel'
import { type SegOption, SegTabs } from '@/shared/components/SegTabs'
import { LoadingRegion, SkeletonRows } from '@/shared/components/skeletons'
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/shared/components/ui/pagination'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { formatUsd } from '@/shared/lib/models'
import { motionClass } from '@/shared/lib/motion'
import { providerOptionsFromDetected } from '@/shared/lib/shell'
import { cn } from '@/shared/lib/utils'

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
    <div
      className={cn(
        'text-muted-foreground grid items-center gap-3 px-3 pt-2 pb-1 text-[10px] font-medium tracking-wide uppercase',
        COLUMNS,
      )}
    >
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

interface SessionListRowProps {
  row: SessionRow
  onOpen: (sessionId: string) => void
}

function SessionListRow({ row, onOpen }: SessionListRowProps): React.JSX.Element {
  const provenance = row.modelProvenance ?? {}
  const merged = row.models.filter(model => provenance[model]?.length)
  return (
    <button
      type="button"
      onClick={() => onOpen(row.sessionId)}
      className={cn(
        'border-border hover:bg-accent grid w-full items-center gap-3 border-t px-3 py-1.5 text-left transition-colors',
        COLUMNS,
      )}
    >
      <span className="min-w-0">
        <span className="text-foreground block truncate text-[12.5px] font-medium">
          {row.title || row.project || 'Untitled session'}
        </span>
        <span className="text-muted-foreground block truncate font-mono text-[10px]">
          {row.project} · {row.sessionId}
        </span>
      </span>
      <span className="text-muted-foreground truncate text-[11px]">{row.provider}</span>
      <span className="min-w-0">
        <span className="text-muted-foreground block truncate text-[11px]">{row.models.join(', ') || '—'}</span>
        {merged.length > 0 && (
          <span
            className="text-muted-foreground block truncate text-[10px]"
            title={merged.map(model => `${model}: ${(provenance[model] ?? []).join(', ')}`).join(' · ')}
          >
            includes {merged.map(model => (provenance[model] ?? []).join(', ')).join(', ')}
          </span>
        )}
      </span>
      <span className="text-muted-foreground truncate text-[11px]">{formatDate(row.endedAt)}</span>
      <span className="text-muted-foreground text-right font-mono text-[11px] tabular-nums">
        {row.turns.toLocaleString('en-US')}
      </span>
      <span className="text-foreground text-right font-mono text-[11.5px] tabular-nums">{formatUsd(row.cost)}</span>
      <span className="text-muted-foreground text-right font-mono text-[11px] tabular-nums">
        {formatCompact(row.inputTokens + row.outputTokens)}
      </span>
    </button>
  )
}

interface SessionsPagerProps {
  page: number
  pageCount: number
  total: number
  rangeStart: number
  rangeEnd: number
  onChange: (page: number) => void
}

interface PageNumberLinkProps {
  page: number
  isActive: boolean
  onChange: (page: number) => void
}

function PageNumberLink({ page, isActive, onChange }: PageNumberLinkProps): React.JSX.Element {
  return (
    <PaginationLink
      href="#"
      isActive={isActive}
      aria-label={`Go to page ${page + 1}`}
      onClick={event => {
        event.preventDefault()
        onChange(page)
      }}
    >
      {page + 1}
    </PaginationLink>
  )
}

/** The shadcn pager for the Sessions list: previous/next plus numbered slots
 * with ellipsis gaps, over the `paginateSessions` window. Links drive local
 * page state (no navigation), so every click cancels the anchor default. */
function SessionsPager({
  page,
  pageCount,
  total,
  rangeStart,
  rangeEnd,
  onChange,
}: SessionsPagerProps): React.JSX.Element {
  const firstPage = page === 0
  const lastPage = page >= pageCount - 1
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-[11px]" aria-live="polite">
        Showing {rangeStart}–{rangeEnd} of {total}
      </p>
      <Pagination>
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              href="#"
              aria-disabled={firstPage}
              tabIndex={firstPage ? -1 : undefined}
              className={firstPage ? 'pointer-events-none opacity-50' : undefined}
              onClick={event => {
                event.preventDefault()
                onChange(page - 1)
              }}
            />
          </PaginationItem>
          {visiblePageNumbers(pageCount, page).map((entry, index) => (
            <PaginationItem key={entry === 'ellipsis' ? `ellipsis-${index}` : `page-${entry}`}>
              {entry === 'ellipsis' ? (
                <PaginationEllipsis />
              ) : (
                <PageNumberLink page={entry} isActive={entry === page} onChange={onChange} />
              )}
            </PaginationItem>
          ))}
          <PaginationItem>
            <PaginationNext
              href="#"
              aria-disabled={lastPage}
              tabIndex={lastPage ? -1 : undefined}
              className={lastPage ? 'pointer-events-none opacity-50' : undefined}
              onClick={event => {
                event.preventDefault()
                onChange(page + 1)
              }}
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  )
}

export function SessionsView(): React.JSX.Element {
  const scope = useScopeStore(useShallow(selectScope))
  const rows = useSessionsStore(s => s.data)
  const error = useSessionsStore(s => s.error)
  const load = useSessionsStore(s => s.load)
  const provider = useScopeStore(s => s.provider)
  const setProvider = useScopeStore(s => s.setProvider)
  const detectedProviders = useScanStore(s => s.detectedProviders)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SessionSort>('cost')
  const [grouped, setGrouped] = useState(true)
  const [page, setPage] = useState(0)

  useEffect(() => {
    void load(scope)
  }, [load, scope])

  // A new search/sort/grouping restarts at the first page (reset alongside
  // the state change, not in an effect, so no cascading render); scope
  // reloads clamp through `paginateSessions` so a background refresh keeps
  // the page.
  function handleQueryChange(value: string): void {
    setQuery(value)
    setPage(0)
  }

  function handleSortChange(value: string): void {
    setSort(value as SessionSort)
    setPage(0)
  }

  function handleGroupedToggle(): void {
    setGrouped(v => !v)
    setPage(0)
  }

  const filtered = useMemo(() => filterSessions(rows ?? [], query), [rows, query])
  const summary = useMemo(() => summarizeSessions(filtered), [filtered])
  // Paginate the globally sorted rows, then group the page slice: at most one
  // page (100 rows) ever mounts, while search/sort/summary stay global over
  // the range-bounded scoped set (#139).
  const sorted = useMemo(() => sortSessions(filtered, sort), [filtered, sort])
  const { page: safePage, pageCount, pageRows } = useMemo(() => paginateSessions(sorted, page), [sorted, page])
  const groups = useMemo(() => (grouped ? groupSessionsByProvider(pageRows, sort) : []), [pageRows, sort, grouped])
  const flat = useMemo(() => (grouped ? [] : pageRows), [grouped, pageRows])
  const providerOptions = useMemo(() => providerOptionsFromDetected(detectedProviders), [detectedProviders])
  const rangeStart = sorted.length === 0 ? 0 : safePage * SESSIONS_PAGE_SIZE + 1
  const rangeEnd = safePage * SESSIONS_PAGE_SIZE + pageRows.length

  function renderBody(): React.JSX.Element {
    if (rows === null) {
      if (error) return <ErrorPanel message={error} />
      return (
        <LoadingRegion label="Loading sessions…" className="border-border bg-card overflow-hidden rounded-lg border">
          <div className="border-border flex flex-wrap items-center gap-2.5 border-b px-3.5 py-3">
            <Skeleton className="h-[25px] w-full max-w-xs rounded-md" />
            <Skeleton className="h-[25px] w-44 rounded-md" />
            <Skeleton className="h-[25px] w-28 rounded-md" />
          </div>
          <SkeletonRows rows={8} className="px-3.5" />
        </LoadingRegion>
      )
    }
    if (rows.length === 0) {
      return (
        <div className="border-border bg-card text-muted-foreground rounded-lg border px-3.5 py-6 text-[12px]">
          No sessions in this range yet.
        </div>
      )
    }
    if (filtered.length === 0) {
      return (
        <div className="border-border bg-card rounded-lg border px-3.5 py-6 text-center">
          <p className="text-muted-foreground text-[12px]">No sessions match “{query}”.</p>
          <button
            type="button"
            onClick={() => handleQueryChange('')}
            className="text-brand-text mt-2 text-[11px] font-medium hover:underline"
          >
            Clear search
          </button>
        </div>
      )
    }
    return (
      <>
        <div className="border-border bg-card overflow-hidden rounded-lg border">
          <ColumnHeaders />
          {grouped
            ? groups.map(group => (
                <div key={group.provider}>
                  <div className="border-border bg-muted/30 text-muted-foreground flex items-center gap-2 border-t px-3 py-1 text-[11px]">
                    <span className="text-foreground font-medium">{titleCase(group.provider)}</span>
                    <span>
                      {group.count} {group.count === 1 ? 'session' : 'sessions'}
                    </span>
                    <span className="ml-auto font-mono tabular-nums">{formatUsd(group.cost)}</span>
                  </div>
                  {group.rows.map(row => (
                    <SessionListRow key={row.sessionId} row={row} onOpen={navigateToSession} />
                  ))}
                </div>
              ))
            : flat.map(row => <SessionListRow key={row.sessionId} row={row} onOpen={navigateToSession} />)}
        </div>
        {pageCount > 1 && (
          <SessionsPager
            page={safePage}
            pageCount={pageCount}
            total={sorted.length}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            onChange={setPage}
          />
        )}
      </>
    )
  }

  function renderControls(): React.JSX.Element | null {
    if (rows === null || rows.length === 0) return null
    return (
      <>
        <div className="flex flex-wrap items-center gap-2.5">
          <input
            aria-label="Search sessions"
            placeholder="Search project, model, or id…"
            value={query}
            onChange={e => handleQueryChange(e.target.value)}
            className="border-border bg-card text-foreground placeholder:text-muted-foreground focus:border-brand h-[25px] w-full max-w-xs rounded-md border px-2 text-[11px] outline-none"
          />
          <SegTabs options={SORT_OPTIONS} value={sort} onChange={handleSortChange} />
          <button
            type="button"
            aria-pressed={grouped}
            onClick={handleGroupedToggle}
            className={cn(
              'rounded-md border px-2.5 py-[3px] text-[11px] transition-colors',
              grouped
                ? 'border-brand bg-card text-foreground font-medium'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            Group by provider
          </button>
        </div>

        <div className="text-muted-foreground text-[11px]">
          {summary.count.toLocaleString('en-US')} {summary.count === 1 ? 'session' : 'sessions'} ·{' '}
          {formatUsd(summary.costUSD)} · {formatCompact(summary.tokens)} tokens
        </div>
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

      {renderControls()}
      {renderBody()}
    </div>
  )
}
