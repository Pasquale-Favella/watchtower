import { NodeServices } from '@effect/platform-node'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as RpcTest from 'effect/rpc/RpcTest'
import * as SubscriptionRef from 'effect/SubscriptionRef'
import { expect, it } from 'vitest'

import { WorkspaceProjects } from '@/core/application/commands/workspace-projects.js'
import { WorkspacePullRequests } from '@/core/ports/workspace-pull-requests.js'
import type { PromptAttachmentStore } from '@/infrastructure/workspace/prompt-attachments.js'
import { workspaceHandlers } from '@/platform/electron/main/rpc/workspace-handlers.js'
import { WorkspaceHost, type WorkspaceHostStatus } from '@/platform/electron/main/workspace/host.js'
import { WorkspaceRpcGroup } from '@/shared/rpc/workspace.js'
import { projectIdSchema, workspaceCheckoutIdSchema } from '@/shared/schemas/workspace.js'
import type { WorkspaceProjectRegistration } from '@/shared/schemas/workspace-projects.js'
import type { WorkspacePullRequestSummary } from '@/shared/schemas/workspace-pull-requests.js'

const projectId = projectIdSchema.make('project')
const checkoutId = workspaceCheckoutIdSchema.make('checkout')

function pullRequest(number: number): WorkspacePullRequestSummary {
  return { number, title: `Change ${number}`, url: `https://github.com/fixture/repo/pull/${number}`, state: 'open', isDraft: false, author: 'fixture', headRefName: 'change', baseRefName: 'main', updatedAt: '2026-11-09T00:00:00Z', additions: 1, deletions: 0, reviewDecision: '' }
}

it('searches scratch provider skills and resolves exact PR numbers outside the recent list through real RPC codecs', async () => {
  const roots: string[] = []
  let executions = 0
  const store = {
    getProject: () => Effect.succeed({ project: { id: projectId }, mainCheckout: { id: checkoutId, path: 'checkout-root' }, otherCheckouts: [] }),
    listProjects: () => Effect.succeed({ items: [], nextAfterId: null }),
  } as unknown as WorkspaceHost['Service']['store']
  const host = Layer.effect(WorkspaceHost, Effect.gen(function* () {
    return WorkspaceHost.of({
      store,
      ensureOpen: Effect.void,
      withExecution: () => Effect.sync(() => { executions++; throw new Error('Prompt search must not execute a turn') }),
      discoverPromptCatalog: (_connection, root) => {
        roots.push(root)
        return Effect.succeed({ skills: [{ name: 'review', enabled: true, description: 'Review this change' }], skillsComplete: true, commands: [] })
      },
      status: yield* SubscriptionRef.make<WorkspaceHostStatus>({ state: 'ready', ownerEpoch: 1 }),
      eventHighWatermark: yield* SubscriptionRef.make(0),
    })
  }))
  const attachmentStore = { search: async () => ({ items: [], truncated: false }) } as unknown as PromptAttachmentStore
  const pulls = {
    list: () => Effect.succeed({ items: [pullRequest(122)], truncated: false }),
    detail: (_root: string, number: number) => Effect.succeed(pullRequest(number)),
  } as unknown as WorkspacePullRequests['Service']
  const runtime = ManagedRuntime.make(workspaceHandlers({
    attachments: attachmentStore,
    prepareScratchProject: () => Effect.succeed({ mainCheckout: { path: 'managed-scratch' } } as WorkspaceProjectRegistration),
  }).pipe(
    Layer.provide(host),
    Layer.provide(Layer.succeed(WorkspaceProjects, { register: () => Effect.die('unused') })),
    Layer.provide(Layer.succeed(WorkspacePullRequests, pulls)),
    Layer.provide(NodeServices.layer),
  ))
  try {
    const result = await runtime.runPromise(Effect.scoped(Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(WorkspaceRpcGroup)
      const skills = yield* client['workspace:searchPromptContext']({ kind: 'command', connectionId: 'fixture', query: 'rvw' })
      const prs = yield* client['workspace:searchPromptContext']({ kind: 'pullRequest', projectId, query: '12' })
      return { skills, prs }
    })))
    expect(result.skills.items).toContainEqual({ kind: 'providerSkill', path: 'review', label: 'review', description: 'Review this change' })
    expect(roots).toEqual(['managed-scratch'])
    expect(result.prs.items.map(item => item.label)).toEqual(['#12', '#122'])
    expect(executions).toBe(0)
  } finally {
    await runtime.dispose()
  }
})
