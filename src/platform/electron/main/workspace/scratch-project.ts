import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'

import {
  resolveScratchRoot,
  SCRATCH_PROJECT_ID,
  SCRATCH_ROOT_CHECKOUT_ID,
} from '@/core/application/commands/scratch-checkouts.js'
import { CheckoutResolver } from '@/core/ports/checkout-resolver.js'
import type { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { WorkspaceStoreError } from '@/shared/schemas/workspace-store.js'

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
