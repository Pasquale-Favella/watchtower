/** The About area's manual update-check result (ticket 31). The shared
 * `updateStatusSchema` is the wire contract over `updates:check` — the same
 * schema the main process validates against. */
import type { UpdateStatus } from '../../../../shared/schemas/updates.js'

export type { UpdateStatus } from '../../../../shared/schemas/updates.js'

/** The Watchtower repository homepage — the app's canonical repo link, shown
 * in the About area. https-only, so it passes openExternal's guard. */
export const REPO_URL = 'https://github.com/Pasquale-Favella/watchtower'

/** The GitHub release page for a release tag — the informational link shown
 * when an update is available. https-only, so it passes openExternal's guard. */
export function releasePageUrl(tag: string): string {
  return `${REPO_URL}/releases/tag/${tag}`
}
