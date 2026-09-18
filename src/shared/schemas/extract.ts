import type { z } from 'zod'

/** Mutable per-provider unparsed tally shared across a scan run. */
export type UnparsedTally = { count: number }

/**
 * The skip-and-report extraction rule (ADR 0003): parse a foreign row/blob
 * against a loose schema. Unknown keys are stripped (never a failure); a
 * declared field failing its type logs the exact context once and returns
 * `null` so the caller can skip just that unit and keep going — a provider
 * version bump degrades that provider's extraction, never bricks the scan.
 */
export function parseOrSkip<T>(
  schema: z.ZodType<T>,
  value: unknown,
  tally: UnparsedTally,
  context: string,
): T | null {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  tally.count++
  // No console output: the tally aggregates into the scan's per-provider
  // unparsed counts, which the Operational log files as `scan.provider`
  // records — the full context (which embeds source paths) never leaves the
  // scan, and this module stays renderer-safe (no `process` access).
  void context
  return null
}
