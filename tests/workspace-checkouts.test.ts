import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import { afterEach, describe, expect, it } from 'vitest'

import { WorkspaceCheckouts, WorkspaceCheckoutsLive } from '@/core/application/commands/workspace-checkouts.js'
import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { CheckoutBranchesLive } from '@/infrastructure/filesystem/checkout-branches.js'
import { CheckoutResolverLive } from '@/infrastructure/filesystem/checkout-resolver.js'
import { NodePlatformLive } from '@/infrastructure/platform/platform-live.js'
import { CommandRunnerLive } from '@/infrastructure/process/command-runner.js'
import { WorkspaceStoreLive } from '@/infrastructure/sqlite/workspace/workspace-store.js'
import type { ProjectId, WorkspaceCheckoutId } from '@/shared/schemas/workspace.js'

const roots: string[] = []
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const commit = (cwd: string, message: string) =>
  git(cwd, '-c', 'user.name=Checkout Test', '-c', 'user.email=checkout@example.invalid', 'commit', '-aqm', message)

const fixture = () => {
  const root = mkdtempSync(join(process.cwd(), '.workspace-checkouts-test-'))
  roots.push(root)
  // A bare boundary keeps the fixture from discovering Watchtower's own checkout.
  git(root, 'init', '--bare', '--quiet')
  const repository = join(root, 'my repo')
  mkdirSync(repository)
  git(repository, 'init', '--quiet', '--initial-branch=main')
  git(repository, 'config', 'core.autocrlf', 'false')
  git(repository, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repository, 'tracked.txt'), 'main\n')
  git(repository, 'add', '--', 'tracked.txt')
  commit(repository, 'Initial')
  git(repository, 'switch', '-qc', 'feature')
  writeFileSync(join(repository, 'tracked.txt'), 'feature\n')
  commit(repository, 'Feature')
  git(repository, 'switch', '-q', 'main')
  return { root, repository: realpathSync.native(repository), worktrees: join(root, 'worktrees') }
}

const projectId = 'project-1' as ProjectId
const mainCheckoutId = 'checkout-main' as WorkspaceCheckoutId

const withCheckouts = async (
  worktrees: string,
  use: (
    checkouts: WorkspaceCheckouts['Service'],
    store: WorkspaceStore['Service'],
    run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>,
  ) => Promise<void>,
) => {
  const runtime = ManagedRuntime.make(
    WorkspaceCheckoutsLive(worktrees).pipe(
      Layer.provideMerge(Layer.mergeAll(CheckoutResolverLive, CheckoutBranchesLive)),
      Layer.provideMerge(WorkspaceStoreLive({ filename: ':memory:' })),
      Layer.provideMerge(CommandRunnerLive),
      Layer.provideMerge(NodePlatformLive),
    ),
  )
  try {
    const run = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect)
    await use(await runtime.runPromise(WorkspaceCheckouts), await runtime.runPromise(WorkspaceStore), run)
  } finally {
    await runtime.dispose()
  }
}

const register = (store: WorkspaceStore['Service'], repository: string) =>
  store.registerProject({
    project: {
      id: projectId,
      name: 'Project',
      repositoryIdentity: `repo:${repository}`,
      createdAt: '2026-11-02T10:00:00Z',
      updatedAt: '2026-11-02T10:00:00Z',
    },
    mainCheckout: { id: mainCheckoutId, kind: 'main', path: repository, createdAt: '2026-11-02T10:00:00Z' },
  })

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('WorkspaceCheckouts', () => {
  it(
    'lists branches and switches the current checkout, refusing a switch that would lose work',
    { timeout: 60_000 },
    async () => {
      const { repository, worktrees } = fixture()
      await withCheckouts(worktrees, async (checkouts, store, run) => {
        await run(register(store, repository))
        const listed = await run(checkouts.branches({ projectId }))
        expect(listed.current).toBe('main')
        expect(listed.branches.map(branch => branch.name).sort()).toEqual(['feature', 'main'])
        expect(listed.branches.find(branch => branch.name === 'main')).toMatchObject({ current: true, isDefault: true })

        const switched = await run(checkouts.switchBranch({ projectId, checkoutId: mainCheckoutId, branch: 'feature' }))
        expect(switched.current).toBe('feature')
        expect(git(repository, 'branch', '--show-current')).toBe('feature')

        writeFileSync(join(repository, 'tracked.txt'), 'uncommitted\n')
        const refused = await run(
          Effect.flip(checkouts.switchBranch({ projectId, checkoutId: mainCheckoutId, branch: 'main' })),
        )
        expect(refused).toMatchObject({ _tag: 'CheckoutResolverError', code: 'dirty-checkout' })
        expect(git(repository, 'branch', '--show-current')).toBe('feature')
      })
    },
  )

  it(
    'creates a worktree on a new branch from the base branch, registers it, and replays the same command',
    { timeout: 60_000 },
    async () => {
      const { repository, worktrees } = fixture()
      await withCheckouts(worktrees, async (checkouts, store, run) => {
        await run(register(store, repository))
        const request = {
          commandId: 'worktree-1',
          token: 'abcdef12',
          checkoutId: 'checkout-worktree' as WorkspaceCheckoutId,
          projectId,
          baseBranch: 'feature',
        }
        const created = await run(checkouts.createWorktree(request))
        expect(created).toMatchObject({ kind: 'worktree', branch: 'watchtower/abcdef12', projectId })
        expect(created.path).toBe(
          realpathSync.native(join(worktrees, basename(repository).replace(' ', '-'), 'watchtower-abcdef12')),
        )
        expect(git(created.path, 'branch', '--show-current')).toBe('watchtower/abcdef12')
        expect(git(created.path, 'show', 'HEAD:tracked.txt')).toBe('feature')
        expect(git(repository, 'branch', '--show-current')).toBe('main')

        expect(await run(checkouts.createWorktree(request))).toEqual(created)
        const detail = await run(store.getProject(projectId))
        expect(detail.otherCheckouts.map(checkout => checkout.id)).toEqual([request.checkoutId])

        const inWorktree = await run(checkouts.branches({ projectId, checkoutId: request.checkoutId }))
        expect(inWorktree.current).toBe('watchtower/abcdef12')
        const fromMain = await run(checkouts.branches({ projectId }))
        expect(fromMain.branches.find(branch => branch.name === 'watchtower/abcdef12')?.worktreePath).not.toBeNull()
      })
    },
  )

  it(
    'rejects a reused command ID with another checkout and checkouts of unknown Projects',
    { timeout: 60_000 },
    async () => {
      const { repository, worktrees } = fixture()
      await withCheckouts(worktrees, async (_checkouts, store, run) => {
        await run(register(store, repository))
        const checkout = {
          id: 'checkout-a' as WorkspaceCheckoutId,
          projectId,
          kind: 'worktree' as const,
          path: join(worktrees, 'a'),
          createdAt: '2026-11-02T10:00:00Z',
        }
        await run(store.registerCheckout({ commandId: 'register-a', checkout }))
        const conflict = await run(
          Effect.flip(
            store.registerCheckout({ commandId: 'register-a', checkout: { ...checkout, path: join(worktrees, 'b') } }),
          ),
        )
        expect(conflict).toMatchObject({ code: 'command-conflict' })
        const duplicatePath = await run(
          Effect.flip(
            store.registerCheckout({ commandId: 'register-b', checkout: { ...checkout, id: 'other' as never } }),
          ),
        )
        expect(duplicatePath).toMatchObject({ code: 'membership-conflict' })
        const missing = await run(
          Effect.flip(
            store.registerCheckout({
              commandId: 'register-c',
              checkout: { ...checkout, id: 'checkout-c' as never, projectId: 'missing' as ProjectId },
            }),
          ),
        )
        expect(missing).toMatchObject({ code: 'not-found' })
      })
    },
  )
})
