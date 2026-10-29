import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import type { ProjectSummary, SessionSummary } from '../domain/observations/types.js'
import type { YieldRepoGroup } from '../analytics/attribution/yield-calculation.js'

/** Canonical identity shared by subdirectories and linked worktrees. */
export type RepoIdentity = {
  readonly key: string
  readonly gitDir: string
}

/** Git facts consumed by the pure Yield calculation. */
export type CommitInfo = {
  readonly sha: string
  readonly timestamp: Date
  readonly inMain: boolean | null
  readonly wasReverted: boolean | null
  readonly inspectionIssues?: readonly InspectionIssue[]
}

export type InspectionIssue = { readonly operation: string; readonly message: string }

export type InspectionRange = { readonly start: Date; readonly end: Date; readonly observedAt?: Date }

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
      mainBranch: string | null,
    ) => Effect.Effect<readonly CommitInfo[], RepositoryInspectionError>
  }
>()('watchtower/application/RepositoryInspection') {}

/** Collect local Git evidence without converting failed inspection into absent delivery. */
export const inspectYieldProjects = Effect.fn('inspectYieldProjects')(function* (
  projects: readonly ProjectSummary[],
  range: InspectionRange,
): Effect.fn.Return<readonly YieldRepoGroup[], never, RepositoryInspection> {
  const inspection = yield* RepositoryInspection
  const identities = new Map<string, RepoIdentity | null>()
  const groups = new Map<
    string,
    {
      commits: readonly CommitInfo[]
      sessions: SessionSummary[]
      projectNames: string[]
      mainRef: string | null
      inspectionIssues: InspectionIssue[]
      inspected: boolean
    }
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
      let mainRef: string | null = null
      let inspected = false
      const inspectionIssues: InspectionIssue[] = []
      if (identity) {
        mainRef = yield* inspection.getMainBranch(identity.gitDir).pipe(
          Effect.catchTag('RepositoryInspectionError', () => {
            inspectionIssues.push({
              operation: 'main-reference',
              message: 'The local main reference could not be resolved.',
            })
            return Effect.succeed(null)
          }),
        )
        commits = yield* inspection.getCommitFacts(identity.gitDir, range, mainRef).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              inspected = true
            }),
          ),
          Effect.catchTag('RepositoryInspectionError', () => {
            inspectionIssues.push({
              operation: 'commit-history',
              message: 'Local commit history could not be inspected.',
            })
            return Effect.succeed([])
          }),
        )
      } else {
        inspectionIssues.push({
          operation: 'repository-identity',
          message: directory
            ? 'The session directory could not be identified as an available Git work tree.'
            : 'The session has no recorded working directory.',
        })
      }
      group = { commits, sessions: [], projectNames: [], mainRef, inspectionIssues, inspected }
      groups.set(key, group)
    }
    group.sessions.push(...project.sessions)
    group.projectNames.push(...project.sessions.map(() => project.project))
  }

  return [...groups.values()]
})
