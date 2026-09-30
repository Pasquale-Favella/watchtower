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
// requires *some* User-Agent, which the default satisfies.

import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'

import type { UpdateStatus } from '../shared/schemas/updates.js'
import { safeLogOperationalEvent } from './operational-log.js'
import { HttpFetch, retryTransientFetch } from './pipeline/fetch-utils.js'

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

// --- Effect-native updates boundary (ADR 0032). The Promise adapters
// (`fetchReleases`/`createUpdateChecker`) were removed once the main-process
// update IPC consumed these effects through the main runtime; pure helpers
// (`compareSemver`, `pickLatestDesktopVersion`) stay plain functions. ---

/** Typed fetch failure for the Effect boundary: non-2xx (`http` with status),
 * network/abort (`network`), or Clock timeout (`timeout`). */
export class UpdateFetchError extends Schema.TaggedError<UpdateFetchError>()('UpdateFetchError', {
  reason: Schema.Literals(['http', 'network', 'timeout']),
  message: Schema.String,
  status: Schema.optional(Schema.Number),
}) {}

function toUpdateFetchReason(reason: string): 'timeout' | 'network' {
  if (reason === 'timeout') {
    return 'timeout'
  }
  return 'network'
}

function describeUpdateErrorCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message
  }
  return String(cause)
}

function buildFreshStatus(currentVersion: string, latest: { version: string; tag: string } | null): UpdateStatus {
  if (latest === null) {
    return baselineStatus(currentVersion)
  }
  if (compareSemver(latest.version, currentVersion) > 0) {
    return { currentVersion, latestVersion: latest.version, updateAvailable: true, tag: latest.tag }
  }
  return { currentVersion, latestVersion: latest.version, updateAvailable: false, tag: null }
}

interface UpdateCheckerState {
  cached: UpdateStatus
  flight: Deferred.Deferred<UpdateStatus> | null
}

interface UpdateCheckDecision {
  isLeader: boolean
  deferred: Deferred.Deferred<UpdateStatus>
  prevCached: UpdateStatus
}

/** Effect-native releases read: the public GitHub releases feed over the
 * `HttpFetch` service — timeout via the Effect Clock (`FETCH_TIMEOUT_MS`,
 * TestClock controllable) and fiber interruption aborts the underlying
 * fetch, replacing manual `AbortController`+`setTimeout` plumbing. No auth,
 * no app-identifying headers (see the file header). Non-array JSON still
 * yields `[]`.
 *
 * Bounded transient retry (F15/A1) on the fetch only: the manual check used
 * to report "unable to check" off a single two-second blip. It stays
 * manual-only, still sends nothing, and still never blocks — the
 * `update.offline` degrade in `createUpdateCheckerEffect` is unchanged, it
 * just runs after the retries are spent. A 404 (private/unpublished repo) is
 * a real answer, not a transient failure, so the non-2xx arm below stays
 * outside the retry. */
export const fetchReleasesEffect = Effect.fn('fetchReleasesEffect')(function* (): Effect.fn.Return<
  GitHubRelease[],
  UpdateFetchError,
  HttpFetch
> {
  const http = yield* HttpFetch
  const response = yield* http.fetch(RELEASES_URL, {}, FETCH_TIMEOUT_MS).pipe(
    retryTransientFetch,
    Effect.mapError(
      cause =>
        new UpdateFetchError({
          reason: toUpdateFetchReason(cause.reason),
          message: cause.message,
        }),
    ),
  )
  if (!response.ok) {
    return yield* new UpdateFetchError({
      reason: 'http',
      message: `GitHub HTTP ${response.status}`,
      status: response.status,
    })
  }
  const data = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: cause =>
      new UpdateFetchError({
        reason: 'network',
        message: describeUpdateErrorCause(cause),
      }),
  })
  if (Array.isArray(data)) {
    return data as GitHubRelease[]
  }
  return []
})

export interface UpdateCheckerEffect {
  /** Effect-based check (`checkUpdatesEffect` equivalent): every button click
   * runs this; there is no background schedule. Concurrent checks share one
   * flight, last-known status is cached, offline/error degrades to cached
   * status with the `update.offline` informational note — never fails
   * (interruption still propagates). */
  readonly check: () => Effect.Effect<UpdateStatus, never, HttpFetch>
}

/** Effect-native update checker factory. Observable contract: concurrent
 * `check()` calls share one flight via a shared `Deferred`, the last-known
 * status is cached in a `Ref`, and any fetch failure degrades to the cached
 * status with the `update.offline` informational operational-log note (via
 * `safeLogOperationalEvent` wrapped in `Effect.sync`). Pure helpers
 * (`compareSemver`, `pickLatestDesktopVersion`) stay plain functions. */
export const createUpdateCheckerEffect = Effect.fn('createUpdateCheckerEffect')(function* (opts: {
  currentVersion: string
}): Effect.fn.Return<UpdateCheckerEffect> {
  const stateRef = yield* Ref.make<UpdateCheckerState>({
    cached: baselineStatus(opts.currentVersion),
    flight: null,
  })
  const currentVersion = opts.currentVersion

  function check(): Effect.Effect<UpdateStatus, never, HttpFetch> {
    return Effect.gen(function* () {
      const myDeferred = yield* Deferred.make<UpdateStatus>()
      const decision = yield* Ref.modify(stateRef, function claimFlight(state: UpdateCheckerState): readonly [
        UpdateCheckDecision,
        UpdateCheckerState,
      ] {
        if (state.flight === null) {
          return [
            { isLeader: true, deferred: myDeferred, prevCached: state.cached },
            { cached: state.cached, flight: myDeferred },
          ]
        }
        return [{ isLeader: false, deferred: state.flight, prevCached: state.cached }, state]
      })
      if (!decision.isLeader) {
        return yield* Deferred.await(decision.deferred)
      }
      const prevCached = decision.prevCached
      const leaderDeferred = decision.deferred

      const computeFresh: Effect.Effect<UpdateStatus, never, HttpFetch> = Effect.gen(function* () {
        const releases = yield* fetchReleasesEffect()
        return buildFreshStatus(currentVersion, pickLatestDesktopVersion(releases))
      }).pipe(
        Effect.catch(() =>
          Effect.gen(function* () {
            yield* Effect.sync(() =>
              safeLogOperationalEvent('info', 'update.offline', { op: 'updates:check', code: 'unavailable' }),
            )
            return prevCached
          }),
        ),
      )

      return yield* computeFresh.pipe(
        Effect.onExit(function (exit) {
          if (Exit.isSuccess(exit)) {
            return Effect.gen(function* () {
              yield* Ref.update(stateRef, () => ({ cached: exit.value, flight: null }))
              yield* Deferred.succeed(leaderDeferred, exit.value)
            })
          }
          return Effect.gen(function* () {
            yield* Ref.update(stateRef, s => ({ cached: s.cached, flight: null }))
            yield* Deferred.done(leaderDeferred, exit)
          })
        }),
      )
    })
  }

  return { check }
})
