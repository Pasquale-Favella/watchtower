import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import type { ProjectSummary, SessionSummary } from '../pipeline/types.js'
import type { YieldRepoGroup } from '../yield-calculation.js'

/** Canonical identity shared by subdirectories and linked worktrees. */
export type RepoIdentity = {
  readonly key: string
  readonly gitDir: string
}

/** Git facts consumed by the pure Yield calculation. */
export type CommitInfo = {
  readonly sha: string
  readonly timestamp: Date
  readonly inMain: boolean
  readonly wasReverted: boolean
}

export type InspectionRange = { readonly start: Date; readonly end: Date }

export class RepositoryInspectionError extends Schema.TaggedError<RepositoryInspectionError>()(
  'RepositoryInspectionError',
  { operation: Schema.String, message: Schema.String },
) {}

/** Process capability for identifying a repository and collecting its git facts. */
export class RepositoryInspection extends Context.Service<
  RepositoryInspection,
  {
    readonly resolveIdentity: (directory: string) => Effect.Effect<RepoIdentity, RepositoryInspectionError>
    readonly getMainBranch: (directory: string) => Effect.Effect<string, RepositoryInspectionError>
    readonly getCommitFacts: (
      directory: string,
      range: InspectionRange,
      mainBranch: string,
    ) => Effect.Effect<readonly CommitInfo[], RepositoryInspectionError>
  }
>()('watchtower/application/RepositoryInspection') {}

/** Collect one set of git facts per canonical checkout. Typed inspection
 * failures follow the historical silent-empty policy; defects still fail. */
export const inspectYieldProjects = Effect.fn('inspectYieldProjects')(function* (
  projects: readonly ProjectSummary[],
  range: InspectionRange,
): Effect.fn.Return<readonly YieldRepoGroup[], never, RepositoryInspection> {
  const inspection = yield* RepositoryInspection
  const identities = new Map<string, RepoIdentity | null>()
  const groups = new Map<
    string,
    { commits: readonly CommitInfo[]; sessions: SessionSummary[]; projectNames: string[] }
  >()

  for (const project of projects) {
    const directory = project.projectPath
    let identity: RepoIdentity | null = null
    if (directory) {
      if (identities.has(directory)) {
        identity = identities.get(directory) ?? null
      } else {
        identity = yield* inspection
          .resolveIdentity(directory)
          .pipe(Effect.catchTag('RepositoryInspectionError', () => Effect.succeed(null)))
        identities.set(directory, identity)
      }
    }
    const key = identity?.key ?? directory ?? project.project
    let group = groups.get(key)
    if (!group) {
      let commits: readonly CommitInfo[] = []
      if (identity) {
        const mainBranch = yield* inspection
          .getMainBranch(identity.gitDir)
          .pipe(Effect.catchTag('RepositoryInspectionError', () => Effect.succeed('main')))
        commits = yield* inspection
          .getCommitFacts(identity.gitDir, range, mainBranch)
          .pipe(Effect.catchTag('RepositoryInspectionError', () => Effect.succeed([])))
      }
      group = { commits, sessions: [], projectNames: [] }
      groups.set(key, group)
    }
    group.sessions.push(...project.sessions)
    group.projectNames.push(...project.sessions.map(() => project.project))
  }

  return [...groups.values()]
})
