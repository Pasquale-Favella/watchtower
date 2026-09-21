import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { navigateToSession } from '@/app/navigation'
import { useScanStore } from '@/app/stores/scan-store'
import { selectScope, useScopeStore } from '@/app/stores/scope-store'
import type { SessionRow } from '@/features/sessions/drilldown'
import {
  flattenSessionListItems,
  groupSessionsByProvider,
  SESSION_HEADER_HEIGHT,
  SESSION_ROW_HEIGHT,
  type SessionListItem,
  sessionListItemHeight,
  type SessionSort,
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

import { SESSIONS_PAGE_SIZE } from '../../../../shared/lib/sessions-query.js'

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

/** The dashboard layout's scroll region (#141 item 3): section content scrolls
 * in this nested `overflow-y-auto` strip, not the window — so the Sessions
 * virtualizer observes this element, not `window`. */
function getSectionScrollElement(): Element | null {
  return document.querySelector('[data-section-scroll]')
}

interface SessionListRowProps {
  row: SessionRow
  onOpen: (sessionId: string) => void
}

// Row heights are fixed (`SESSION_ROW_HEIGHT`) so virtual positions are exact:
// content truncates inside the box and never grows it. The inline height is
// the single source of truth shared with the virtualizer estimates.
function SessionListRow({ row, onOpen }: SessionListRowProps): React.JSX.Element {
  const provenance = row.modelProvenance ?? {}
  const merged = row.models.filter(model => provenance[model]?.length)
  return (
    <button
      type="button"
      onClick={() => onOpen(row.sessionId)}
      style={{ height: SESSION_ROW_HEIGHT }}
      className={cn(
        'border-border hover:bg-accent grid w-full items-center gap-3 overflow-hidden border-t px-3 py-1.5 text-left transition-colors',
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

interface SessionGroupHeaderProps {
  provider: string
  count: number
  cost: number
}

function SessionGroupHeader({ provider, count, cost }: SessionGroupHeaderProps): React.JSX.Element {
  return (
    <div
      style={{ height: SESSION_HEADER_HEIGHT }}
      className="border-border bg-muted/30 text-muted-foreground flex items-center gap-2 border-t px-3 py-1 text-[11px]"
    >
      <span className="text-foreground font-medium">{titleCase(provider)}</span>
      <span>
        {count} {count === 1 ? 'session' : 'sessions'}
      </span>
      <span className="ml-auto font-mono tabular-nums">{formatUsd(cost)}</span>
    </div>
  )
}

interface SessionListItemViewProps {
  item: SessionListItem
}

/** One mounted virtual list entry: a group header or a session row. */
function SessionListItemView({ item }: SessionListItemViewProps): React.JSX.Element {
  if (item.kind === 'header') {
    return <SessionGroupHeader provider={item.provider} count={item.count} cost={item.cost} />
  }
  return <SessionListRow row={item.row} onOpen={navigateToSession} />
}

/** The virtualized Sessions row list (#139 scope 4, #141 item 3): only the
 * visible window (+ overscan) mounts, so a full page never mounts every row.
 * Group headers stay in-flow items above their rows. Every item has a fixed
 * height (`sessionListItemHeight`), so positions are exact with no measuring:
 * rows can never overlap or drift. */
interface VirtualSessionListProps {
  items: SessionListItem[]
}

function VirtualSessionList({ items }: VirtualSessionListProps): React.JSX.Element {
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: getSectionScrollElement,
    estimateSize: index => {
      const item = items[index]
      return item === undefined ? SESSION_ROW_HEIGHT : sessionListItemHeight(item)
    },
    overscan: 8,
    getItemKey: index => items[index]?.key ?? index,
  })
  return (
    <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative', width: '100%' }}>
      {virtualizer.getVirtualItems().map(virtualRow => {
        const item = items[virtualRow.index]
        if (item === undefined) return null
        return (
          <div
            key={virtualRow.key}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
            <SessionListItemView item={item} />
          </div>
        )
      })}
    </div>
  )
}

interface SessionsPagerProps {
  page: number
  pageCount: number
  total: number
  rangeStart: number
  rangeEnd: number
  onGoto: (page: number) => void
  onNext: () => void
  onPrev: () => void
}

interface PageNumberLinkProps {
  page: number
  isActive: boolean
  onGoto: (page: number) => void
}

function PageNumberLink({ page, isActive, onGoto }: PageNumberLinkProps): React.JSX.Element {
  return (
    <PaginationLink
      href="#"
      isActive={isActive}
      aria-label={`Go to page ${page + 1}`}
      onClick={event => {
        event.preventDefault()
        onGoto(page)
      }}
    >
      {page + 1}
    </PaginationLink>
  )
}

/** The shadcn pager for the Sessions list: previous/next plus numbered slots
 * with ellipsis gaps. Numbered slots jump by offset; previous/next walk the
 * server's keyset cursors, so a background refresh cannot shift the window
 * mid-walk. Links drive page state (no navigation), so every click cancels
 * the anchor default. */
function SessionsPager({
  page,
  pageCount,
  total,
  rangeStart,
  rangeEnd,
  onGoto,
  onNext,
  onPrev,
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
                onPrev()
              }}
            />
          </PaginationItem>
          {visiblePageNumbers(pageCount, page).map((entry, index) => (
            <PaginationItem key={entry === 'ellipsis' ? `ellipsis-${index}` : `page-${entry}`}>
              {entry === 'ellipsis' ? (
                <PaginationEllipsis />
              ) : (
                <PageNumberLink page={entry} isActive={entry === page} onGoto={onGoto} />
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
                onNext()
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
  const data = useSessionsStore(s => s.data)
  const error = useSessionsStore(s => s.error)
  const page = useSessionsStore(s => s.page)
  const gotoPage = useSessionsStore(s => s.gotoPage)
  const nextPage = useSessionsStore(s => s.nextPage)
  const prevPage = useSessionsStore(s => s.prevPage)
  const provider = useScopeStore(s => s.provider)
  const setProvider = useScopeStore(s => s.setProvider)
  const detectedProviders = useScanStore(s => s.detectedProviders)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SessionSort>('cost')
  const [grouped, setGrouped] = useState(true)

  // Search/sort/scope fetch server-side (#141 item 2): a new triple always
  // restarts at the first page (reset alongside the state change, not in an
  // effect, so no cascading render). Background refreshes keep the page via
  // the store's reload (the server clamps a shrunken range to the last page).
  useEffect(() => {
    void gotoPage(scope, { query, sort }, 0)
  }, [gotoPage, scope, query, sort])

  // Group the fetched page slice: at most one page (100 rows) ever arrives
  // over IPC, while search/sort/summary stay global over the range-bounded
  // scoped set on the server (#139).
  const pageRows = useMemo(() => data?.rows ?? [], [data])
  const total = data?.total ?? 0
  const summary = useMemo(
    () => data?.summary ?? { count: 0, costUSD: 0, tokens: 0 },
    [data],
  )
  const start = data?.start ?? 0
  const pageCount = Math.max(1, Math.ceil(total / SESSIONS_PAGE_SIZE))
  const groups = useMemo(() => (grouped ? groupSessionsByProvider(pageRows, sort) : []), [pageRows, sort, grouped])
  const ungrouped = useMemo(() => (grouped ? [] : pageRows), [grouped, pageRows])
  const items = useMemo(
    () => flattenSessionListItems(groups, ungrouped, grouped),
    [groups, ungrouped, grouped],
  )
  const providerOptions = useMemo(() => providerOptionsFromDetected(detectedProviders), [detectedProviders])
  const rangeStart = total === 0 ? 0 : start + 1
  const rangeEnd = start + pageRows.length

  function handleGoto(target: number): void {
    void gotoPage(scope, { query, sort }, target)
  }

  function handleNext(): void {
    void nextPage(scope, { query, sort })
  }

  function handlePrev(): void {
    void prevPage(scope, { query, sort })
  }

  function renderBody(): React.JSX.Element {
    if (data === null) {
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
    if (total === 0 && query.trim() === '') {
      return (
        <div className="border-border bg-card text-muted-foreground rounded-lg border px-3.5 py-6 text-[12px]">
          No sessions in this range yet.
        </div>
      )
    }
    if (total === 0) {
      return (
        <div className="border-border bg-card rounded-lg border px-3.5 py-6 text-center">
          <p className="text-muted-foreground text-[12px]">No sessions match “{query}”.</p>
          <button
            type="button"
            onClick={() => setQuery('')}
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
          <VirtualSessionList items={items} />
        </div>
        {pageCount > 1 && (
          <SessionsPager
            page={page}
            pageCount={pageCount}
            total={total}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            onGoto={handleGoto}
            onNext={handleNext}
            onPrev={handlePrev}
          />
        )}
      </>
    )
  }

  // Controls stay mounted while a search is active even when it matches
  // nothing — otherwise the input vanishes with the results and the search
  // can no longer be cleared. Only a genuinely empty scope hides them.
  const hasActiveSearch = query.trim() !== ''
  function renderControls(): React.JSX.Element | null {
    if (data === null || (total === 0 && !hasActiveSearch)) return null
    return (
      <>
        <div className="flex flex-wrap items-center gap-2.5">
          <input
            aria-label="Search sessions"
            placeholder="Search project, model, or id…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="border-border bg-card text-foreground placeholder:text-muted-foreground focus:border-brand h-[25px] w-full max-w-xs rounded-md border px-2 text-[11px] outline-none"
          />
          <SegTabs options={SORT_OPTIONS} value={sort} onChange={value => setSort(value as SessionSort)} />
          <button
            type="button"
            aria-pressed={grouped}
            onClick={() => setGrouped(v => !v)}
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
