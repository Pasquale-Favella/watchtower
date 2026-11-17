/** Elapsed time for folded Runs and the live ticker: `850 ms`, `4.2s`, `1m 2s`, `1h 2m 3s`. */
export function formatRunDuration(milliseconds: number): string {
  const ms = Math.max(0, Math.round(milliseconds))
  if (ms < 1000) return `${ms} ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/** Milliseconds between two durable timestamps, or null when either is missing or unparseable. */
export function elapsedBetween(start: string | null, end: string | null): number | null {
  if (!start || !end) return null
  const from = Date.parse(start)
  const to = Date.parse(end)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null
  return Math.max(0, to - from)
}
