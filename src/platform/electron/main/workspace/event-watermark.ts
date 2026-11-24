import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'

import type { WorkspaceStore } from '@/core/ports/workspace-store.js'

/**
 * Promote, claim and launch failure commit events before the driver publishes anything. Advance the watermark so
 * the renderer can see those events and refresh the Delegation status when its child is claimed.
 */
const WATERMARK_WRITES: ReadonlySet<string> = new Set(['promoteNextFollowUp', 'claimDispatch', 'failDispatch'])

export function withEventWatermark(
  store: WorkspaceStore['Service'],
  advance: Effect.Effect<void>,
): WorkspaceStore['Service'] {
  return new Proxy(store, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key)
      if (typeof key !== 'string' || typeof value !== 'function' || !WATERMARK_WRITES.has(key)) return value
      const operation = value as (...args: Array<unknown>) => Effect.Effect<unknown, unknown>
      return (...args: Array<unknown>) =>
        operation.apply(target, args).pipe(Effect.onExit(exit => (Exit.isSuccess(exit) ? advance : Effect.void)))
    },
  })
}
