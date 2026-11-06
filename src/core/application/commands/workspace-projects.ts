import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'

import { CheckoutResolver } from '@/core/ports/checkout-resolver.js'
import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { CheckoutResolverError } from '@/shared/schemas/checkout.js'
import {
  type RegisterWorkspaceProject,
  registerWorkspaceProjectSchema,
  type WorkspaceProjectRegistration,
} from '@/shared/schemas/workspace-projects.js'
import type { WorkspaceStoreError } from '@/shared/schemas/workspace-store.js'

export class WorkspaceProjects extends Context.Service<
  WorkspaceProjects,
  {
    readonly register: (
      request: RegisterWorkspaceProject,
    ) => Effect.Effect<WorkspaceProjectRegistration, CheckoutResolverError | WorkspaceStoreError>
  }
>()('watchtower/core/application/WorkspaceProjects') {}

/** Filesystem identity is resolved before it becomes an operational project record. */
export const WorkspaceProjectsLive = Layer.effect(
  WorkspaceProjects,
  Effect.gen(function* () {
    const resolver = yield* CheckoutResolver
    const store = yield* WorkspaceStore
    const register = Effect.fn('WorkspaceProjects.register')(function* (input: RegisterWorkspaceProject) {
      const request = yield* Schema.decodeUnknownEffect(registerWorkspaceProjectSchema)(input).pipe(
        Effect.mapError(
          () => new CheckoutResolverError({ code: 'invalid-input', message: 'Project registration is invalid.' }),
        ),
      )
      const selected = yield* resolver.resolve(request.path)
      if (selected.kind === 'directory') {
        return yield* new CheckoutResolverError({
          code: 'not-a-repository',
          message: 'Project registration requires a Git repository.',
        })
      }
      const main = selected.kind === 'main' ? selected : yield* resolver.resolve(selected.mainCheckoutPath)
      if (main.kind !== 'main' || main.repositoryIdentity !== selected.repositoryIdentity) {
        return yield* new CheckoutResolverError({
          code: 'worktree-conflict',
          message: 'The selected checkout no longer matches its main repository.',
        })
      }
      const at = DateTime.formatIso(yield* DateTime.now)
      const project = {
        id: request.projectId,
        name: request.name,
        repositoryIdentity: main.repositoryIdentity,
        createdAt: at,
        updatedAt: at,
      }
      const mainCheckout = {
        id: request.checkoutId,
        projectId: request.projectId,
        kind: 'main' as const,
        path: main.canonicalPath,
        branch: main.branch ?? undefined,
        createdAt: at,
      }
      return yield* store.registerProject({ commandId: request.commandId, project, mainCheckout })
    })
    return WorkspaceProjects.of({ register })
  }),
)
