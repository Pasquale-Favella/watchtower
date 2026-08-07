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
  const issues = result.error.issues
    .slice(0, 3)
    .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ')
  process.stderr.write(`watchtower: unparsed ${context}: ${issues}\n`)
  return null
}
