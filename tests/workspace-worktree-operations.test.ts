import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import * as AtomRpc from 'effect/reactivity/AtomRpc'
import * as RpcTest from 'effect/rpc/RpcTest'
import * as Stream from 'effect/Stream'
import { describe, expect, it, vi } from 'vitest'

import { createWorkspaceAtoms } from '@/renderer/features/workspace/atoms.js'
import { runWorkspaceOperation } from '@/renderer/features/workspace/workspace-operation.js'
import type { ApplicationClient } from '@/renderer/shared/lib/application-rpc.js'
import { RendererConnection } from '@/shared/rpc/reconnecting-protocol.js'
import { WorkspaceRpcError, WorkspaceRpcGroup } from '@/shared/rpc/workspace.js'
import { projectIdSchema, type WorkspaceCheckout, workspaceCheckoutIdSchema } from '@/shared/schemas/workspace.js'

import { unexpectedWorkspaceHandlers } from './fixtures/unexpected-native-rpc.js'

const projectId = projectIdSchema.make('project')
const connectionLayer = Layer.succeed(RendererConnection, {
  current: Effect.succeed({ _tag: 'Connected' as const, generation: 1 }),
  changes: Stream.empty,
})

function checkout(name: string): WorkspaceCheckout {
  return {
    id: workspaceCheckoutIdSchema.make(name),
    projectId,
    kind: 'worktree',
    path: `/worktrees/${name}`,
    branch: `watchtower/${name}`,
    createdAt: '2026-11-05T12:00:00.000Z',
    archivedAt: null,
  }
}

function setup() {
  const pending = new Map<string, (result: Effect.Effect<WorkspaceCheckout, WorkspaceRpcError>) => void>()
  const requests: string[] = []
  const handlers = Layer.merge(
    unexpectedWorkspaceHandlers,
    WorkspaceRpcGroup.toLayerHandler('workspace:createWorktree', request =>
      Effect.callback<WorkspaceCheckout, WorkspaceRpcError>(resume => {
        requests.push(request.commandId)
        pending.set(request.commandId, resume)
      }),
    ),
  )
  const runtime = Atom.context()
  const client = AtomRpc.Service<object>()('test/WorktreeApplicationRpc', {
    group: WorkspaceRpcGroup,
    protocol: Layer.empty,
    runtime,
    makeEffect: RpcTest.makeClient(WorkspaceRpcGroup, { flatten: true }).pipe(Effect.provide(handlers)),
  }) as unknown as typeof ApplicationClient
  const atoms = createWorkspaceAtoms(client, { layer: connectionLayer })
  const registry = AtomRegistry.make()
  return {
    pending,
    requests,
    dispose: () => registry.dispose(),
    create: (commandId: string) =>
      runWorkspaceOperation(registry, atoms.makeCreateWorktreeAtom, { commandId, projectId, baseBranch: 'main' }),
  }
}

describe('worktree command result ownership', () => {
  it('returns separate checkouts to overlapping composers even when the second creation finishes first', async () => {
    const h = setup()
    try {
      const first = h.create('side-chat-A')
      const second = h.create('side-chat-B')
      await vi.waitFor(() => expect(h.pending.size).toBe(2))
      h.pending.get('side-chat-B')?.(Effect.succeed(checkout('B')))
      expect(await second).toEqual(checkout('B'))
      h.pending.get('side-chat-A')?.(Effect.succeed(checkout('A')))
      expect(await first).toEqual(checkout('A'))
      expect(h.requests).toEqual(['side-chat-A', 'side-chat-B'])
    } finally {
      h.dispose()
    }
  })

  it('keeps a failed creation separate from another composer and reuses an explicit retry identity', async () => {
    const h = setup()
    try {
      const first = h.create('side-chat-A')
      const rejected = expect(first).rejects.toMatchObject({ code: 'conflict' })
      const second = h.create('side-chat-B')
      await vi.waitFor(() => expect(h.pending.size).toBe(2))
      h.pending.get('side-chat-A')?.(
        Effect.fail(
          new WorkspaceRpcError({ code: 'conflict', message: 'Workspace command conflicts with existing state.' }),
        ),
      )
      await rejected
      h.pending.get('side-chat-B')?.(Effect.succeed(checkout('B')))
      expect(await second).toEqual(checkout('B'))
      h.pending.delete('side-chat-A')
      const retry = h.create('side-chat-A')
      await vi.waitFor(() => expect(h.requests).toHaveLength(3))
      h.pending.get('side-chat-A')?.(Effect.succeed(checkout('A')))
      expect(await retry).toEqual(checkout('A'))
      expect(h.requests).toEqual(['side-chat-A', 'side-chat-B', 'side-chat-A'])
    } finally {
      h.dispose()
    }
  })
})
