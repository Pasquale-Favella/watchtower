import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'

import type {
  ProjectRemoteSource,
  ProjectSetupError,
  RemoteRepository,
  RemoteSourceReadiness,
} from '@/shared/schemas/workspace-projects.js'

export { ProjectSetupError } from '@/shared/schemas/workspace-projects.js'

/** Prepares a local folder for registration through the user's own `git` and `gh`.
 * Every operation is an explicit user request; none of them registers a Project.
 */
export class ProjectProvisioner extends Context.Service<
  ProjectProvisioner,
  {
    /** Initializes a new repository with a README and attempts its first commit. */
    readonly initialize: (path: string, name: string) => Effect.Effect<void, ProjectSetupError>
    /** Clones into a missing or empty destination. */
    readonly clone: (source: ProjectRemoteSource, destinationPath: string) => Effect.Effect<void, ProjectSetupError>
    /** Creates a private GitHub repository as `origin`; a checkout that already has `origin` is left alone. */
    readonly publishToGitHub: (path: string, name: string) => Effect.Effect<void, ProjectSetupError>
    readonly lookupGitHubRepository: (repository: string) => Effect.Effect<RemoteRepository, ProjectSetupError>
    readonly readiness: Effect.Effect<RemoteSourceReadiness>
  }
>()('watchtower/core/ProjectProvisioner') {}
