import * as Effect from 'effect/Effect'

import type { ProjectId, TaskId, WorkspaceCheckoutId } from '@/shared/schemas/workspace.js'

import { WorkspaceHost } from './host.js'

/** Why a checkout could not be resolved; callers map it onto their own fixed RPC errors. */
export type CheckoutPathFailure = 'not-found' | 'unavailable'

/** Resolves a Project checkout (its main checkout when unnamed) to its stored path. Archived records do not resolve. */
export const resolveCheckoutPath = Effect.fnUntraced(function* (request: {
  readonly projectId: ProjectId
  readonly checkoutId?: WorkspaceCheckoutId | undefined
}) {
  const host = yield* WorkspaceHost
  const detail = yield* host.ensureOpen.pipe(
    Effect.andThen(Effect.suspend(() => host.store.getProject(request.projectId))),
    Effect.mapError((): CheckoutPathFailure => 'unavailable'),
  )
  if (!detail || detail.project.archivedAt) return yield* Effect.fail<CheckoutPathFailure>('not-found')
  const checkoutId = request.checkoutId ?? detail.mainCheckout.id
  const checkout = [detail.mainCheckout, ...detail.otherCheckouts].find(
    item => item.id === checkoutId && !item.archivedAt,
  )
  if (!checkout) return yield* Effect.fail<CheckoutPathFailure>('not-found')
  return checkout.path
})

/** Uses the requested checkout during first submission, then the most recent Run's checkout. */
export const resolveTaskCheckoutPath = Effect.fnUntraced(function* (
  taskId: TaskId,
  requestedCheckoutId?: WorkspaceCheckoutId,
) {
  const host = yield* WorkspaceHost
  const detail = yield* host.ensureOpen.pipe(
    Effect.andThen(Effect.suspend(() => host.store.readTaskDetail(taskId, { limit: 1 }))),
    Effect.mapError((): CheckoutPathFailure => 'unavailable'),
  )
  if (!detail || detail.task.archivedAt) return yield* Effect.fail<CheckoutPathFailure>('not-found')
  let checkoutId = requestedCheckoutId
  if (!checkoutId) {
    const snapshot = yield* host.store
      .readTaskSnapshot(taskId, 1)
      .pipe(Effect.mapError((): CheckoutPathFailure => 'unavailable'))
    const lastRun = snapshot.runs[0]
    checkoutId = snapshot.runContexts?.find(context => context.runId === lastRun?.id)?.checkoutId
  }
  return yield* resolveCheckoutPath({ projectId: detail.task.projectId, ...(checkoutId ? { checkoutId } : {}) })
})
