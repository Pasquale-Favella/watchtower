/**
 * The main ↔ db-worker wire protocol (ADR 0023). The db-worker owns the
 * ledger, the scan pipeline, and every query-time view builder; the main
 * process stays a thin forwarder (windows, dialogs, IPC plumbing) so a scan
 * or a heavy aggregation can never freeze the UI thread of the main process.
 *
 * `worker_threads` structured-clone every message: requests, responses, and
 * events must all be plain JSON-shaped data (no functions, no class
 * instances). Handler-thrown errors cross as `{ ok: false, error }` — the
 * same shape an `ipcMain.handle` rejection has for the renderer, so the
 * renderer's tripwire behavior is unchanged.
 */

/** Boot context for the worker, passed via `workerData` (no handshake race:
 * it is available synchronously at worker startup). */
export interface DbWorkerData {
  /** Absolute path of `ledger.db`. */
  dbPath: string
  /** Absolute `userData` dir (reported sizes + derived paths). */
  dataDir: string
  /** Absolute cache dir (`WATCHTOWER_CACHE_DIR` for the pipeline). */
  cacheDir: string
}

/** Main → worker: invoke op `op` with positional `args`. */
export interface DbWorkerRequest {
  id: number
  op: string
  args: unknown[]
}

/** Worker → main: the settled outcome of one request. */
export type DbWorkerResponse = { id: number; ok: true; data: unknown } | { id: number; ok: false; error: string }

/** Worker → main: fire-and-forget broadcasts the main relays to windows.
 * `manual` tags scan-lifecycle events that belong to the requesting window
 * only (a manual ⌘R scan); background-cadence events go to every window.
 * `ready` / `init-error` are consumed by the client itself (boot handshake),
 * never relayed to windows. */
export type DbWorkerEvent =
  | { event: 'ready' }
  | { event: 'init-error'; error: string }
  | { event: 'scan:progress'; manual: boolean; progress: unknown }
  | { event: 'scan:error'; manual: boolean; message: string }
  | { event: 'store:changed'; metadata: unknown }
  | { event: 'scan:idle' }
  | { event: 'config:changed' }
  | { event: 'currency:changed'; currency: unknown }
  | {
      /** Operational-log forward (#128): an allowlisted record for main to
       * file via the shared seam. `fields` carries short strings and counts
       * only (provider names, basenames, codes) — main stamps
       * `context: 'worker'` and drops anything outside the allowlist. */
      event: 'oplog'
      level: 'debug' | 'info' | 'warn' | 'error'
      logEvent: string
      fields: Record<string, string | number>
    }

/** Pure-read ops: safe to coalesce when the same op+args is already in
 * flight (double-mounts, tick+mount races). Everything else — scans, writes,
 * config changes, exports, clears — always executes: dropping one would drop
 * its broadcast or its write. */
export const DEDUPABLE_OPS: ReadonlySet<string> = new Set([
  'cadence:get',
  'scan:active',
  'store:status',
  'store:views',
  'store:projects',
  'store:sessions',
  'store:session',
  'store:analytics',
  'store:search',
  'overview:query',
  'sessions:view',
  'pullRequests:view',
  'spend:view',
  'models:view',
  'compare:view',
  'optimize:view',
  'optimize:yield',
  'skills:view',
  'models:getAliases',
  'models:getPriceOverrides',
  'settings:info',
  'ledger-mcp:startup:get',
  'currency:get',
  'currency:list',
])

export function isDbWorkerResponse(raw: unknown): raw is DbWorkerResponse {
  if (!raw || typeof raw !== 'object') return false
  const msg = raw as Record<string, unknown>
  return typeof msg['id'] === 'number' && typeof msg['ok'] === 'boolean'
}

export function isDbWorkerEvent(raw: unknown): raw is DbWorkerEvent {
  if (!raw || typeof raw !== 'object') return false
  return typeof (raw as Record<string, unknown>)['event'] === 'string'
}
