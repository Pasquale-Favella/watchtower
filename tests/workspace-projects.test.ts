import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { join, resolve as resolvePath, sep } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import { WorkspaceProjects, WorkspaceProjectsLive } from '@/core/application/commands/workspace-projects.js'
import { CheckoutResolver } from '@/core/ports/checkout-resolver.js'
import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { CheckoutResolverLive } from '@/infrastructure/filesystem/checkout-resolver.js'
import { NodePlatformLive } from '@/infrastructure/platform/platform-live.js'
import { CommandRunnerLive } from '@/infrastructure/process/command-runner.js'
import { WorkspaceStoreLive } from '@/infrastructure/sqlite/workspace/workspace-store.js'
import { CheckoutResolverError, type ResolvedCheckout } from '@/shared/schemas/checkout.js'
import { registerWorkspaceProjectSchema } from '@/shared/schemas/workspace-projects.js'
import { beginRunCommandSchema, createTaskCommandSchema } from '@/shared/schemas/workspace-store.js'

const at = '2026-10-30T08:00:00Z'
const main: ResolvedCheckout = {
  kind: 'main',
  canonicalPath: '/canonical/project',
  repositoryIdentity: '/canonical/project/.git',
  mainCheckoutPath: '/canonical/project',
  branch: 'main',
  headRevision: 'abc',
  dirty: { trackedChanges: 0, untrackedCount: 0, ignoredCount: 0 },
}

function fixture(resolve: CheckoutResolver['Service']['resolve']) {
  return ManagedRuntime.make(
    WorkspaceProjectsLive.pipe(
      Layer.provideMerge(
        Layer.merge(
          WorkspaceStoreLive({ filename: ':memory:' }),
          Layer.succeed(
            CheckoutResolver,
            CheckoutResolver.of({
              resolve,
              createIsolatedWorktree: () => Effect.die('Unused fixture operation'),
              removeWorktree: () => Effect.die('Unused fixture operation'),
            }),
          ),
        ),
      ),
    ),
  )
}

function request(suffix = '1', path = '/alias/project') {
  return Schema.decodeUnknownSync(registerWorkspaceProjectSchema)({
    projectId: `project-${suffix}`,
    checkoutId: `checkout-${suffix}`,
    name: 'Project',
    path,
  })
}

describe('workspace project registration', () => {
  it('persists the resolved canonical identity and admits runs against that exact path', async () => {
    const seen: string[] = []
    const runtime = fixture(path =>
      Effect.sync(() => {
        seen.push(path)
        return main
      }),
    )
    try {
      const projects = await runtime.runPromise(WorkspaceProjects)
      const registered = await runtime.runPromise(projects.register(request()))
      expect(seen).toEqual(['/alias/project'])
      expect(registered.project.repositoryIdentity).toBe('/canonical/project/.git')
      expect(registered.mainCheckout.path).toBe('/canonical/project')
      const store = await runtime.runPromise(WorkspaceStore)
      await runtime.runPromise(
        store.createTask(
          Schema.decodeUnknownSync(createTaskCommandSchema)({
            task: { id: 'task-1', projectId: 'project-1', title: 'Task', description: '', createdAt: at },
            conversation: { id: 'conversation-1', createdAt: at },
          }),
        ),
      )
      const command = Schema.decodeUnknownSync(beginRunCommandSchema)({
        commandId: 'command-1',
        issuedAt: at,
        runId: 'run-1',
        taskId: 'task-1',
        conversationId: 'conversation-1',
        checkoutId: 'checkout-1',
        provisionalAgentSessionId: 'session-1',
        generation: 1,
        driverId: 'acp',
        connectionId: 'connection-1',
        prompt: 'Inspect',
      })
      await runtime.runPromise(store.beginRun(command))
      const owner = await runtime.runPromise(store.acquireOwnerEpoch(at))
      const claim = await runtime.runPromise(store.claimDispatch(command.runId, owner.ownerEpoch, at))
      expect(claim.workspacePath).toBe('/canonical/project')
    } finally {
      await runtime.dispose()
    }
  })

  it('registers the main checkout when the selected path is a linked worktree', async () => {
    const seen: string[] = []
    const runtime = fixture(path =>
      Effect.sync(() => {
        seen.push(path)
        return path === '/alias/worktree' ? { ...main, kind: 'worktree', canonicalPath: '/canonical/worktree' } : main
      }),
    )
    try {
      const projects = await runtime.runPromise(WorkspaceProjects)
      const registered = await runtime.runPromise(projects.register(request('1', '/alias/worktree')))
      expect(seen).toEqual(['/alias/worktree', '/canonical/project'])
      expect(registered.mainCheckout.path).toBe('/canonical/project')
    } finally {
      await runtime.dispose()
    }
  })

  it('rejects an ordinary directory and a disappeared checkout before registering a project', async () => {
    const runtime = fixture(path =>
      path === '/missing'
        ? Effect.fail(new CheckoutResolverError({ code: 'path-missing', message: 'Checkout is missing.' }))
        : Effect.succeed({
            kind: 'directory',
            canonicalPath: path,
            repositoryIdentity: null,
            mainCheckoutPath: null,
            branch: null,
            headRevision: null,
            dirty: { trackedChanges: 0, untrackedCount: 0, ignoredCount: 0 },
          }),
    )
    try {
      const projects = await runtime.runPromise(WorkspaceProjects)
      expect(await runtime.runPromise(projects.register(request()).pipe(Effect.flip))).toMatchObject({
        code: 'not-a-repository',
      })
      expect(await runtime.runPromise(projects.register(request('2', '/missing')).pipe(Effect.flip))).toMatchObject({
        code: 'path-missing',
      })
    } finally {
      await runtime.dispose()
    }
  })

  it('uses real Git identities to distinguish same-name repositories and fence aliases of one checkout', async () => {
    const cache = resolvePath('node_modules/.cache')
    mkdirSync(cache, { recursive: true })
    const directory = mkdtempSync(join(cache, 'workspace-projects-'))
    if (!resolvePath(directory).startsWith(`${cache}${sep}`)) throw new Error('Unexpected fixture cleanup path')
    const repository = (parent: string) => {
      const path = join(directory, parent, 'same-name')
      mkdirSync(path, { recursive: true })
      execFileSync('git', ['init', '--quiet', '--initial-branch=main', path], { windowsHide: true, stdio: 'pipe' })
      return path
    }
    const first = repository('first')
    const second = repository('second')
    const alias = join(directory, 'alias')
    symlinkSync(first, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const resolver = CheckoutResolverLive.pipe(Layer.provide(CommandRunnerLive), Layer.provide(NodePlatformLive))
    const runtime = ManagedRuntime.make(
      WorkspaceProjectsLive.pipe(
        Layer.provideMerge(Layer.merge(WorkspaceStoreLive({ filename: ':memory:' }), resolver)),
      ),
    )
    try {
      const projects = await runtime.runPromise(WorkspaceProjects)
      const a = await runtime.runPromise(projects.register(request('1', first)))
      const b = await runtime.runPromise(projects.register(request('2', second)))
      const linked = await runtime.runPromise(projects.register(request('3', alias)))
      expect(a.project.repositoryIdentity).not.toBe(b.project.repositoryIdentity)
      expect(linked.project.repositoryIdentity).toBe(a.project.repositoryIdentity)
      expect(linked.mainCheckout.path).toBe(realpathSync.native(first))
      const store = await runtime.runPromise(WorkspaceStore)
      const run = (suffix: string) =>
        Schema.decodeUnknownSync(beginRunCommandSchema)({
          commandId: `command-${suffix}`,
          issuedAt: at,
          runId: `run-${suffix}`,
          taskId: `task-${suffix}`,
          conversationId: `conversation-${suffix}`,
          checkoutId: `checkout-${suffix}`,
          provisionalAgentSessionId: `session-${suffix}`,
          generation: 1,
          driverId: 'acp',
          connectionId: 'connection-1',
          prompt: 'Inspect',
        })
      for (const suffix of ['1', '3']) {
        await runtime.runPromise(
          store.createTask(
            Schema.decodeUnknownSync(createTaskCommandSchema)({
              task: {
                id: `task-${suffix}`,
                projectId: `project-${suffix}`,
                title: 'Task',
                description: '',
                createdAt: at,
              },
              conversation: { id: `conversation-${suffix}`, createdAt: at },
            }),
          ),
        )
      }
      await runtime.runPromise(store.beginRun(run('1')))
      expect(await runtime.runPromise(store.beginRun(run('3')).pipe(Effect.flip))).toMatchObject({
        code: 'admission-conflict',
      })
    } finally {
      await runtime.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
