import { create } from 'zustand'
import { fetchAnalytics, fetchScan, fetchScanStatus } from '@/shared/lib/api'
import type { ScanMetadata } from '../../../../shared/schemas/scan.js'
import type { SplashProviderProgress } from '../../../../shared/schemas/renderer.js'

/** Rows/blobs the last scan skipped because a declared field failed the
 * extraction schema — the drift signal ADR 0003 says must be visible. */
const unparsedCount = (metadata?: ScanMetadata): number =>
  metadata ? metadata.perProvider.reduce((n, p) => n + p.unparsed, 0) : 0

/** Scan lifecycle + the shared refresh tick. (map ticket 02) */
export interface ScanState {
  hydrated: boolean
  scanning: boolean
  scanError: string | null
  unparsedTotal: number
  detectedProviders: string[]
  progress: SplashProviderProgress[]
  refreshVersion: number
  /** Refreshes the scan status and reloads detected providers after a
   * store:changed / config:changed broadcast, then bumps the shared tick. */
  applyChange: () => Promise<void>
  /** Triggers a scan. Success is observed via the onChanged subscription, not
   * this function's return value — the same path a background-cadence scan
   * takes. Only failures are handled here. */
  refresh: () => Promise<void>
  onProgress: (provider: string, processed: number, total: number, done: boolean) => void
  onError: (message: string) => void
  onIdle: () => void
}

type RefreshListener = () => void
const refreshListeners = new Set<RefreshListener>()

/** Registers a callback fired whenever a scan/config change completes (the
 * shared refresh tick). Returns the unsubscriber. Data stores register their
 * `reload` here so every section refetches after a scan without polling. */
export function subscribeToRefresh(listener: RefreshListener): () => void {
  refreshListeners.add(listener)
  return () => { refreshListeners.delete(listener) }
}

function notifyRefreshListeners(): void {
  for (const listener of refreshListeners) listener()
}

export const useScanStore = create<ScanState>()((set, get) => ({
  hydrated: false,
  scanning: false,
  scanError: null,
  unparsedTotal: 0,
  detectedProviders: [],
  progress: [],
  refreshVersion: 0,
  applyChange: async () => {
    const statusResult = await fetchScanStatus()
    if (!statusResult.ok) return
    set({
      hydrated: statusResult.data.scanned,
      unparsedTotal: unparsedCount(statusResult.data.metadata),
      scanError: statusResult.data.scanned ? null : get().scanError,
      scanning: false,
      progress: [],
    })
    const analytics = await fetchAnalytics()
    // Parity with AppShell: a bad analytics fetch clears the provider list
    // rather than leaving last scan's stale list painted.
    if (analytics.ok && analytics.data) {
      set({ detectedProviders: analytics.data.providers.map(provider => provider.name) })
    } else {
      set({ detectedProviders: [] })
    }
    set((state) => ({ refreshVersion: state.refreshVersion + 1 }))
    notifyRefreshListeners()
  },
  refresh: async () => {
    set({ scanning: true, scanError: null })
    const result = await fetchScan()
    if (!result.ok) {
      set({ scanError: result.error, scanning: false })
      return
    }
    // A scan is already in flight (background cadence or a concurrent call):
    // not a failure — its progress events will arrive and the store:changed
    // broadcast will hydrate the shell. Keep `scanning` set.
    if (result.data.alreadyRunning) return
    if (!result.data.ok && !result.data.aborted) {
      set({
        scanError: result.data.error ?? 'Scan failed. Check your provider sources and try again.',
        scanning: false,
      })
    }
  },
  onProgress: (provider, processed, total, done) => {
    // Parity with AppShell's handler: every progress event marks the shell as
    // scanning, but only provider-carrying events paint a row — a bare
    // `{ stage: 'pricing' }` event must not draw an empty provider entry.
    if (!provider) {
      set({ scanning: true })
      return
    }
    const next = get().progress.filter(p => p.provider !== provider)
    set({ progress: [...next, { provider, processed, total, done }], scanning: true })
  },
  onError: (message) => set({ scanError: message, scanning: false }),
  onIdle: () => set({ scanning: false, progress: [] }),
}))
