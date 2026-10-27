import * as NodeWorkerRunner from '@effect/platform-node/NodeWorkerRunner'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import { RpcServer, RpcWorker } from 'effect/rpc'
import * as Schema from 'effect/Schema'

import { WorkerRpcGroup } from '../../shared/rpc/worker.js'
import { initAppPaths, readAppPathsEffect } from '../env.js'
import { openWorkerRuntime } from '../worker-runtime.js'
import { DbWorkerContext, type DbWorkerDeps, type DbWorkerEmit } from './context.js'
import { makeWorkerOperationalLogSink } from './operational-log-sink.js'
import type { DbWorkerData } from './protocol.js'
import { dbWorkerRpcServerLayer } from './rpc-server.js'

export interface DbWorkerContextBootstrapDependencies {
  readonly openRuntime: typeof openWorkerRuntime
  readonly makeContext: (init: DbWorkerData, emit: DbWorkerEmit, deps: DbWorkerDeps) => DbWorkerContext
  readonly makeLogSink: typeof makeWorkerOperationalLogSink
}

const defaultDependencies: DbWorkerContextBootstrapDependencies = {
  openRuntime: openWorkerRuntime,
  makeContext: (init, emit, deps) => new DbWorkerContext(init, emit, deps),
  makeLogSink: makeWorkerOperationalLogSink,
}

/** Creates the sole worker runtime/context and closes its SQL driver on context construction failure. */
export function createDbWorkerContext(
  init: DbWorkerData,
  emit: DbWorkerEmit,
  overrides: Partial<DbWorkerContextBootstrapDependencies> = {},
): Effect.Effect<DbWorkerContext, unknown> {
  return Effect.uninterruptible(
    Effect.gen(function* () {
      const dependencies = { ...defaultDependencies, ...overrides }
      const logSink = yield* Effect.sync(() => dependencies.makeLogSink(emit))
      const runtime = yield* Effect.try({
        try: () => dependencies.openRuntime(init.dbPath, logSink),
        catch: error => error,
      })
      const context = yield* Effect.exit(
        Effect.try({
          try: () => dependencies.makeContext(init, emit, { runtime }),
          catch: error => error,
        }),
      )
      if (Exit.isSuccess(context)) return context.value

      // Keep cleanup masked and preserve the construction cause if cleanup also fails.
      yield* Effect.exit(runtime.disposeEffect)
      return yield* Effect.failCause(context.cause)
    }),
  )
}

type RunContextEffect = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>

/** Worker-thread root using the official Effect NodeWorkerRunner RPC protocol. */
export function dbWorkerServerProgram(
  init: DbWorkerData,
  runContextEffect: RunContextEffect,
): Effect.Effect<never, unknown> {
  return Effect.scoped(
    Effect.gen(function* () {
      const appPaths = yield* readAppPathsEffect(init.cacheDir).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ preserveEmptyStrings: true })),
      )
      yield* Effect.sync(() => initAppPaths(appPaths))

      const protocol = yield* RpcServer.makeProtocolWorkerRunner.pipe(Effect.provide(NodeWorkerRunner.layer))
      yield* RpcWorker.initialMessage(Schema.Void).pipe(Effect.provideService(RpcServer.Protocol, protocol))

      const handlers = dbWorkerRpcServerLayer({
        createContext: emit => runContextEffect(createDbWorkerContext(init, emit)),
        onFatal: () => {
          // The main-side worker supervisor owns termination after the typed
          // stream or readiness failure has crossed the RPC boundary.
          process.exitCode = 1
        },
      })

      return yield* RpcServer.make(WorkerRpcGroup, { disableTracing: true }).pipe(
        Effect.provideService(RpcServer.Protocol, protocol),
        Effect.provide(handlers),
      )
    }),
  )
}
