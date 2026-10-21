export type { UpdateStatus } from '../../../../shared/schemas/updates.js'

/** The Watchtower repository homepage — the app's canonical repo link, shown
 * in the About area. https-only, so it passes openExternal's guard. */
export const REPO_URL = 'https://github.com/Pasquale-Favella/watchtower'

/** The GitHub release page for a release tag. The fallback link is shown
 * when an update is available. https-only, so it passes openExternal's guard. */
export function releasePageUrl(tag: string): string {
  return `${REPO_URL}/releases/tag/${encodeURIComponent(tag)}`
}
