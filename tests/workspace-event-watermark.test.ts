import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'

import type { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { withEventWatermark } from '@/platform/electron/main/workspace/event-watermark.js'

const recordingStore = (calls: Array<string>) =>
  ({
    promoteNextFollowUp: () =>
      Effect.sync(() => {
        calls.push('promoteNextFollowUp')
        return null
      }),
    failDispatch: () =>
      Effect.sync(() => {
        calls.push('failDispatch')
      }),
    beginRun: () =>
      Effect.sync(() => {
        calls.push('beginRun')
        return { replayed: false }
      }),
    listDelegations: () =>
      Effect.sync(() => {
        calls.push('listDelegations')
        return { items: [] }
      }),
  }) as unknown as WorkspaceStore['Service']

const advance = (calls: Array<string>) =>
  Effect.sync(() => {
    calls.push('advance')
  })

describe('withEventWatermark', () => {
  it('advances the watermark after a promoted Run and a failed launch commit their events', async () => {
    const calls: Array<string> = []
    const store = withEventWatermark(recordingStore(calls), advance(calls))
    await Effect.runPromise(store.promoteNextFollowUp('conversation' as never, {} as never))
    await Effect.runPromise(store.failDispatch('run' as never, {} as never))
    expect(calls).toEqual(['promoteNextFollowUp', 'advance', 'failDispatch', 'advance'])
  })

  it('leaves the watermark alone for other writes, reads, and a launch failure that did not commit', async () => {
    const calls: Array<string> = []
    const failing = {
      ...recordingStore(calls),
      failDispatch: () =>
        Effect.sync(() => calls.push('failDispatch')).pipe(Effect.andThen(Effect.fail(new Error('rejected')))),
    } as unknown as WorkspaceStore['Service']
    const store = withEventWatermark(failing, advance(calls))
    await Effect.runPromise(store.beginRun({} as never))
    await Effect.runPromise(store.listDelegations({} as never))
    await expect(Effect.runPromise(store.failDispatch('run' as never, {} as never))).rejects.toThrow('rejected')
    expect(calls).toEqual(['beginRun', 'listDelegations', 'failDispatch'])
  })
})
