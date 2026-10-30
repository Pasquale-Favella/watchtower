import * as NodeWorkerRunner from '@effect/platform-node/NodeWorkerRunner'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import { RpcServer, RpcWorker } from 'effect/rpc'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'

import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { WorkspaceStoreLive } from '@/infrastructure/sqlite/workspace/workspace-store.js'
import {
  WORKSPACE_WORKER_REQUEST_CAPACITY,
  WorkspaceWorkerRpcGroup,
  workspaceWorkerDataSchema,
} from '@/shared/rpc/workspace-worker.js'
import { workspaceWorkerRpcServerLayer } from '@/platform/electron/workers/workspace/rpc-server.js'

export function workspaceWorkerServerProgram(init: unknown): Effect.Effect<never, unknown> {
  return Effect.scoped(
    Effect.gen(function* () {
      const { filename } = yield* Schema.decodeUnknownEffect(workspaceWorkerDataSchema)(init)
      const protocol = yield* RpcServer.makeProtocolWorkerRunner.pipe(Effect.provide(NodeWorkerRunner.layer))
      yield* RpcWorker.initialMessage(Schema.Void).pipe(Effect.provideService(RpcServer.Protocol, protocol))

      const rootScope = yield* Effect.scope
      const sqlScope = yield* Scope.fork(rootScope)
      const storeContext = yield* Layer.buildWithScope(WorkspaceStoreLive({ filename }), sqlScope)
      const handlers = workspaceWorkerRpcServerLayer({
        store: Context.get(storeContext, WorkspaceStore),
        onShutdown: Scope.close(sqlScope, Exit.void),
      })

      return yield* RpcServer.make(WorkspaceWorkerRpcGroup, {
        concurrency: WORKSPACE_WORKER_REQUEST_CAPACITY,
        disableTracing: true,
      }).pipe(Effect.provideService(RpcServer.Protocol, protocol), Effect.provide(handlers))
    }),
  )
}
