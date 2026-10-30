import { NodeServices } from '@effect/platform-node'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as RpcTest from 'effect/rpc/RpcTest'
import * as SubscriptionRef from 'effect/SubscriptionRef'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import { WorkspaceProjects } from '@/core/application/commands/workspace-projects.js'
import { CheckoutResolver } from '@/core/ports/checkout-resolver.js'
import { workspaceHandlers } from '@/platform/electron/main/rpc/workspace-handlers.js'
import { WorkspaceHost, type WorkspaceHostStatus, WorkspaceHostLive } from '@/platform/electron/main/workspace/host.js'
import { WorkspaceRpcGroup } from '@/shared/rpc/workspace.js'
import { workspaceConnectionListSchema } from '@/shared/schemas/workspace-connections.js'

const rows = [
  {
    connectionId: 'harness-acp-a1b2c3',
    label: 'Code Assistant',
    harnessKind: 'code-assistant',
    driverId: 'acp' as const,
    provenance: 'path' as const,
    availability: 'available' as const,
    capabilities: 'unknown' as const,
  },
]

const unusedProjects = Layer.succeed(WorkspaceProjects, {
  register: () => Effect.die('unused'),
})
const unusedCheckoutResolver = Layer.succeed(CheckoutResolver, {
  resolve: () => Effect.die('unused'),
  createIsolatedWorktree: () => Effect.die('unused'),
  removeWorktree: () => Effect.die('unused'),
})

describe('workspace connection catalog RPC', () => {
  it('returns safe catalog rows without opening workspace storage or execution', async () => {
    let opens = 0
    let executions = 0
    const host = Effect.gen(function* () {
      return WorkspaceHost.of({
        ensureOpen: Effect.sync(() => {
          opens += 1
        }),
        store: {} as WorkspaceHost['Service']['store'],
        withExecution: <A>() =>
          Effect.sync(() => {
            executions += 1
            return undefined as A
          }),
        listConnections: Effect.succeed(rows),
        eventHighWatermark: yield* SubscriptionRef.make(0),
        status: yield* SubscriptionRef.make<WorkspaceHostStatus>({ state: 'not-started', ownerEpoch: undefined }),
      })
    })
    const runtime = ManagedRuntime.make(
      workspaceHandlers().pipe(
        Layer.provide(Layer.effect(WorkspaceHost, host)),
        Layer.provide(unusedProjects),
        Layer.provide(unusedCheckoutResolver),
        Layer.provide(NodeServices.layer),
      ),
    )
    try {
      const result = await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* RpcTest.makeClient(WorkspaceRpcGroup)
            return yield* client['workspace:listConnections']({})
          }),
        ),
      )
      expect(result).toEqual({ items: rows })
      expect(opens).toBe(0)
      expect(executions).toBe(0)
      expect(JSON.stringify(result)).not.toMatch(/command|args|secret|credential|environment/i)
    } finally {
      await runtime.dispose()
    }
  })

  it('validates the bounded display contract and keeps capabilities unknown', () => {
    expect(Schema.decodeUnknownSync(workspaceConnectionListSchema)({ items: rows })).toEqual({ items: rows })
    expect(() =>
      Schema.decodeUnknownSync(workspaceConnectionListSchema)({
        items: [{ ...rows[0], capabilities: ['submit', 'interrupt'] }],
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(workspaceConnectionListSchema)({
        items: [{ ...rows[0], label: 'x'.repeat(257) }],
      }),
    ).toThrow()
  })

  it('keeps the loader inert until first list and coalesces concurrent catalog reads', async () => {
    let loads = 0
    let workerStarts = 0
    const started = Effect.runSync(Deferred.make<undefined>())
    const release = Effect.runSync(Deferred.make<undefined>())
    const runtime = ManagedRuntime.make(
      WorkspaceHostLive({
        filename: 'unused-workspace.db',
        workerPath: 'unused-workspace-worker.js',
        workerFactory: () => {
          workerStarts += 1
          throw new Error('The catalog must not start the worker')
        },
        loadConnections: () => Effect.succeed([]),
        loadConnectionCatalog: () =>
          Effect.gen(function* () {
            loads += 1
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
            return { connections: [], rows }
          }),
      }),
    )
    try {
      expect(loads).toBe(0)
      const host = await runtime.runPromise(WorkspaceHost)
      expect(workerStarts).toBe(0)
      const [left, right] = await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const first = yield* Effect.forkScoped(host.listConnections!)
            const second = yield* Effect.forkScoped(host.listConnections!)
            yield* Deferred.await(started)
            yield* Deferred.succeed(release, undefined)
            return [yield* Fiber.join(first), yield* Fiber.join(second)] as const
          }),
        ),
      )
      expect(left).toEqual(rows)
      expect(right).toEqual(rows)
      expect(loads).toBe(1)
      expect(workerStarts).toBe(0)
    } finally {
      await runtime.dispose()
    }
  })

  it('retries a catalog load interrupted by its only waiter', async () => {
    let loads = 0
    const started = Effect.runSync(Deferred.make<undefined>())
    const runtime = ManagedRuntime.make(
      WorkspaceHostLive({
        filename: 'unused-workspace.db',
        workerPath: 'unused-workspace-worker.js',
        loadConnections: () => Effect.succeed([]),
        loadConnectionCatalog: () =>
          Effect.gen(function* () {
            loads += 1
            if (loads === 1) {
              yield* Deferred.succeed(started, undefined)
              return yield* Effect.never
            }
            return { connections: [], rows }
          }),
      }),
    )
    try {
      const result = await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const host = yield* WorkspaceHost
            const waiting = yield* Effect.forkScoped(host.listConnections!)
            yield* Deferred.await(started)
            yield* Fiber.interrupt(waiting)
            return yield* host.listConnections!
          }),
        ),
      )
      expect(result).toEqual(rows)
      expect(loads).toBe(2)
    } finally {
      await runtime.dispose()
    }
  })
})
