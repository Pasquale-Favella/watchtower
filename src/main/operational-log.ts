import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import pino, { type Logger } from 'pino'

import {
  buildOperationalLogRecord,
  type OperationalLogContext,
  type OperationalLogEvent,
  type OperationalLogFields,
  type OperationalLogLevel,
} from '../shared/operational-log.js'

/**
 * Main-owned Operational log file sink (spec #126, ADR 0029, ticket #127).
 *
 * One shared JSON-lines file under `<userData>/logs`, owned exclusively by
 * the main process — worker/sidecar/renderer records are forwarded here, never
 * appended directly. Packaged builds write info level only; development writes
 * debug and mirrors human-readable lines to the console. Rotation caps the
 * total size (~5MB x3 by default); stale generations are pruned on boot so no
 * background sweeper is needed.
 */

export const OPERATIONAL_LOG_FILE = 'operational.log'
export const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024
export const DEFAULT_MAX_GENERATIONS = 3

export interface OperationalLogOptions {
  logDir: string
  isPackaged: boolean
  maxFileBytes?: number
  maxGenerations?: number
}

interface ActiveLog {
  opts: Required<Pick<OperationalLogOptions, 'logDir' | 'maxFileBytes' | 'maxGenerations'>> & { isPackaged: boolean }
  logger: Logger
  /** The open file handle. Ended before any rename so rotation never moves an
   * open file (Windows) and no descriptor leaks across rotations. */
  dest: { flushSync?: () => void; end?: () => void }
}

let active: ActiveLog | null = null

function filePath(logDir: string): string {
  return join(logDir, OPERATIONAL_LOG_FILE)
}

function generationPath(logDir: string, generation: number): string {
  return join(logDir, `${OPERATIONAL_LOG_FILE}.${generation}`)
}

/** Deletes generations beyond the cap (boot prune, no background sweeper). */
export function pruneStaleGenerations(logDir: string, maxGenerations: number): void {
  let entries: string[] = []
  try {
    entries = readdirSync(logDir)
  } catch {
    return
  }
  for (const entry of entries) {
    const match = /^operational\.log\.(\d+)$/.exec(entry)
    if (!match) continue
    const generation = Number(match[1])
    if (!Number.isInteger(generation) || generation < 1 || generation > maxGenerations) {
      try { rmSync(join(logDir, entry), { force: true }) } catch { /* best effort */ }
    }
  }
}

function rotateLog(logDir: string, maxGenerations: number): void {
  try { rmSync(generationPath(logDir, maxGenerations), { force: true }) } catch { /* best effort */ }
  for (let generation = maxGenerations - 1; generation >= 1; generation--) {
    const from = generationPath(logDir, generation)
    const to = generationPath(logDir, generation + 1)
    try {
      statSync(from)
    } catch {
      continue
    }
    try { renameSync(from, to) } catch { /* best effort */ }
  }
  try {
    statSync(filePath(logDir))
    renameSync(filePath(logDir), generationPath(logDir, 1))
  } catch {
    // No current file — nothing to rotate.
  }
}

function createLogger(opts: ActiveLog['opts']): { logger: Logger; dest: ActiveLog['dest'] } {
  const level = opts.isPackaged ? 'info' : 'debug'
  const dest = pino.destination({ dest: filePath(opts.logDir), append: true, sync: true, mkdir: true })
  return { logger: pino({ level }, dest), dest: dest as unknown as ActiveLog['dest'] }
}

function endDest(dest: ActiveLog['dest']): void {
  try { dest.flushSync?.() } catch { /* best effort */ }
  try { dest.end?.() } catch { /* best effort */ }
}

function currentSize(logDir: string): number {
  try {
    return statSync(filePath(logDir)).size
  } catch {
    return 0
  }
}

/** Boots (or re-boots) the singleton sink. Prunes stale generations first. */
export function initOperationalLog(opts: OperationalLogOptions): void {
  const resolved = {
    logDir: opts.logDir,
    isPackaged: opts.isPackaged,
    maxFileBytes: opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxGenerations: opts.maxGenerations ?? DEFAULT_MAX_GENERATIONS,
  }
  mkdirSync(resolved.logDir, { recursive: true })
  pruneStaleGenerations(resolved.logDir, resolved.maxGenerations)
  if (active) endDest(active.dest)
  if (currentSize(resolved.logDir) > resolved.maxFileBytes) {
    rotateLog(resolved.logDir, resolved.maxGenerations)
  }
  const created = createLogger(resolved)
  active = { opts: resolved, logger: created.logger, dest: created.dest }
}

/** Records one allowlisted record — the ONLY way main-path code emits. */
export function recordOperationalLog(
  context: OperationalLogContext,
  event: OperationalLogEvent,
  fields: OperationalLogFields = {},
  opts: { level?: OperationalLogLevel; timestamp?: string } = {},
): void {
  if (!active) return
  if (currentSize(active.opts.logDir) > active.opts.maxFileBytes) {
    // End the open handle BEFORE renaming so the rotation moves closed files
    // only — every line stays complete and parseable, none is truncated.
    endDest(active.dest)
    rotateLog(active.opts.logDir, active.opts.maxGenerations)
    const created = createLogger(active.opts)
    active.logger = created.logger
    active.dest = created.dest
  }
  const record = buildOperationalLogRecord(context, event, fields, opts)
  const logger = active.logger
  switch (record.level) {
    case 'debug': logger.debug(record); break
    case 'info': logger.info(record); break
    case 'warn': logger.warn(record); break
    case 'error': logger.error(record); break
  }
  if (!active.opts.isPackaged) {
    // Development console mirror: human-readable, never JSON-parsed. Stdout
    // only — the sidecar readiness contract reserves its own stdout.
    try {
      process.stdout.write(`${record.level} ${record.context}/${record.event}\n`)
    } catch { /* best effort */ }
  }
}

/** Flushes and closes the sink (tests + quit path). Re-entrant. */
export function closeOperationalLog(): void {
  if (!active) return
  endDest(active.dest)
  active = null
}
