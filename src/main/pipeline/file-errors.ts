import { basename } from 'node:path'

/**
 * Worker-side file-error outbox (#128). The scan pipeline runs on the
 * db-worker thread, which must stay Electron-free and pino-free — so per-file
 * failure signals (provider + basename + short code, never contents or full
 * paths) queue here during a scan and the worker context drains them into
 * `oplog` host events afterwards. Main records each drained entry through the
 * Operational log seam; the queue bounds itself the same way the old stderr
 * warnings did (warn-once per file, capped per provider per run).
 */

export type QueuedLogLevel = 'info' | 'warn' | 'error'

export interface QueuedLogFields {
  op: string
  provider?: string
  file?: string
  model?: string
  code: string
  count?: number
}

export interface QueuedLogRecord {
  logEvent: string
  level: QueuedLogLevel
  fields: QueuedLogFields
}

const pending: QueuedLogRecord[] = []

export function queueLogRecord(record: QueuedLogRecord): void {
  pending.push(record)
}

export function takeQueuedLogRecords(): QueuedLogRecord[] {
  return pending.splice(0, pending.length)
}

/** Basename a source path for log records — absolute paths (which embed
 * usernames) never leave the worker. */
export function logFileName(sourcePath: string): string {
  return basename(sourcePath)
}

/** Short machine code for a caught error — never the message body (messages
 * embed paths and payloads). Prefers errno codes (`EACCES`, `EBUSY`) so
 * provider open/query failures stay precise; falls back to the error-name
 * slug, then the caller-supplied token. Worker/provider-side mirror of
 * `logCodeFor` — kept here so the worker bundle stays pino-free. */
export function fileErrorCode(err: unknown, fallback: string): string {
  const errno = (err as NodeJS.ErrnoException | undefined)?.code
  if (typeof errno === 'string' && errno.trim()) return errno
  if (err instanceof Error && err.name && err.name !== 'Error') {
    const slug = err.name
      .replace(/Error$/, '')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
    if (slug) return slug
  }
  return fallback
}

/** Queue a provider-level diagnostic (discovery/open/query/skip failure):
 * provider + basename + short code only. The worker context drains the queue
 * into `oplog` host events after each scan. */
export function reportProviderIssue(provider: string, code: string, sourcePath?: string): void {
  const fields: QueuedLogFields = { op: 'scan', provider, code }
  if (sourcePath) fields.file = logFileName(sourcePath)
  queueLogRecord({ logEvent: 'scan.file-error', level: 'warn', fields })
}
