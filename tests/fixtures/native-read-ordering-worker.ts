import { parentPort, workerData } from 'node:worker_threads'

import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'

import { DbWorkerContext } from '../../src/main/db-worker/context.js'
import type { DbWorkerData, DbWorkerRequest } from '../../src/main/db-worker/protocol.js'
import { LedgerViewReads } from '../../src/main/store/ledger-view-reads.js'
import { buildFixtureCachedFile, FIXTURE_SOURCE_PATH } from './cached-file.js'
import { openWorkerOwner } from './worker-owner.js'

const port = parentPort
if (!port) throw new Error('native read-ordering fixture must run on a worker thread')

const init = workerData as DbWorkerData
const owner = openWorkerOwner(init.dbPath)
owner.ledger.portIn({
  provider: 'opencode',
  envFingerprint: 'native-read-ordering',
  filePath: FIXTURE_SOURCE_PATH,
  verdict: 'new',
  cachedFile: buildFixtureCachedFile(),
})

// Decorate the real repository read inside this fixture worker. The SQL read
// and transaction complete first; only its result delivery is held for the
// parent to coordinate with a config write.
const reads = owner.runtime.runSync(LedgerViewReads)
const getViewData = reads.getViewData.bind(reads)
const snapshotGate = Deferred.makeUnsafe<undefined, never>()
reads.getViewData = () =>
  getViewData().pipe(
    Effect.flatMap(data =>
      Effect.sync(() =>
        port.postMessage({ fixture: 'snapshot-ready', aliases: data.aliases, overrides: data.overrides }),
      ).pipe(Effect.andThen(Deferred.await(snapshotGate)), Effect.as(data)),
    ),
  )

const context = new DbWorkerContext(init, event => port.postMessage(event), owner)
port.on('message', (raw: unknown) => {
  if (raw && typeof raw === 'object' && 'fixtureControl' in raw) {
    if ((raw as { fixtureControl: unknown }).fixtureControl === 'releaseSnapshot') {
      void Effect.runPromise(Deferred.succeed(snapshotGate, undefined))
    }
    return
  }
  const request = raw as DbWorkerRequest
  void context.dispatch(request.op, request.args).then(
    data => port.postMessage({ id: request.id, ok: true, data }),
    error =>
      port.postMessage({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
  )
})

port.postMessage({ event: 'ready' })
