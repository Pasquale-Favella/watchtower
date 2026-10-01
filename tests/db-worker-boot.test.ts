import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { expect, it, vi } from 'vitest'

const boot = vi.hoisted(() => ({
  init: { dbPath: '', dataDir: '', cacheDir: '' },
  postMessage: vi.fn<(message: unknown) => void>(),
  on: vi.fn(),
  construct: vi.fn(),
}))

vi.mock('node:worker_threads', () => ({
  workerData: boot.init,
  parentPort: { postMessage: boot.postMessage, on: boot.on },
}))

vi.mock('../src/main/db-worker/context.js', () => ({
  DbWorkerContext: function DbWorkerContext(): never {
    boot.construct()
    throw new Error('controlled context-construction failure')
  },
}))

it('closes the real driver and reports the original error if worker context construction fails', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-worker-boot-'))
  boot.init.dbPath = join(directory, 'ledger.db')
  boot.init.dataDir = directory
  boot.init.cacheDir = join(directory, 'cache')
  const previousExitCode = process.exitCode
  const close = vi.spyOn(DatabaseSync.prototype, 'close')
  try {
    await import('../src/main/db-worker/entry.js')
    expect(boot.construct).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(boot.postMessage).toHaveBeenCalledWith({
      event: 'init-error',
      error: 'controlled context-construction failure',
    })
    expect(boot.postMessage).not.toHaveBeenCalledWith({ event: 'ready' })
    expect(boot.on).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  } finally {
    process.exitCode = previousExitCode
    vi.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
  }
})
