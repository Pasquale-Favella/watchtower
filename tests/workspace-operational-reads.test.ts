import { NodeServices } from '@effect/platform-node'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as RpcTest from 'effect/rpc/RpcTest'
import * as SubscriptionRef from 'effect/SubscriptionRef'
import { describe, expect, it } from 'vitest'

import { WorkspaceProjects } from '@/core/application/commands/workspace-projects.js'
import { workspaceHandlers } from '@/platform/electron/main/rpc/workspace-handlers.js'
import { WorkspaceHost, type WorkspaceHostStatus } from '@/platform/electron/main/workspace/host.js'
import { WorkspaceRpcGroup } from '@/shared/rpc/workspace.js'
import { WorkspaceStoreError } from '@/shared/schemas/workspace-store.js'
import type { ProjectId, TaskId } from '@/shared/schemas/workspace.js'

const taskId = 'task-a' as TaskId
const projectId = 'project-a' as ProjectId
const snapshot = {
  task: { id: taskId, projectId, title: 'Current task', status: 'open' },
  runs: [],
  runContexts: [],
  runCoverage: { total: 0, returned: 0, truncated: false },
  requestResponses: [],
  steerIntents: [],
  queuedFollowUps: [],
  requestResponseSummary: { total: 0, truncated: false, pendingCount: 0, uncertainCount: 0 },
  steerIntentSummary: { total: 0, truncated: false, pendingCount: 0, uncertainCount: 0 },
  queuedFollowUpSummary: { total: 0, truncated: false },
  highWatermark: 9,
}
const sessions = { items: [], total: 0, nextAfterId: null, truncated: false }

function makeHandlers(options: { readonly failSnapshot?: boolean } = {}) {
  let opened = 0
  let executionAccesses = 0
  const store = {
    readTaskSnapshot: () =>
      options.failSnapshot
        ? Effect.fail(new WorkspaceStoreError({ code: 'database-unavailable', message: 'private location' }))
        : Effect.succeed(snapshot),
    listNativeAgentSessions: () => Effect.succeed(sessions),
    listRequestResponses: () => Effect.succeed({ items: [], total: 0, truncated: false, nextAfterPosition: null }),
    listSteerIntents: () => Effect.succeed({ items: [], total: 0, truncated: false, nextAfterPosition: null }),
  }
  const host = Layer.effect(
    WorkspaceHost,
    Effect.gen(function* () {
      return WorkspaceHost.of({
        ensureOpen: Effect.sync(() => void opened++),
        store: store as unknown as WorkspaceHost['Service']['store'],
        withExecution: (() => Effect.sync(() => void executionAccesses++)) as WorkspaceHost['Service']['withExecution'],
        eventHighWatermark: yield* SubscriptionRef.make(9),
        status: yield* SubscriptionRef.make<WorkspaceHostStatus>({ state: 'ready', ownerEpoch: 1 }),
      })
    }),
  )
  const handlers = workspaceHandlers().pipe(
    Layer.provide(host),
    Layer.provide(Layer.succeed(WorkspaceProjects, { register: () => Effect.die('unused') })),
  )
  return { handlers, counts: () => ({ opened, executionAccesses }) }
}

describe('workspace operational reads', () => {
  it('serves bounded snapshot and native-session reads through the renderer RPC group', async () => {
    const setup = makeHandlers()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(WorkspaceRpcGroup)
        const taskSnapshot = yield* client['workspace:readTaskSnapshot']({ taskId, runLimit: 25 })
        const nativeSessions = yield* client['workspace:listNativeAgentSessions']({
          taskId,
          options: { limit: 20 },
        })
        const connections = yield* client['workspace:listConnections']({})
        const responses = yield* client['workspace:listRequestResponses']({ taskId, options: { limit: 10 } })
        const steers = yield* client['workspace:listSteerIntents']({ taskId, options: { limit: 10 } })
        return { taskSnapshot, nativeSessions, connections, responses, steers }
      }).pipe(Effect.scoped, Effect.provide(setup.handlers), Effect.provide(NodeServices.layer)),
    )

    expect(result).toEqual({
      taskSnapshot: snapshot,
      nativeSessions: sessions,
      connections: { items: [] },
      responses: { items: [], total: 0, truncated: false, nextAfterPosition: null },
      steers: { items: [], total: 0, truncated: false, nextAfterPosition: null },
    })
    expect(setup.counts()).toEqual({ opened: 4, executionAccesses: 0 })
  })

  it('rejects malformed IDs and out-of-range run limits at the RPC contract', async () => {
    const setup = makeHandlers()
    const exits = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(WorkspaceRpcGroup)
        return yield* Effect.all([
          Effect.exit(client['workspace:readTaskSnapshot']({ taskId: '' as TaskId, runLimit: 10 })),
          Effect.exit(client['workspace:readTaskSnapshot']({ taskId, runLimit: 501 })),
          Effect.exit(client['workspace:listNativeAgentSessions']({ taskId: '' as TaskId, options: { limit: 10 } })),
        ])
      }).pipe(Effect.scoped, Effect.provide(setup.handlers), Effect.provide(NodeServices.layer)),
    )

    expect(exits.every(exit => exit._tag === 'Failure')).toBe(true)
    expect(setup.counts().opened).toBe(0)
  })

  it('sanitizes storage failures without exposing local paths', async () => {
    const setup = makeHandlers({ failSnapshot: true })
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(WorkspaceRpcGroup)
        return yield* Effect.exit(client['workspace:readTaskSnapshot']({ taskId, runLimit: 10 }))
      }).pipe(Effect.scoped, Effect.provide(setup.handlers), Effect.provide(NodeServices.layer)),
    )

    expect(JSON.stringify(result)).not.toContain('private location')
    expect(JSON.stringify(result)).toContain('unavailable')
  })
})
