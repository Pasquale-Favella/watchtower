import { Effect, Exit, Fiber } from 'effect'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'

import { ScanAbortedError } from '../src/main/pipeline/scan-control.js'
import { readDirectoryOrEmpty, scanIo } from '../src/main/pipeline/scan-io.js'
import { deferred } from './helpers/deferred.js'

describe('scan native IO ownership', () => {
  it('does not start a leaf after caller abort', async () => {
    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'scan aborted' })
    controller.abort(abort)
    const operation = vi.fn(async () => 'value')
    await expect(Effect.runPromise(scanIo(operation, controller.signal))).rejects.toBe(abort)
    expect(operation).not.toHaveBeenCalled()
  })

  it('drains a pending leaf before caller abort and retains its exact reason', async () => {
    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'scan aborted' })
    const started = deferred<undefined>()
    const released = deferred<undefined>()
    const settled = vi.fn()
    const result = Effect.runPromise(
      scanIo(async () => {
        started.resolve(undefined)
        await released.promise
        settled()
        return 'late value'
      }, controller.signal),
    )
    const rejection = expect(result).rejects.toBe(abort)
    await started.promise
    controller.abort(abort)
    expect(settled).not.toHaveBeenCalled()
    released.resolve(undefined)
    await rejection
    expect(settled).toHaveBeenCalledOnce()
  })

  it('drains pending native work before fiber interruption finishes', async () => {
    const started = deferred<undefined>()
    const released = deferred<undefined>()
    const settled = vi.fn()
    const fiber = Effect.runFork(
      scanIo(async () => {
        started.resolve(undefined)
        await released.promise
        settled()
        return 'value'
      }),
    )
    await started.promise
    const interruption = Effect.runFork(Fiber.interrupt(fiber))
    await Effect.runPromise(Effect.yieldNow)
    expect(settled).not.toHaveBeenCalled()
    expect(fiber.pollUnsafe()).toBeUndefined()
    released.resolve(undefined)
    await Effect.runPromise(Fiber.join(interruption))
    expect(settled).toHaveBeenCalledOnce()
    expect(Exit.isFailure(await Effect.runPromise(Fiber.await(fiber)))).toBe(true)
  })

  it('retains native success and error identity', async () => {
    await expect(Effect.runPromise(scanIo(async () => 42))).resolves.toBe(42)
    const failure = new Error('native failure')
    await expect(
      Effect.runPromise(
        scanIo(async () => {
          throw failure
        }),
      ),
    ).rejects.toBe(failure)
  })

  it('uses an empty directory fallback for read errors and preserves caller aborts', async () => {
    const missingPath = join(tmpdir(), `watchtower-scan-io-missing-${process.pid}-${Date.now()}`)
    await expect(Effect.runPromise(readDirectoryOrEmpty(missingPath))).resolves.toEqual([])

    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'scan aborted' })
    controller.abort(abort)
    await expect(Effect.runPromise(readDirectoryOrEmpty(missingPath, controller.signal))).rejects.toBe(abort)
  })
})
