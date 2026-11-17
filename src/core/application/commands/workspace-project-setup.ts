import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'

import { WorkspaceProjects } from '@/core/application/commands/workspace-projects.js'
import { ProjectProvisioner } from '@/core/ports/project-provisioner.js'
import { CheckoutResolverError } from '@/shared/schemas/checkout.js'
import {
  type CloneWorkspaceProject,
  cloneWorkspaceProjectSchema,
  type CreateWorkspaceProject,
  createWorkspaceProjectSchema,
  type ProjectSetupError,
  type RemoteRepository,
  type RemoteSourceReadiness,
  type WorkspaceProjectRegistration,
} from '@/shared/schemas/workspace-projects.js'
import type { WorkspaceStoreError } from '@/shared/schemas/workspace-store.js'

type SetupFailure = ProjectSetupError | CheckoutResolverError | WorkspaceStoreError

export class WorkspaceProjectSetup extends Context.Service<
  WorkspaceProjectSetup,
  {
    readonly create: (request: CreateWorkspaceProject) => Effect.Effect<WorkspaceProjectRegistration, SetupFailure>
    readonly clone: (request: CloneWorkspaceProject) => Effect.Effect<WorkspaceProjectRegistration, SetupFailure>
    readonly lookupGitHubRepository: (repository: string) => Effect.Effect<RemoteRepository, ProjectSetupError>
    readonly readiness: Effect.Effect<RemoteSourceReadiness>
  }
>()('watchtower/core/application/WorkspaceProjectSetup') {}

const invalid = () => new CheckoutResolverError({ code: 'invalid-input', message: 'Project setup is invalid.' })

/** Folder preparation runs before registration and is safe to repeat under the same command ID:
 * the provisioner skips `git init` in a repository, a clone already holding that source, and an existing `origin`.
 */
export const WorkspaceProjectSetupLive = Layer.effect(
  WorkspaceProjectSetup,
  Effect.gen(function* () {
    const projects = yield* WorkspaceProjects
    const provisioner = yield* ProjectProvisioner

    const create = Effect.fn('WorkspaceProjectSetup.create')(function* (input: CreateWorkspaceProject) {
      const { publish, ...registration } = yield* Schema.decodeUnknownEffect(createWorkspaceProjectSchema)(input).pipe(
        Effect.mapError(invalid),
      )
      yield* provisioner.initialize(registration.path)
      if (publish === 'github-private') yield* provisioner.publishToGitHub(registration.path, registration.name)
      return yield* projects.register(registration)
    })

    const clone = Effect.fn('WorkspaceProjectSetup.clone')(function* (input: CloneWorkspaceProject) {
      const { source, ...registration } = yield* Schema.decodeUnknownEffect(cloneWorkspaceProjectSchema)(input).pipe(
        Effect.mapError(invalid),
      )
      yield* provisioner.clone(source, registration.path)
      return yield* projects.register(registration)
    })

    return WorkspaceProjectSetup.of({
      create,
      clone,
      lookupGitHubRepository: provisioner.lookupGitHubRepository,
      readiness: provisioner.readiness,
    })
  }),
)
