import type { CadenceOption } from '../shared/schemas/cadence.js'

export type { CadenceOption } from '../shared/schemas/cadence.js'

/**
 * The background-scan cadence (ticket 21 / ticket 08's resolved decision):
 * A "Refresh every" control governs how often the main process triggers a
 * background scan, rather than a renderer polling interval. Same value
 * set/labels as the CLI's refresh-cadence reference, minus the renderer
 * polling meaning.
 */
export const CADENCE_OPTIONS: readonly CadenceOption[] = [
  { value: 'manual', label: 'Manual', ms: null },
  { value: '30s', label: '30 seconds', ms: 30_000 },
  { value: '1m', label: '1 minute', ms: 60_000 },
  { value: '3m', label: '3 minutes', ms: 180_000 },
  { value: '5m', label: '5 minutes', ms: 300_000 },
  { value: '10m', label: '10 minutes', ms: 600_000 }
]

/** Matches the reference app's default (halves idle scan frequency vs. 30s
 * while staying reasonably fresh). */
export const DEFAULT_CADENCE = '1m'

export function isValidCadence(value: string): boolean {
  return CADENCE_OPTIONS.some(o => o.value === value)
}

/**
 * Resolves a cadence value to its background-scan interval in milliseconds,
 * or null for "manual" (no timer scheduled). Falls back to the default
 * cadence for any unrecognized/corrupt stored value.
 */
export function resolveCadenceMs(value: string): number | null {
  const option = CADENCE_OPTIONS.find(o => o.value === value)
  if (option) return option.ms
  return resolveCadenceMs(DEFAULT_CADENCE)
}
