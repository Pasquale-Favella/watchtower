import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import { describe, expect, it } from 'vitest'

import { CheckoutResolver } from '@/core/ports/checkout-resolver.js'
import { CommandRunner } from '@/core/ports/process.js'
import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { CheckoutResolverLive } from '@/infrastructure/filesystem/checkout-resolver.js'
import { WorkspaceStoreLive } from '@/infrastructure/sqlite/workspace/workspace-store.js'
import {
  COACH_CHECKOUT_ID,
  COACH_PROJECT_ID,
  ensureCoachProject,
} from '@/platform/electron/main/workspace/coach-project.js'
import { workspaceCheckoutIdSchema } from '@/shared/schemas/workspace.js'

const at = '2026-11-23T08:00:00Z'
const filesystem = Layer.merge(NodeFileSystem.layer, NodePath.layer)
// Any Git (or other) process fails the test: Coach setup runs no command and has no process spawner.
const resolverLayer = CheckoutResolverLive.pipe(
  Layer.provide(
    Layer.merge(
      filesystem,
      CommandRunner.layerWithRunner(() => Effect.die('Unexpected command')),
    ),
  ),
)

function makeRuntime() {
  return ManagedRuntime.make(Layer.mergeAll(WorkspaceStoreLive({ filename: ':memory:' }), resolverLayer, filesystem))
}

async function withCoach(use: (fixture: Awaited<ReturnType<typeof coachFixture>>) => Promise<void>) {
  const profile = mkdtempSync(join(tmpdir(), 'watchtower-coach-'))
  const runtime = makeRuntime()
  try {
    await use(await coachFixture(profile, runtime))
  } finally {
    await runtime.dispose()
    rmSync(profile, { recursive: true, force: true })
  }
}

async function coachFixture(profile: string, runtime: ReturnType<typeof makeRuntime>) {
  const store = await runtime.runPromise(WorkspaceStore)
  const resolver = await runtime.runPromise(CheckoutResolver)
  const root = join(realpathSync.native(profile), 'workspace', 'coach')
  return { profile, root, store, resolver, ensure: ensureCoachProject(store, root), run: runtime.runPromise }
}

describe('managed Coach checkout', () => {
  it('registers a stable git-free directory project and reuses it', () =>
    withCoach(async ({ run, ensure, root, store }) => {
      expect(existsSync(root)).toBe(false)
      const first = await run(ensure)
      expect(first.project).toMatchObject({ id: COACH_PROJECT_ID, name: 'Coach', isCoach: true })
      expect(first.project.repositoryIdentity).toBeUndefined()
      expect(first.mainCheckout).toMatchObject({ id: COACH_CHECKOUT_ID, kind: 'directory', path: root })
      expect(existsSync(root)).toBe(true)
      expect(existsSync(join(root, '.git'))).toBe(false)
      expect(await run(ensure)).toMatchObject({
        project: first.project,
        mainCheckout: first.mainCheckout,
        reused: true,
      })
      expect((await run(store.listProjects())).total).toBe(0)
    }))

  it('recreates a deleted managed folder', () =>
    withCoach(async ({ run, ensure, root }) => {
      await run(ensure)
      rmSync(root, { recursive: true, force: true })
      expect(await run(ensure)).toMatchObject({ reused: true, mainCheckout: { path: root } })
      expect(existsSync(root)).toBe(true)
    }))

  it('accepts a legacy Git-backed record and keeps its folder untouched', () =>
    withCoach(async ({ run, ensure, root, store }) => {
      mkdirSync(join(root, '.git'), { recursive: true })
      writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
      writeFileSync(join(root, 'notes.txt'), 'keep me')
      const legacy = await run(
        store.registerProject({
          project: {
            id: COACH_PROJECT_ID,
            name: 'Coach',
            isCoach: true,
            repositoryIdentity: join(root, '.git'),
            createdAt: at,
            updatedAt: at,
          },
          mainCheckout: { id: COACH_CHECKOUT_ID, kind: 'main', path: root, branch: 'main', createdAt: at },
        }),
      )
      expect(await run(ensure)).toMatchObject({
        project: legacy.project,
        mainCheckout: { ...legacy.mainCheckout, kind: 'main' },
        reused: true,
      })
      expect(readFileSync(join(root, 'notes.txt'), 'utf8')).toBe('keep me')
      expect(existsSync(join(root, '.git', 'HEAD'))).toBe(true)
      expect((await run(store.getProject(COACH_PROJECT_ID))).project.repositoryIdentity).toBe(join(root, '.git'))
    }))

  it('still works as a directory checkout when the folder sits inside a Git repository', () =>
    withCoach(async ({ run, ensure, root, profile, resolver }) => {
      mkdirSync(join(profile, '.git'))
      writeFileSync(join(profile, '.git', 'HEAD'), 'ref: refs/heads/main\n')
      const registered = await run(ensure)
      expect(registered.mainCheckout).toMatchObject({ kind: 'directory', path: root })
      expect(registered.project.repositoryIdentity).toBeUndefined()
      // Execution revalidation resolves a directory checkout in directory mode and never asks Git.
      expect(await run(resolver.resolve(root, 'directory'))).toMatchObject({ kind: 'directory', canonicalPath: root })
      expect(await run(ensure)).toMatchObject({ reused: true })
    }))

  it('rejects a registration that does not match the fixed Coach identity', () =>
    withCoach(async ({ run, ensure, root, store }) => {
      await run(
        store.registerProject({
          project: { id: COACH_PROJECT_ID, name: 'User project', createdAt: at, updatedAt: at },
          mainCheckout: {
            id: workspaceCheckoutIdSchema.make('user-checkout'),
            kind: 'directory',
            path: root,
            createdAt: at,
          },
        }),
      )
      expect(await run(ensure.pipe(Effect.flip))).toMatchObject({
        code: 'membership-conflict',
        message: 'Chat checkout identity is invalid.',
      })
    }))

  it('rejects a Coach record whose folder moved', () =>
    withCoach(async ({ run, ensure, root, store, profile }) => {
      const other = join(realpathSync.native(profile), 'elsewhere')
      mkdirSync(other)
      await run(
        store.registerProject({
          project: { id: COACH_PROJECT_ID, name: 'Coach', isCoach: true, createdAt: at, updatedAt: at },
          mainCheckout: { id: COACH_CHECKOUT_ID, kind: 'directory', path: other, createdAt: at },
        }),
      )
      expect(await run(ensure.pipe(Effect.flip))).toMatchObject({ code: 'membership-conflict' })
      expect(existsSync(root)).toBe(true)
    }))
})
