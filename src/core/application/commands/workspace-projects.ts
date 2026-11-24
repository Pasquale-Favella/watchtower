import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'

import { CheckoutResolver } from '@/core/ports/checkout-resolver.js'
import { ProjectProvisioner } from '@/core/ports/project-provisioner.js'
import { convertDirectoryProject, WorkspaceStore } from '@/core/ports/workspace-store.js'
import { CheckoutResolverError } from '@/shared/schemas/checkout.js'
import {
  CHOOSE_LOCAL_PROJECT_FOLDER,
  MANAGED_PROJECT_FOLDER,
  ProjectSetupError,
  type RegisterProjectWithPreparation,
  type RegisterWorkspaceProject,
  registerWorkspaceProjectSchema,
  type WorkspaceProjectRegistration,
} from '@/shared/schemas/workspace-projects.js'
import { type InitializeProjectGitRequest, WorkspaceStoreError } from '@/shared/schemas/workspace-store.js'

export class WorkspaceProjects extends Context.Service<
  WorkspaceProjects,
  {
    readonly register: (
      request: RegisterWorkspaceProject,
    ) => Effect.Effect<WorkspaceProjectRegistration, CheckoutResolverError | WorkspaceStoreError>
    readonly initializeGit: (
      request: InitializeProjectGitRequest,
    ) => Effect.Effect<WorkspaceProjectRegistration, CheckoutResolverError | WorkspaceStoreError | ProjectSetupError>
  }
>()('watchtower/core/application/WorkspaceProjects') {}

/** Registration keeps filesystem resolution separate from project persistence. */
export const WorkspaceProjectsLive = Layer.effect(
  WorkspaceProjects,
  Effect.gen(function* () {
    const resolver = yield* CheckoutResolver
    const store = yield* WorkspaceStore
    const provisioner = yield* ProjectProvisioner
    const gitInitialization = yield* Semaphore.make(1)
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const register = Effect.fn('WorkspaceProjects.register')(function* (input: RegisterWorkspaceProject) {
      const request = yield* Schema.decodeUnknownEffect(registerWorkspaceProjectSchema)(input).pipe(
        Effect.mapError(
          () => new CheckoutResolverError({ code: 'invalid-input', message: 'Project registration is invalid.' }),
        ),
      )
      if (request.createIfMissing && /^[\\/]{2}/.test(request.path))
        return yield* new CheckoutResolverError({ code: 'not-local-folder', message: CHOOSE_LOCAL_PROJECT_FOLDER })
      if (!path.isAbsolute(request.path))
        return yield* new CheckoutResolverError({ code: 'invalid-input', message: 'Choose an absolute folder path.' })

      const selected = yield* resolver.resolve(request.path, 'registration').pipe(
        Effect.catch(error => {
          if (error.code === 'not-a-directory')
            return Effect.fail(new CheckoutResolverError({ code: error.code, message: 'This path is not a folder.' }))
          if (error.code !== 'path-missing') return Effect.fail(error)
          if (!request.createIfMissing)
            return Effect.fail(new CheckoutResolverError({ code: error.code, message: 'This folder does not exist.' }))
          return Effect.succeed(null)
        }),
      )
      const main = selected?.kind === 'worktree' ? yield* resolver.resolve(selected.mainCheckoutPath) : selected
      if (
        selected?.kind === 'worktree' &&
        (main?.kind !== 'main' || main.repositoryIdentity !== selected.repositoryIdentity)
      ) {
        return yield* new CheckoutResolverError({
          code: 'worktree-conflict',
          message: 'The selected checkout no longer matches its main repository.',
        })
      }
      const at = DateTime.formatIso(yield* DateTime.now)
      const project = {
        id: request.projectId,
        name: request.name,
        repositoryIdentity: main?.repositoryIdentity ?? undefined,
        createdAt: at,
        updatedAt: at,
      }
      const directory = main?.canonicalPath ?? path.resolve(request.path)
      const command: RegisterProjectWithPreparation = {
        commandId: request.commandId,
        project,
        mainCheckout: {
          id: request.checkoutId,
          kind: !main || main.kind === 'directory' ? 'directory' : 'main',
          path: directory,
          branch: main?.branch ?? undefined,
          createdAt: at,
        },
        prepareDirectory: main
          ? undefined
          : Effect.suspend(() =>
              fs.makeDirectory(directory, { recursive: true }).pipe(
                Effect.andThen(() => resolver.resolve(directory, 'directory')),
                Effect.map(checkout => checkout.canonicalPath),
                Effect.mapError(
                  () => new WorkspaceStoreError({ code: 'database-unavailable', message: 'Cannot create the folder.' }),
                ),
              ),
            ),
      }
      return yield* store.registerProject(command)
    })
    const initializeGit = Effect.fn('WorkspaceProjects.initializeGit')(function* (
      request: InitializeProjectGitRequest,
    ) {
      const { project, mainCheckout } = yield* store.getProject(request.projectId, { limit: 1 })
      const replay = yield* convertDirectoryProject(store, request).pipe(
        Effect.catch(error => (error.code === 'not-found' ? Effect.succeed(null) : Effect.fail(error))),
      )
      if (replay) return replay
      if (project.isScratch || project.isCoach)
        return yield* new WorkspaceStoreError({ code: 'membership-conflict', message: MANAGED_PROJECT_FOLDER })
      if (project.archivedAt || mainCheckout.archivedAt)
        return yield* new WorkspaceStoreError({ code: 'membership-conflict', message: 'This project is archived.' })
      if (mainCheckout.kind !== 'directory') return yield* ProjectSetupError.of('already-git')

      const target = mainCheckout.path
      const before = yield* resolver.resolve(target, 'registration')
      if (before.canonicalPath !== target || (before.kind !== 'directory' && before.mainCheckoutPath !== target))
        return yield* ProjectSetupError.of('checkout-root-mismatch')
      if (before.kind === 'directory') yield* provisioner.initializeInPlace(target)
      const resolved = yield* resolver.resolve(target)
      if (
        resolved.kind !== 'main' ||
        resolved.mainCheckoutPath !== target ||
        resolved.canonicalPath !== target ||
        resolved.repositoryIdentity === null
      ) {
        return yield* ProjectSetupError.of('checkout-root-mismatch')
      }
      return yield* convertDirectoryProject(store, {
        ...request,
        repository: {
          path: target,
          identity: resolved.repositoryIdentity,
          branch: resolved.branch ?? undefined,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        },
      })
    }, gitInitialization.withPermit)

    return WorkspaceProjects.of({ register, initializeGit })
  }),
)
