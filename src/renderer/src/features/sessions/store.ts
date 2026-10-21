import { create } from 'zustand'

import { fetchSession, fetchSessionRows } from '@/shared/lib/api'

import type { SessionDetail, SessionRow } from '../../../../shared/schemas/views.js'
import { type DataStatus, type ScopedDataSlice, scopedDataSlice } from '../../app/stores/data-store'
import { subscribeToRefresh } from '../../app/stores/scan-store'

/** Identity of an open-session request; the same id can exist in several sources. */
export function sessionRequestKey(sessionId: string, sourceId?: number): string {
  return JSON.stringify([sessionId, sourceId ?? null])
}

/** The sessions list, scope-keyed like the other section payloads. */
export interface SessionsState extends ScopedDataSlice<SessionRow[]> {
  /** The open session's detail — keyed by id, not scope. (ADR 0011:
   * "sessions (+open-session detail)" live in the same section store.) */
  session: SessionDetail | null
  sessionError: string | null
  sessionStatus: DataStatus
  sessionKey: string | null
  loadSession: (sessionId: string, sourceId?: number) => Promise<void>
  clearSession: () => void
}

export const useSessionsStore = create<SessionsState>()((set, get) => ({
  ...scopedDataSlice<SessionRow[]>(
    fetchSessionRows,
    patch => set(patch),
    () => get(),
  ),
  session: null,
  sessionError: null,
  sessionStatus: 'idle',
  sessionKey: null,
  loadSession: async (sessionId, sourceId) => {
    const sessionKey = sessionRequestKey(sessionId, sourceId)
    set({ session: null, sessionError: null, sessionStatus: 'loading', sessionKey })
    const result = await fetchSession(sessionId, sourceId)
    if (get().sessionKey !== sessionKey) return
    if (result.ok) set({ session: result.data, sessionStatus: 'ready' })
    else set({ sessionError: result.error, sessionStatus: 'ready' })
  },
  clearSession: () => set({ session: null, sessionError: null, sessionStatus: 'idle', sessionKey: null }),
}))

subscribeToRefresh(() => {
  void useSessionsStore.getState().reload()
})
