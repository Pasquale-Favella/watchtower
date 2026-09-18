// Manual "Check for updates" for the Watchtower desktop app: on demand, it reads
// the public GitHub releases feed of the Watchtower repo, finds the newest
// release whose tag looks like a version, and semver-compares it to the
// running version.
//
// Deliberately manual-only (ADR 0012): there is NO background timer, no
// launch-time check, and no auto-download/install. The main process never
// touches this module except when the user clicks "Check for updates" in
// Settings' About area. Offline, a private/unpublished repo (the GitHub API
// returns 404 for those), or any other error is a silent no-op that reports
// "unable to check" — this informational network read never blocks anything.
//
// Privacy: a plain, unauthenticated GitHub read that carries no identifiers.
// We deliberately send no app-identifying headers and no auth token — only the
// runtime's default User-Agent (Node/Electron's "node") goes out. GitHub only
// requires *some* User-Agent, which the default satisfies. See fetchReleases.

import type { UpdateStatus } from '../shared/schemas/updates.js'
import { safeRecordOperationalLog } from './operational-log.js'

export type { UpdateStatus } from '../shared/schemas/updates.js'

const RELEASES_URL = 'https://api.github.com/repos/Pasquale-Favella/watchtower/releases?per_page=15'
const FETCH_TIMEOUT_MS = 15_000
// Release tags are accepted as plain semver (`v0.2.0`, GitHub's conventional
// format) or with a `desktop-v` prefix (`desktop-v0.2.0`), so
// a tag convention can be chosen later without a code change.
const RELEASE_TAG_RE = /^(?:desktop-)?v?(\d+\.\d+\.\d+)$/

type GitHubRelease = { tag_name?: string }

function baselineStatus(currentVersion: string): UpdateStatus {
  return { currentVersion, latestVersion: null, updateAvailable: false, tag: null }
}

/** Numeric compare of two `major.minor.patch` strings: -1 / 0 / 1. Missing or
 * non-numeric parts count as 0. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  for (let i = 0; i < 3; i++) {
    const x = Number(pa[i] ?? 0) || 0
    const y = Number(pb[i] ?? 0) || 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** The newest desktop release among the feed (by semver, not feed order), or
 * null if none match the tag convention. */
export function pickLatestDesktopVersion(releases: GitHubRelease[]): { version: string; tag: string } | null {
  let best: { version: string; tag: string } | null = null
  for (const release of releases) {
    const tag = typeof release?.tag_name === 'string' ? release.tag_name : ''
    const match = RELEASE_TAG_RE.exec(tag)
    if (!match) continue
    const version = match[1]!
    if (!best || compareSemver(version, best.version) > 0) best = { version, tag }
  }
  return best
}

/** Fetch + parse the releases feed. No auth, no app-identifying headers (see
 * the file header). Aborts after 15s. Throws on a non-2xx response (a private
 * or unknown repo 404s, which the caller turns into "unable to check"). */
export async function fetchReleases(signal: AbortSignal, fetchImpl: typeof fetch = globalThis.fetch): Promise<GitHubRelease[]> {
  const response = await fetchImpl(RELEASES_URL, { signal })
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`)
  const data = await response.json()
  return Array.isArray(data) ? (data as GitHubRelease[]) : []
}

export type UpdateChecker = {
  /** Force a fresh check now. Every button click calls this; there is no
   * background schedule, so this is the only entry point. */
  check(): Promise<UpdateStatus>
}

export function createUpdateChecker(opts: {
  currentVersion: string
  /** Injected in tests; defaults to the real GitHub read. */
  fetchReleasesImpl?: (signal: AbortSignal) => Promise<GitHubRelease[]>
}): UpdateChecker {
  const fetchReleasesImpl = opts.fetchReleasesImpl ?? ((signal: AbortSignal) => fetchReleases(signal))

  let cached = baselineStatus(opts.currentVersion)
  let inflight: Promise<UpdateStatus> | null = null

  const check = (): Promise<UpdateStatus> => {
    if (inflight) return inflight
    inflight = (async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      try {
        const releases = await fetchReleasesImpl(controller.signal)
        const latest = pickLatestDesktopVersion(releases)
        if (!latest) {
          cached = baselineStatus(opts.currentVersion)
        } else {
          const updateAvailable = compareSemver(latest.version, opts.currentVersion) > 0
          cached = {
            currentVersion: opts.currentVersion,
            latestVersion: latest.version,
            updateAvailable,
            tag: updateAvailable ? latest.tag : null,
          }
        }
      } catch {
        // Offline / GitHub error / private repo / timeout: silent no-op. Keep
        // the last known status so the next click retries cleanly. Recorded
        // as an info note (ticket #130) — being offline is not breakage.
        safeRecordOperationalLog('main', 'updates.offline', { code: 'unavailable' })
      } finally {
        clearTimeout(timer)
        inflight = null
      }
      return cached
    })()
    return inflight
  }

  return { check }
}
