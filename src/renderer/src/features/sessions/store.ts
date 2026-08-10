import { create } from 'zustand'
import { fetchSession, fetchSessionRows } from '@/shared/lib/api'
import { scopedDataSlice, type DataStatus, type ScopedDataSlice } from '../../app/stores/data-store'
import { subscribeToRefresh } from '../../app/stores/scan-store'
import type { SessionDetail, SessionRow } from '../../../../shared/schemas/views.js'

/** The sessions list, scope-keyed like the other section payloads. */
export interface SessionsState extends ScopedDataSlice<SessionRow[]> {
  /** The open session's detail — keyed by id, not scope. (ADR 0011:
   * "sessions (+open-session detail)" live in the same section store.) */
  session: SessionDetail | null
  sessionError: string | null
  sessionStatus: DataStatus
  loadSession: (sessionId: string) => Promise<void>
  clearSession: () => void
}

export const useSessionsStore = create<SessionsState>()((set, get) => ({
  ...scopedDataSlice<SessionRow[]>(fetchSessionRows, patch => set(patch), () => get()),
  session: null,
  sessionError: null,
  sessionStatus: 'idle',
  loadSession: async (sessionId) => {
    set({ session: null, sessionError: null, sessionStatus: 'loading' })
    const result = await fetchSession(sessionId)
    if (result.ok) set({ session: result.data, sessionStatus: 'ready' })
    else set({ sessionError: result.error, sessionStatus: 'ready' })
  },
  clearSession: () => set({ session: null, sessionError: null, sessionStatus: 'idle' }),
}))

subscribeToRefresh(() => { void useSessionsStore.getState().reload() })
