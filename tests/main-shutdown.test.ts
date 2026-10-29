import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import { describe, expect, it } from 'vitest'

import { closeMainResources } from '../src/platform/electron/main/quit-coordinator.js'

describe('main resource shutdown', () => {
  it('keeps the runtime available for final worker events after Coach has stopped', async () => {
    const runtime = ManagedRuntime.make(Layer.empty)
    let finishWorker!: () => void
    const worker = new Promise<void>(resolve => {
      finishWorker = resolve
    })
    const order: string[] = []
    const closing = closeMainResources({
      stopCoach: async () => {
        order.push('coach')
      },
      stopWorker: async () => {
        await worker
        order.push(runtime.runSync(Effect.succeed('worker-final-event')))
      },
      disposeRuntime: async () => {
        order.push('runtime')
        await runtime.dispose()
      },
    })
    await Promise.resolve()
    expect(order).toEqual(['coach'])
    finishWorker()
    await closing
    expect(order).toEqual(['coach', 'worker-final-event', 'runtime'])
    expect(() => runtime.runSync(Effect.void)).toThrow('ManagedRuntime disposed')
  })

  it('still drains the worker and disposes once when another producer fails synchronously', async () => {
    let finishWorker!: () => void
    const worker = new Promise<void>(resolve => {
      finishWorker = resolve
    })
    const order: string[] = []
    const closing = closeMainResources({
      stopCoach: () => {
        throw new Error('private producer failure')
      },
      stopWorker: async () => {
        await worker
        order.push('worker')
      },
      disposeRuntime: async () => {
        order.push('runtime')
      },
    }).catch(error => error)
    await Promise.resolve()
    expect(order).toEqual([])
    finishWorker()
    await expect(closing).resolves.toEqual(new Error('Shutdown failed'))
    expect(order).toEqual(['worker', 'runtime'])
  })
})
