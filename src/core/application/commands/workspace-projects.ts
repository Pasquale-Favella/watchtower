import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'

import { CheckoutResolver } from '@/core/ports/checkout-resolver.js'
import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { CheckoutResolverError } from '@/shared/schemas/checkout.js'
import {
  CHOOSE_LOCAL_PROJECT_FOLDER,
  type RegisterProjectWithPreparation,
  type RegisterWorkspaceProject,
  registerWorkspaceProjectSchema,
  type WorkspaceProjectRegistration,
} from '@/shared/schemas/workspace-projects.js'
import { WorkspaceStoreError } from '@/shared/schemas/workspace-store.js'

export class WorkspaceProjects extends Context.Service<
  WorkspaceProjects,
  {
    readonly register: (
      request: RegisterWorkspaceProject,
    ) => Effect.Effect<WorkspaceProjectRegistration, CheckoutResolverError | WorkspaceStoreError>
  }
>()('watchtower/core/application/WorkspaceProjects') {}

/** Registration keeps filesystem resolution separate from project persistence. */
export const WorkspaceProjectsLive = Layer.effect(
  WorkspaceProjects,
  Effect.gen(function* () {
    const resolver = yield* CheckoutResolver
    const store = yield* WorkspaceStore
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
    return WorkspaceProjects.of({ register })
  }),
)
