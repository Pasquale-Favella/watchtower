import { create } from 'zustand'
import type { ApiResult } from '@/shared/lib/api'
import type { OverviewScope } from '../../../../shared/schemas/overview.js'
import { subscribeToRefresh } from './scan-store'

export type DataStatus = 'idle' | 'loading' | 'ready'

/** A scope-keyed data slice (map ticket 02): one fetch wrapper, a single
 * current scope, and true stale-while-revalidate — refetching the SAME scope
 * keeps the last-known payload visible and replaces it on success (the
 * deliberate fix of today's Loading flash), while switching scope clears to a
 * fresh load. Out-of-order responses are dropped (the old `cancelled` guard,
 * now keyed instead of effect-tied). */
export interface ScopedDataSlice<T> {
  data: T | null
  error: string | null
  status: DataStatus
  /** The scope the current data/error belongs to. */
  scope: OverviewScope
  /** Stable key for the requested scope — the SWR identity. */
  dataKey: string
  load: (scope: OverviewScope) => Promise<void>
  reload: () => Promise<void>
  clear: () => void
}

export const keyOfScope = (scope: OverviewScope): string => JSON.stringify(scope)

export const EMPTY_SCOPE: OverviewScope = { period: 'today' }

/** A ready-to-spread scoped data slice. `set`/`get` are the enclosing store's,
 * so compound section stores can co-locate several slices under one hook. */
export function scopedDataSlice<T>(
  fetch: (scope: OverviewScope) => Promise<ApiResult<T | null>>,
  set: (patch: Partial<ScopedDataSlice<T>>) => void,
  get: () => ScopedDataSlice<T>,
): ScopedDataSlice<T> {
  const slice: ScopedDataSlice<T> = {
    data: null,
    error: null,
    status: 'idle',
    scope: EMPTY_SCOPE,
    dataKey: '',
    load: async (scope) => {
      const dataKey = keyOfScope(scope)
      if (get().dataKey === '' || get().dataKey !== dataKey) {
        set({ data: null, error: null, status: 'loading', scope, dataKey })
      }
      const result = await fetch(scope)
      if (get().dataKey !== dataKey) return
      if (result.ok) set({ data: result.data, error: null, status: 'ready' })
      else set({ error: result.error, status: 'ready' })
    },
    reload: async () => {
      if (get().dataKey === '') return
      await get().load(get().scope)
    },
    clear: () => set({ data: null, error: null, status: 'idle', scope: EMPTY_SCOPE, dataKey: '' }),
  }
  return slice
}

/** A self-contained scoped data store that subscribes to the shared refresh
 * tick. The standard shape for a section whose view owns exactly one payload. */
export function createScopedDataStore<T>(
  fetch: (scope: OverviewScope) => Promise<ApiResult<T | null>>,
) {
  const useStore = create<ScopedDataSlice<T>>()((set, get) => ({
    ...scopedDataSlice<T>(fetch, patch => set(patch), () => get()),
  }))
  subscribeToRefresh(() => { void useStore.getState().reload() })
  return useStore
}
