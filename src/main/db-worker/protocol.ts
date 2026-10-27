/**
 * Local worker bootstrap and supervisor policy (ADRs 0023 and 0037). The db-worker owns the
 * ledger, the scan pipeline, and every query-time view builder; the main
 * process stays a thin forwarder (windows, dialogs, IPC plumbing) so a scan
 * or a heavy aggregation can never freeze the UI thread of the main process.
 *
 * The wire contract is shared/rpc/worker.ts. Producers submit local events to
 * its schema-validated, sequenced stream; the supervisor retains read policy.
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

/** Local producer input, validated before it enters the worker RPC event stream.
 * `manual` tags scan-lifecycle events that belong to the requesting window
 * only (a manual ⌘R scan); background-cadence events go to every window.
 * Application readiness is an RPC acknowledgement, not a producer event. */
export type DbWorkerEvent =
  | { event: 'scan:progress'; manual: boolean; progress: unknown }
  | { event: 'scan:error'; manual: boolean; message: string }
  | { event: 'store:changed'; metadata: unknown }
  | { event: 'ledger:reset' }
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
 * flight (double-mounts, tick+mount races). `scan:active` is deliberately NOT
 * here: it is a time-varying flag, and a coalesced answer computed before a
 * scan started could be served to a window booting a tick later. Everything else — scans, writes,
 * config changes, exports, clears — always executes: dropping one would drop
 * its broadcast or its write. */
export const DEDUPABLE_OPS: ReadonlySet<string> = new Set([
  'cadence:get',
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
