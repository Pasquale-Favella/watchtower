import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'

import { ScanSources } from '../../core/ports/ingestion.js'
import { Env } from '../config/environment.js'
import { OperationalLog } from '../logging/operational-log.js'
import { HttpFetch } from './fetch-utils.js'
import { runScan } from './scan.js'

export const ScanSourcesLive = Layer.effect(
  ScanSources,
  Effect.gen(function* () {
    const env = yield* Env
    const log = yield* OperationalLog
    const http = yield* HttpFetch
    const fs = yield* FileSystem.FileSystem
    return ScanSources.of({
      run: (...args) =>
        runScan(...args).pipe(
          Effect.provideService(Env, env),
          Effect.provideService(OperationalLog, log),
          Effect.provideService(HttpFetch, http),
          Effect.provideService(FileSystem.FileSystem, fs),
        ),
    })
  }),
)
