/** The About area's manual update-check result (ticket 31). The shared
 * `updateStatusSchema` is the wire contract over `updates:check` — the same
 * schema the main process validates against. */
import type { UpdateStatus } from '../../../../shared/schemas/updates.js'

export type { UpdateStatus } from '../../../../shared/schemas/updates.js'

/** The GitHub release page for a release tag — the informational link shown
 * when an update is available. https-only, so it passes openExternal's guard. */
export function releasePageUrl(tag: string): string {
  return `https://github.com/Pasquale-Favella/munnin/releases/tag/${tag}`
}
