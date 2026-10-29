import { parentPort, workerData } from 'node:worker_threads'

import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'

import { dbWorkerServerProgram } from './bootstrap.js'
import type { DbWorkerData } from './protocol.js'

/** Electron-free worker-thread entry; the transport and server own the protocol lifecycle. */
if (!parentPort) throw new Error('db-worker must run on a worker thread')

Effect.runPromiseExit(dbWorkerServerProgram(workerData as DbWorkerData, Effect.runPromise)).then(exit => {
  if (exit._tag === 'Failure' && !Cause.hasInterruptsOnly(exit.cause)) {
    process.exitCode = 1
  }
})
