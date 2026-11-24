import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'

import { CheckoutResolver } from '@/core/ports/checkout-resolver.js'
import type { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { projectIdSchema, workspaceCheckoutIdSchema } from '@/shared/schemas/workspace.js'
import { WorkspaceStoreError } from '@/shared/schemas/workspace-store.js'

/** The fixed id of the hidden Coach project; `ensureCoachProject` registers it under this id. */
export const COACH_PROJECT_ID = projectIdSchema.make('workspace-coach-project')
export const COACH_CHECKOUT_ID = workspaceCheckoutIdSchema.make('workspace-coach-checkout')

/**
 * Registers the hidden Coach project over a plain managed folder. It never runs Git: the folder is a 'directory'
 * checkout without a repository identity, even inside an enclosing repository. A Git-backed record from an earlier
 * install (kind 'main' with an identity) is accepted as it is, and its folder is left alone.
 */
export const ensureCoachProject = Effect.fn('ensureCoachProject')(function* (
  store: WorkspaceStore['Service'],
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem
  const resolver = yield* CheckoutResolver
  const existing = yield* store
    .getProject(COACH_PROJECT_ID)
    .pipe(Effect.catch(error => (error.code === 'not-found' ? Effect.succeed(null) : Effect.fail(error))))
  const invalidIdentity = new WorkspaceStoreError({
    code: 'membership-conflict',
    message: 'Chat checkout identity is invalid.',
  })
  if (existing && (!existing.project.isCoach || existing.mainCheckout.id !== COACH_CHECKOUT_ID))
    return yield* invalidIdentity
  yield* fs.makeDirectory(directory, { recursive: true })
  // Directory mode canonicalizes the folder without invoking Git.
  const root = (yield* resolver.resolve(directory, 'directory')).canonicalPath
  if (existing) {
    if (existing.mainCheckout.path !== root) return yield* invalidIdentity
    return {
      commandId: `internal:registerProject:${COACH_PROJECT_ID}`,
      project: existing.project,
      mainCheckout: existing.mainCheckout,
      replayed: true,
      reused: true,
    }
  }
  const at = DateTime.formatIso(yield* DateTime.now)
  return yield* store.registerProject({
    project: { id: COACH_PROJECT_ID, name: 'Coach', isCoach: true, createdAt: at, updatedAt: at },
    mainCheckout: { id: COACH_CHECKOUT_ID, kind: 'directory', path: root, createdAt: at },
  })
})

/** Call once during application startup, before the first Workspace request. */
export const sweepCoachChats = (store: WorkspaceStore['Service']) => store.sweepCoachChats()
