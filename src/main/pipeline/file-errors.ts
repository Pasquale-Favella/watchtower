import { basename } from 'node:path'

export { errnoCodeFor as fileErrorCode } from '../../shared/logging.js'

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

/** Queue a provider-level diagnostic (discovery/open/query/skip failure):
 * provider + basename + short code only. The worker context drains the queue
 * into `oplog` host events after each scan. */
export function reportProviderIssue(provider: string, code: string, sourcePath?: string): void {
  const fields: QueuedLogFields = { op: 'scan', provider, code }
  if (sourcePath) fields.file = logFileName(sourcePath)
  queueLogRecord({ logEvent: 'scan.file-error', level: 'warn', fields })
}
