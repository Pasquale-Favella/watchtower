import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'

import type { WorkspaceStore } from '@/core/ports/workspace-store.js'

/**
 * Writes that commit a run event no driver event will publish: a queued follow-up promoted into a Run (`runQueued`),
 * and a Run failed before its driver accepted it (`runFailed`). Without the watermark moving, the event stream and the
 * conversation reads it bounds hide them until a later driver event moves it.
 */
const WATERMARK_WRITES: ReadonlySet<string> = new Set(['promoteNextFollowUp', 'failDispatch'])

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
