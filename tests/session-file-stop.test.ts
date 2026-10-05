import { beforeEach, describe, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({ stat: vi.fn(), readFile: vi.fn() }))
vi.mock('fs/promises', () => ({ stat: io.stat, readFile: io.readFile }))

import { MAX_SESSION_FILE_BYTES, readSessionFile } from '../src/main/pipeline/fs-utils.js'
import { ScanAbortedError } from '../src/main/pipeline/scan-control.js'
import { deferred } from './helpers/deferred.js'

beforeEach(() => {
  io.stat.mockReset().mockResolvedValue({ size: 10 })
  io.readFile.mockReset().mockResolvedValue('session')
})

describe('session file stop', () => {
  it('does not touch the filesystem after a pre-abort', async () => {
    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'scan aborted' })
    controller.abort(abort)
    await expect(readSessionFile('/session', 'utf-8', { signal: controller.signal })).rejects.toBe(abort)
    expect(io.stat).not.toHaveBeenCalled()
    expect(io.readFile).not.toHaveBeenCalled()
  })

  it('waits for pending stat to settle, then stops before reading', async () => {
    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'scan aborted' })
    const pending = deferred<{ size: number }>()
    io.stat.mockReturnValue(pending.promise)
    const result = readSessionFile('/session', 'utf-8', { signal: controller.signal })
    const rejected = expect(result).rejects.toBe(abort)
    controller.abort(abort)
    pending.resolve({ size: 10 })
    await rejected
    expect(io.readFile).not.toHaveBeenCalled()
  })

  it('passes the native read signal and preserves the scan error after the read drains', async () => {
    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'scan aborted' })
    const started = deferred<undefined>()
    const drained = deferred<undefined>()
    io.readFile.mockImplementation(async (_path: string, options: { encoding: string; signal: AbortSignal }) => {
      expect(options.encoding).toBe('latin1')
      expect(options.signal).toBe(controller.signal)
      started.resolve(undefined)
      await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once: true }))
      await drained.promise
      throw new Error('native read aborted')
    })
    const result = readSessionFile('/session', 'latin1', { signal: controller.signal })
    const settled = vi.fn()
    void result.then(settled, settled)
    const rejected = expect(result).rejects.toBe(abort)
    await started.promise
    controller.abort(abort)
    await Promise.resolve(undefined)
    expect(settled).not.toHaveBeenCalled()
    drained.resolve(undefined)
    await rejected
    expect(settled).toHaveBeenCalledOnce()
  })

  it('does not return a successful read completed after stop', async () => {
    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'scan aborted' })
    io.readFile.mockImplementation(async () => {
      controller.abort(abort)
      return 'late session'
    })
    await expect(readSessionFile('/session', 'utf-8', { signal: controller.signal })).rejects.toBe(abort)
  })

  it('retains default decoding and ordinary missing or oversized file behavior', async () => {
    await expect(readSessionFile('/session')).resolves.toBe('session')
    expect(io.readFile).toHaveBeenCalledWith('/session', { encoding: 'utf-8', signal: undefined })
    io.stat.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    await expect(readSessionFile('/missing')).resolves.toBeNull()
    io.stat.mockResolvedValueOnce({ size: MAX_SESSION_FILE_BYTES + 1 })
    await expect(readSessionFile('/oversized')).resolves.toBeNull()
    expect(io.readFile).toHaveBeenCalledOnce()
  })
})
