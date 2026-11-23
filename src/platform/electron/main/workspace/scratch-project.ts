import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'

import {
  resolveScratchRoot,
  SCRATCH_PROJECT_ID,
  SCRATCH_ROOT_CHECKOUT_ID,
} from '@/core/application/commands/scratch-checkouts.js'
import { CheckoutResolver } from '@/core/ports/checkout-resolver.js'
import type { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { projectIdSchema, workspaceCheckoutIdSchema } from '@/shared/schemas/workspace.js'
import { WorkspaceStoreError } from '@/shared/schemas/workspace-store.js'

/** The fixed id a managed chat project (scratch or Coach) is registered under. */
export const managedChatProjectId = (kind: 'scratch' | 'coach') =>
  Schema.decodeUnknownSync(projectIdSchema)(`workspace-${kind}-project`)

export const ensureManagedChatProject = Effect.fn('ensureManagedChatProject')(function* (
  store: WorkspaceStore['Service'],
  directory: string,
  kind: 'coach',
) {
  const projectId = managedChatProjectId(kind)
  const checkoutId = workspaceCheckoutIdSchema.make(`workspace-${kind}-checkout`)
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const resolver = yield* CheckoutResolver
  const existing = yield* store
    .getProject(projectId)
    .pipe(Effect.catch(error => (error.code === 'not-found' ? Effect.succeed(null) : Effect.fail(error))))
  if (existing) {
    const checkout = existing.project.isCoach ? yield* resolver.resolve(directory) : null
    if (
      existing.mainCheckout.id !== checkoutId ||
      checkout?.kind !== 'main' ||
      existing.mainCheckout.path !== checkout.canonicalPath ||
      existing.project.repositoryIdentity !== checkout.repositoryIdentity
    )
      return yield* new WorkspaceStoreError({
        code: 'membership-conflict',
        message: 'Chat checkout identity is invalid.',
      })
    return {
      commandId: `internal:registerProject:${projectId}`,
      project: existing.project,
      mainCheckout: existing.mainCheckout,
      replayed: true,
      reused: true,
    }
  }
  yield* fs.makeDirectory(directory, { recursive: true })
  yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make('git', ['init', '--quiet', '--', directory], {
          windowsHide: true,
          stdout: 'pipe',
          stderr: 'pipe',
          extendEnv: true,
          env: {
            GIT_DIR: undefined,
            GIT_WORK_TREE: undefined,
            GIT_COMMON_DIR: undefined,
            GIT_INDEX_FILE: undefined,
            GIT_OBJECT_DIRECTORY: undefined,
            GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
          },
        }),
      )
      yield* Effect.forkScoped(Stream.runDrain(handle.stdout))
      yield* Effect.forkScoped(Stream.runDrain(handle.stderr))
      const code = yield* handle.exitCode
      if (code !== 0)
        return yield* new WorkspaceStoreError({
          code: 'database-unavailable',
          message: 'Chat checkout is unavailable.',
        })
    }),
  ).pipe(Effect.timeout('10 seconds'))
  const checkout = yield* resolver.resolve(directory)
  if (checkout.kind !== 'main' || checkout.mainCheckoutPath !== checkout.canonicalPath)
    return yield* new WorkspaceStoreError({
      code: 'membership-conflict',
      message: 'Chat checkout identity is invalid.',
    })
  const at = DateTime.formatIso(yield* DateTime.now)
  return yield* store.registerProject({
    project: {
      id: projectId,
      name: 'Coach',
      repositoryIdentity: checkout.repositoryIdentity,
      isCoach: true,
      createdAt: at,
      updatedAt: at,
    },
    mainCheckout: {
      id: checkoutId,
      kind: 'main',
      path: checkout.canonicalPath,
      branch: checkout.branch ?? undefined,
      createdAt: at,
    },
  })
})

export const ensureScratchProject = Effect.fn('ensureScratchProject')(function* (
  store: WorkspaceStore['Service'],
  directory: string,
) {
  const projectId = SCRATCH_PROJECT_ID
  const fs = yield* FileSystem.FileSystem
  const resolver = yield* CheckoutResolver
  const existing = yield* store
    .getProject(projectId)
    .pipe(Effect.catch(error => (error.code === 'not-found' ? Effect.succeed(null) : Effect.fail(error))))
  const invalidIdentity = new WorkspaceStoreError({
    code: 'membership-conflict',
    message: 'Chat checkout identity is invalid.',
  })
  if (existing && !existing.project.isScratch) return yield* invalidIdentity
  yield* fs.makeDirectory(directory, { recursive: true })
  const legacy = existing?.mainCheckout.kind === 'main'
  const root = yield* resolveScratchRoot(resolver, directory, legacy)
  if (existing) {
    if (existing.mainCheckout.path !== root) return yield* invalidIdentity
    return {
      commandId: `internal:registerProject:${projectId}`,
      project: existing.project,
      mainCheckout: existing.mainCheckout,
      replayed: true,
      reused: true,
    }
  }
  const at = DateTime.formatIso(yield* DateTime.now)
  return yield* store.registerProject({
    project: { id: projectId, name: 'No project', isScratch: true, createdAt: at, updatedAt: at },
    mainCheckout: { id: SCRATCH_ROOT_CHECKOUT_ID, kind: 'directory', path: root, createdAt: at },
  })
})
