import { parentPort, workerData } from 'node:worker_threads'

import * as Effect from 'effect/Effect'

import { initAppPaths } from '../env.js'
import { openWorkerOwner } from '../worker-runtime.js'
import { DbWorkerContext } from './context.js'
import { makeWorkerOperationalLogSink } from './operational-log-sink.js'
import type { DbWorkerData, DbWorkerRequest, DbWorkerResponse } from './protocol.js'

/**
 * The db-worker thread entry (ADR 0023) — emitted as `out/main/db-worker.js`
 * next to the app bundle. Owns the ledger, the scan pipeline, and every
 * query-time view builder; the main process forwards renderer IPC here as
 * `{ id, op, args }` requests and relays the emitted broadcasts to windows.
 *
 * Electron-free by construction (only node builtins + the app's own
 * electron-free data layer), so it runs identically in dev (`out/` tree) and
 * in the packaged asar.
 */

const port = parentPort
if (!port) throw new Error('db-worker must run on a worker thread')

const init = workerData as DbWorkerData

// Boot handshake: the client resolves `ready` on the event below and rejects
// on `init-error`. A worker that cannot own its ledger (bad path, unopenable
// DB) reports and exits instead of serving errors forever — the client never
// respawns a worker that never lived.
try {
  // The sync discovery paths (provider homes, platform roots, caches) still
  // arrive via `init` — captured as the `AppPaths` startup snapshot instead of
  // ambient env mutation. Only `cacheDir` is threaded today; the rest fall
  // back to the same pure resolvers the `process.env` readers already use.
  initAppPaths({ cacheDir: init.cacheDir })

  const logSink = makeWorkerOperationalLogSink(event => port.postMessage(event))
  const owner = openWorkerOwner(init.dbPath, logSink)
  let ctx: DbWorkerContext
  try {
    ctx = new DbWorkerContext(init, event => port.postMessage(event), owner)
  } catch (error) {
    try {
      Effect.runSync(owner.runtime.disposeEffect)
    } catch {
      // Keep the context-construction failure as the boot error.
    }
    throw error
  }

  // Deliberately no dispatch queue: every ledger call is synchronous
  // (`node:sqlite`), so each one is atomic — no two store operations can
  // interleave mid-call on this thread, and no transaction is ever held
  // across an await. Serializing whole ops would stall reads behind
  // minute-long scans, reintroducing the freeze this worker exists to remove.
  // The one cross-op race (clear mid-scan) self-heals: portIn treats a
  // source missing from the ledger as a first port, so the running scan
  // backfills what the clear deleted.
  port.on('message', (raw: unknown) => {
    const req = raw as DbWorkerRequest
    void ctx.dispatch(req.op, req.args).then(
      data => port.postMessage({ id: req.id, ok: true, data } satisfies DbWorkerResponse),
      err =>
        port.postMessage({
          id: req.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        } satisfies DbWorkerResponse),
    )
  })

  port.postMessage({ event: 'ready' })
} catch (err) {
  port.postMessage({ event: 'init-error', error: err instanceof Error ? err.message : String(err) })
  process.exitCode = 1
}
