import { create } from 'zustand'

import { fetchSession, fetchSessionPage } from '@/shared/lib/api'

import { SESSIONS_PAGE_SIZE } from '../../../../shared/lib/sessions-query.js'
import type { OverviewScope } from '../../../../shared/schemas/overview.js'
import type { SessionSort } from '../../../../shared/schemas/renderer.js'
import type { SessionDetail, SessionPageResult } from '../../../../shared/schemas/views.js'
import { type DataStatus, EMPTY_SCOPE, keyOfScope } from '../../app/stores/data-store'
import { subscribeToRefresh } from '../../app/stores/scan-store'

/** What the Sessions list shows: one server-computed page plus the filtered
 * totals the summary line and the pager render from (#139 scope 3, #141
 * item 2). Search, sort, and slicing run in the main process over its
 * SQL-bounded set — the renderer never holds the full scoped set. */

export interface SessionsPageRequest {
  query: string
  sort: SessionSort
}

export interface SessionsState {
  data: SessionPageResult | null
  error: string | null
  status: DataStatus
  /** The scope the current page belongs to. */
  scope: OverviewScope
  /** Full request identity (scope + query + sort + page/cursor) — the SWR
   * guard that drops out-of-order responses. */
  dataKey: string
  /** Scope + query + sort identity: a change resets the cursor trail. */
  tripleKey: string
  query: string
  sort: SessionSort
  /** Current zero-based page (derived from the server's echoed start, so a
   * server-side clamp is reflected instead of stranding the pager). */
  page: number
  /** Start-cursor per visited page index: `trail[0]` is always null (the
   * first page starts at the beginning). Unknown slots fall back to offsets. */
  trail: Array<string | null | undefined>
  /** Numbered/random-access navigation (the pager slots). */
  gotoPage: (scope: OverviewScope, req: SessionsPageRequest, page: number) => Promise<void>
  /** Stable forward step via keyset cursor (immune to background refresh). */
  nextPage: (scope: OverviewScope, req: SessionsPageRequest) => Promise<void>
  /** Stable back step via the cursor trail (offset fallback when unknown). */
  prevPage: (scope: OverviewScope, req: SessionsPageRequest) => Promise<void>
  reload: () => Promise<void>
  clear: () => void
  /** The open session's detail — keyed by id, not scope. (ADR 0011:
   * "sessions (+open-session detail)" live in the same section store.) */
  session: SessionDetail | null
  sessionError: string | null
  sessionStatus: DataStatus
  loadSession: (sessionId: string) => Promise<void>
  clearSession: () => void
}

export const useSessionsStore = create<SessionsState>()((set, get) => {
  async function fetchInto(
    scope: OverviewScope,
    req: SessionsPageRequest,
    request: { limit: number; offset?: number; cursor?: string },
    trailCursor?: string,
  ): Promise<void> {
    const dataKey = JSON.stringify(['sessions-page', keyOfScope(scope), req.query, req.sort, request])
    if (get().dataKey !== dataKey) {
      set({ error: null, status: 'loading', scope, query: req.query, sort: req.sort, dataKey })
    }
    const result = await fetchSessionPage(scope, {
      query: req.query,
      sort: req.sort,
      limit: request.limit,
      offset: request.offset,
      cursor: request.cursor ?? null,
    })
    if (get().dataKey !== dataKey) return
    if (result.ok) {
      const data = result.data
      // The page always derives from the server's echoed start, so a
      // server-side clamp is reflected instead of stranding the pager.
      const page = Math.floor(data.start / request.limit)
      const tripleKey = JSON.stringify([keyOfScope(scope), req.query, req.sort])
      const trail = get().tripleKey === tripleKey ? [...get().trail] : [null]
      if (trailCursor !== undefined) trail[page] = trailCursor
      set({ data, error: null, status: 'ready', page, tripleKey, trail })
    } else {
      set({ error: result.error, status: 'ready' })
    }
  }

  return {
    data: null,
    error: null,
    status: 'idle',
    scope: EMPTY_SCOPE,
    dataKey: '',
    tripleKey: '',
    query: '',
    sort: 'cost',
    page: 0,
    trail: [],
    gotoPage: async (scope, req, page) => {
      // Same-triple jumps keep the cursor trail (recorded positions stay
      // valid); a triple change resets it on success inside fetchInto.
      await fetchInto(scope, req, { limit: SESSIONS_PAGE_SIZE, offset: page * SESSIONS_PAGE_SIZE })
    },
    nextPage: async (scope, req) => {
      const { data, page, trail } = get()
      if (!data) return
      const cursor = trail[page + 1] ?? data.nextCursor
      if (cursor == null) return
      await fetchInto(scope, req, { limit: SESSIONS_PAGE_SIZE, cursor }, cursor)
    },
    prevPage: async (scope, req) => {
      const { page, trail } = get()
      if (page <= 0) return
      const target = page - 1
      // A recorded start-cursor encodes the row before the target page's
      // first row, so it re-addresses the page exactly (stable under
      // refresh); unknown slots fall back to offset random access.
      const cursor = trail[target]
      const request =
        cursor == null
          ? { limit: SESSIONS_PAGE_SIZE, offset: target * SESSIONS_PAGE_SIZE }
          : { limit: SESSIONS_PAGE_SIZE, cursor }
      await fetchInto(scope, req, request)
    },
    reload: async () => {
      const { scope, query, sort, page } = get()
      if (get().dataKey === '') return
      await get().gotoPage(scope, { query, sort }, page)
    },
    clear: () => {
      set({
        data: null,
        error: null,
        status: 'idle',
        scope: EMPTY_SCOPE,
        dataKey: '',
        tripleKey: '',
        query: '',
        sort: 'cost',
        page: 0,
        trail: [],
      })
    },
    session: null,
    sessionError: null,
    sessionStatus: 'idle',
    loadSession: async sessionId => {
      set({ session: null, sessionError: null, sessionStatus: 'loading' })
      const result = await fetchSession(sessionId)
      if (result.ok) set({ session: result.data, sessionStatus: 'ready' })
      else set({ sessionError: result.error, sessionStatus: 'ready' })
    },
    clearSession: () => set({ session: null, sessionError: null, sessionStatus: 'idle' }),
  }
})

subscribeToRefresh(() => { void useSessionsStore.getState().reload() })
