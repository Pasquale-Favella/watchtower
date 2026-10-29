import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as RpcTest from 'effect/rpc/RpcTest'
import { expect, it, vi } from 'vitest'

import { createDbWorkerContext } from '../src/platform/electron/workers/bootstrap.js'
import type { DbWorkerData } from '../src/platform/electron/workers/protocol.js'
import { dbWorkerRpcServerLayer } from '../src/platform/electron/workers/rpc-server.js'
import { WorkerRpcError, WorkerRpcGroup } from '../src/shared/rpc/worker.js'

it('closes the real driver and returns a typed safe ready failure if context construction fails', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-worker-boot-'))
  const init: DbWorkerData = {
    dbPath: join(directory, 'ledger.db'),
    dataDir: directory,
    cacheDir: join(directory, 'cache'),
  }
  const previousExitCode = process.exitCode
  const close = vi.spyOn(DatabaseSync.prototype, 'close')
  const construct = vi.fn(() => {
    throw new Error('controlled context-construction failure with a private path')
  })
  const onFatal = vi.fn()
  const layer = dbWorkerRpcServerLayer({
    createContext: emit => Effect.runPromise(createDbWorkerContext(init, emit, { makeContext: construct })),
    onFatal,
  })

  try {
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(WorkerRpcGroup)
      return yield* Effect.exit(client['worker:ready']())
    }).pipe(Effect.scoped, Effect.provide(layer))

    const result = await Effect.runPromise(program)
    expect(construct).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect(onFatal).toHaveBeenCalledOnce()
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      const error = Cause.findError(result.cause)
      expect(error).toMatchObject({
        _tag: 'Success',
        success: new WorkerRpcError({
          code: 'initialization-failed',
          message: 'The database worker operation failed.',
        }),
      })
      expect(JSON.stringify(result)).not.toContain('private')
    }
  } finally {
    process.exitCode = previousExitCode
    vi.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
  }
})
