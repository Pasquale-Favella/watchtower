import type { SplashProviderProgress } from '../../../../../shared/schemas/renderer.js'
import { SCAN_STAGE_ORDER } from '../../../../../shared/schemas/scan.js'
import type { ScanStage } from '../../../../../shared/schemas/scan.js'

export function providerName(id: string): string {
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/** Stable pseudo-random in [0, 1) per provider id. */
function hashUnit(id: string, salt: number): number {
  let h = 2166136261 ^ salt
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  return ((h >>> 0) % 10000) / 10000
}

/** How far a source sits from the center, as a fraction of the ring's radius:
 * clear of the logo disc and inside the ring, varied per provider id so the
 * constellation looks scattered rather than ringed. */
export function nodeRadius(id: string): number {
  return 0.5 + hashUnit(id, 2) * 0.38
}

/** Where the nth detected source sits on the radar, in degrees clockwise
 * from 12 o'clock. The golden angle spreads sources evenly whatever their
 * number, and starting at 40° keeps the first label off the top edge. */
export function nodeAngle(index: number): number {
  return (40 + index * 137.508) % 360
}

/** 0 prices → 1 sessions → 2 dashboard (every detected provider settled). */
export function stepIndex(stage: ScanStage | null, providers: SplashProviderProgress[]): number {
  if (providers.length > 0 && providers.every(p => p.done)) return 2
  if (stage !== null && SCAN_STAGE_ORDER[stage] >= SCAN_STAGE_ORDER.parse) return 1
  if (providers.length > 0) return 1
  return 0
}

export function statusMessage(step: number, providers: SplashProviderProgress[]): string {
  if (step === 2) return 'Building your dashboard'
  if (step === 0) return 'Loading model prices'
  const active = providers.findLast(p => !p.done)
  return active ? `Reading ${providerName(active.provider)} sessions` : 'Looking for code assistants'
}
