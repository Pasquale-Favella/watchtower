import type { CachedCall, CachedFile, FileFingerprint } from '../../../shared/schemas/session-cache.js'

export type ReconcileAction =
  { action: 'unchanged' } | { action: 'appended'; readFromOffset: number } | { action: 'modified' } | { action: 'new' }

export function reconcileFile(current: FileFingerprint, cached: CachedFile | undefined): ReconcileAction {
  if (!cached) return { action: 'new' }

  const fp = cached.fingerprint

  if (
    fp.dev === current.dev &&
    fp.ino === current.ino &&
    fp.mtimeMs === current.mtimeMs &&
    fp.sizeBytes === current.sizeBytes
  ) {
    return { action: 'unchanged' }
  }

  if (
    cached.lastCompleteLineOffset !== undefined &&
    // Defensive: never resume past the file's current end. A truncate-then-regrow
    // can leave the cached offset stranded beyond live bytes; reading from there
    // would silently drop the appended tail, so fall back to a full re-parse.
    cached.lastCompleteLineOffset <= current.sizeBytes &&
    fp.dev === current.dev &&
    fp.ino === current.ino &&
    current.sizeBytes > fp.sizeBytes
  ) {
    return { action: 'appended', readFromOffset: cached.lastCompleteLineOffset }
  }

  return { action: 'modified' }
}

// ── Dedup Merge ────────────────────────────────────────────────────────
// When appending incremental data, streaming Claude messages can re-emit
// the same dedup key with updated usage. Merge by key: keep the earliest
// timestamp, take incoming usage/tools/bashCommands/skills (latest wins).

export function mergeCallByDedupKey(existing: CachedCall, incoming: CachedCall): CachedCall {
  return {
    ...incoming,
    timestamp: existing.timestamp < incoming.timestamp ? existing.timestamp : incoming.timestamp,
  }
}
