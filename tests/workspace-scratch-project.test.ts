import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Path from 'effect/Path'
import { describe, expect, it, vi } from 'vitest'

import {
  prepareScratchCheckout,
  SCRATCH_INSIDE_GIT_MESSAGE,
  SCRATCH_PROJECT_ID,
  SCRATCH_ROOT_CHECKOUT_ID,
  scratchCheckoutId,
} from '@/core/application/commands/scratch-checkouts.js'
import { CheckoutResolver } from '@/core/ports/checkout-resolver.js'
import { CommandRunner } from '@/core/ports/process.js'
import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { CheckoutResolverLive } from '@/infrastructure/filesystem/checkout-resolver.js'
import { WorkspaceStoreLive } from '@/infrastructure/sqlite/workspace/workspace-store.js'
import { ensureScratchProject } from '@/platform/electron/main/workspace/scratch-project.js'
import {
  agentRunIdSchema,
  conversationIdSchema,
  projectIdSchema,
  taskIdSchema,
  workspaceCheckoutIdSchema,
} from '@/shared/schemas/workspace.js'
import type { BeginRunCommand } from '@/shared/schemas/workspace-store.js'

const at = '2026-11-23T08:00:00Z'
const filesystem = Layer.merge(NodeFileSystem.layer, NodePath.layer)
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

async function withScratch(use: (fixture: Awaited<ReturnType<typeof scratchFixture>>) => Promise<void>) {
  const profile = mkdtempSync(join(tmpdir(), 'watchtower-scratch-'))
  const runtime = makeRuntime()
  try {
    await use(await scratchFixture(profile, runtime))
  } finally {
    await runtime.dispose()
    rmSync(profile, { recursive: true, force: true })
  }
}

async function scratchFixture(profile: string, runtime: ReturnType<typeof makeRuntime>) {
  const store = await runtime.runPromise(WorkspaceStore)
  const resolver = await runtime.runPromise(CheckoutResolver)
  const root = join(realpathSync.native(profile), 'workspace', 'scratch')
  const ensure = ensureScratchProject(store, root)
  const createChat = (id: string) => {
    const conversationId = conversationIdSchema.make(id)
    return store
      .createTask({
        task: {
          id: taskIdSchema.make(`task-${id}`),
          projectId: SCRATCH_PROJECT_ID,
          title: id,
          description: '',
          createdAt: at,
        },
        conversation: { id: conversationId, createdAt: at },
      })
      .pipe(Effect.as(conversationId))
  }
  return { root, profile, store, resolver, ensure, createChat, run: runtime.runPromise }
}

describe('No project', () => {
  it('registers a stable directory root without any process spawner or Git runner', () =>
    withScratch(async ({ run, ensure, root }) => {
      const first = await run(ensure)
      expect(first.project).toMatchObject({ id: SCRATCH_PROJECT_ID, name: 'No project', isScratch: true })
      expect(first.project.repositoryIdentity).toBeUndefined()
      expect(first.mainCheckout).toMatchObject({ id: SCRATCH_ROOT_CHECKOUT_ID, kind: 'directory', path: root })
      expect(readdirSync(root)).toEqual([])
      expect(await run(ensure)).toMatchObject({
        project: first.project,
        mainCheckout: first.mainCheckout,
        reused: true,
      })
    }))

  it('keeps the legacy checkout and all its files while preparing a new directory checkout', () =>
    withScratch(async ({ run, root, store, resolver, ensure, createChat }) => {
      mkdirSync(join(root, '.git'), { recursive: true })
      writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
      writeFileSync(join(root, 'notes.txt'), 'keep me')
      const legacy = await run(
        store.registerProject({
          project: {
            id: SCRATCH_PROJECT_ID,
            name: 'No project',
            isScratch: true,
            repositoryIdentity: join(root, '.git'),
            createdAt: at,
            updatedAt: at,
          },
          mainCheckout: { id: SCRATCH_ROOT_CHECKOUT_ID, kind: 'main', path: root, createdAt: at, branch: 'main' },
        }),
      )
      expect(await run(ensure)).toMatchObject({
        project: legacy.project,
        mainCheckout: legacy.mainCheckout,
        reused: true,
      })
      const detail = await run(store.getProject(SCRATCH_PROJECT_ID))
      const checkout = await run(
        prepareScratchCheckout(
          store,
          resolver,
          detail,
          await run(createChat('legacy-install-aabbccdd')),
          'A new chat',
          at,
        ),
      )
      expect(checkout).toMatchObject({ kind: 'directory', path: join(root, '2026-11-23-a-new-chat-aabbccdd') })
      expect(readFileSync(join(root, 'notes.txt'), 'utf8')).toBe('keep me')
      expect(existsSync(join(root, '.git', 'HEAD'))).toBe(true)
    }))

  it('claims a distinct folder for each chat and reuses the registered checkout on a retry', () =>
    withScratch(async ({ run, root, store, resolver, ensure, createChat }) => {
      await run(ensure)
      const detail = await run(store.getProject(SCRATCH_PROJECT_ID))
      const firstId = await run(createChat('chat-one-12345678'))
      const secondId = await run(createChat('chat-two-12345678'))
      const prompt = '  Fix THE API -- today and ignore this  '
      const [first, second] = await Promise.all(
        [firstId, secondId].map(id => run(prepareScratchCheckout(store, resolver, detail, id, prompt, at))),
      )
      expect(first.path).toBe(join(root, '2026-11-23-fix-the-api-today-12345678'))
      expect(second.path).toBe(join(root, '2026-11-23-fix-the-api-today-chat-two-12345678'))
      expect(await run(prepareScratchCheckout(store, resolver, detail, firstId, prompt, at))).toEqual(first)
      expect(await run(store.getProject(SCRATCH_PROJECT_ID))).toMatchObject({
        mainCheckout: detail.mainCheckout,
        totalOtherCheckouts: 2,
      })
    }))

  it('uses a random suffix after both names collide and preserves occupied paths', () =>
    withScratch(async ({ run, root, store, resolver, ensure, createChat }) => {
      await run(ensure)
      writeFileSync(join(root, '2026-11-23-11112222'), 'existing user file')
      mkdirSync(join(root, '2026-11-23-chat-11112222'))
      const detail = await run(store.getProject(SCRATCH_PROJECT_ID))
      const checkout = await run(
        prepareScratchCheckout(store, resolver, detail, await run(createChat('chat-11112222')), '?! 💬', at),
      )
      expect(basename(checkout.path)).toMatch(/^2026-11-23-chat-11112222-[a-f0-9]{8}$/)
      expect(readdirSync(checkout.path)).toEqual([])
      expect(readFileSync(join(root, '2026-11-23-11112222'), 'utf8')).toBe('existing user file')
    }))

  it('falls back when a deleted folder still belongs to another chat', () =>
    withScratch(async ({ run, root, store, resolver, ensure, createChat }) => {
      await run(ensure)
      const detail = await run(store.getProject(SCRATCH_PROJECT_ID))
      const firstId = await run(createChat('first-12345678'))
      const secondId = await run(createChat('second-12345678'))
      const first = await run(prepareScratchCheckout(store, resolver, detail, firstId, 'Example', at))
      rmdirSync(first.path)
      const second = await run(prepareScratchCheckout(store, resolver, detail, secondId, 'Example', at))
      expect(second.path).toBe(join(root, '2026-11-23-example-second-12345678'))
      expect(await run(prepareScratchCheckout(store, resolver, detail, firstId, 'Example', at))).toEqual(first)
    }))

  it('claims the folder through the provided Effect FileSystem and Path', () =>
    withScratch(async ({ run, root, store, resolver, ensure, createChat }) => {
      await run(ensure)
      const detail = await run(store.getProject(SCRATCH_PROJECT_ID))
      const conversationId = await run(createChat('effect-chat'))
      const fs = await run(FileSystem.FileSystem)
      const path = await run(Path.Path)
      const makeDirectory = vi.fn(fs.makeDirectory)
      const joined: Array<readonly string[]> = []
      const claimed = await run(
        prepareScratchCheckout(store, resolver, detail, conversationId, 'Example', at).pipe(
          Effect.provideService(FileSystem.FileSystem, { ...fs, makeDirectory }),
          Effect.provideService(Path.Path, {
            ...path,
            join(...segments) {
              joined.push(segments)
              return path.join(...segments)
            },
          }),
        ),
      )
      expect(joined).toContainEqual([root, basename(claimed.path)])
      expect(makeDirectory).toHaveBeenCalledWith(claimed.path, { recursive: false })
    }))

  it('limits the slug to 48 characters', () =>
    withScratch(async ({ run, root, store, resolver, ensure, createChat }) => {
      await run(ensure)
      const detail = await run(store.getProject(SCRATCH_PROJECT_ID))
      const checkout = await run(
        prepareScratchCheckout(store, resolver, detail, await run(createChat('chat-12345678')), 'A'.repeat(75), at),
      )
      expect(checkout.path).toBe(join(root, '2026-11-23-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-12345678'))
    }))

  it('registers one canonical folder per chat and checks conversation ownership at admission', () =>
    withScratch(async ({ run, root, profile, ensure, createChat, store }) => {
      await run(ensure)
      const owner = await run(createChat('folder-owner'))
      const unrelated = await run(createChat('unrelated-chat'))
      const otherProjectId = projectIdSchema.make('other-project')
      const outside = join(profile, 'outside')
      mkdirSync(outside)
      const alias = join(root, 'redirected')
      symlinkSync(outside, alias, 'junction')
      await run(
        store.registerProject({
          project: { id: otherProjectId, name: 'Other project', createdAt: at, updatedAt: at },
          mainCheckout: {
            id: workspaceCheckoutIdSchema.make('other-root'),
            kind: 'directory',
            path: outside,
            createdAt: at,
          },
        }),
      )
      const foreign = conversationIdSchema.make('foreign-chat')
      await run(
        store.createTask({
          task: {
            id: taskIdSchema.make('foreign-task'),
            projectId: otherProjectId,
            title: 'Foreign',
            description: '',
            createdAt: at,
          },
          conversation: { id: foreign, createdAt: at },
        }),
      )
      const path = join(root, 'owner')
      mkdirSync(path)
      const register = (commandId: string, conversationId = owner, folder = path) =>
        store.registerCheckout({
          commandId,
          checkout: {
            id: workspaceCheckoutIdSchema.make(commandId),
            projectId: SCRATCH_PROJECT_ID,
            scratchConversationId: conversationId,
            kind: 'directory',
            path: folder,
            createdAt: at,
          },
        })
      for (const invalid of [
        register('missing-owner', conversationIdSchema.make('missing-chat')),
        register('foreign-owner', foreign),
        register('outside-root', owner, outside),
        register('root-itself', owner, root),
        register('redirected-folder', owner, alias),
      ]) {
        await expect(run(invalid)).rejects.toMatchObject({ code: 'membership-conflict' })
      }

      const first = await run(register('register-first'))
      const secondPath = join(root, 'other-name')
      mkdirSync(secondPath)
      expect(await run(register('register-again', owner, secondPath))).toMatchObject({
        checkout: first.checkout,
        replayed: true,
      })
      expect((await run(store.getProject(SCRATCH_PROJECT_ID))).otherCheckouts).toEqual([first.checkout])
      const command: BeginRunCommand = {
        commandId: 'use-folder',
        runId: agentRunIdSchema.make('use-folder'),
        taskId: taskIdSchema.make('task-unrelated-chat'),
        conversationId: unrelated,
        checkoutId: first.checkout.id,
        issuedAt: at,
        provisionalAgentSessionId: 'provisional-folder',
        generation: 1,
        driverId: 'driver',
        connectionId: 'connection',
        prompt: 'Open the folder',
      }
      await expect(run(store.beginRun(command))).rejects.toMatchObject({ code: 'membership-conflict' })
    }))

  it('promotes a queued root ID into the stored Conversation checkout in the dequeue transaction', () =>
    withScratch(async ({ run, root, ensure, createChat, store }) => {
      await run(ensure)
      const conversationId = await run(createChat('queued-chat'))
      const taskId = taskIdSchema.make('task-queued-chat')
      const command: BeginRunCommand = {
        commandId: 'promote-chat',
        runId: agentRunIdSchema.make('promote-chat'),
        taskId,
        conversationId,
        checkoutId: SCRATCH_ROOT_CHECKOUT_ID,
        issuedAt: at,
        provisionalAgentSessionId: 'provisional-promotion',
        generation: 1,
        driverId: 'driver',
        connectionId: 'connection',
        prompt: 'Open the folder',
      }
      await run(store.enqueueFollowUp({ ...command, commandId: 'queue-root' }))
      const path = join(root, 'queued-chat')
      mkdirSync(path)
      const checkoutId = scratchCheckoutId(conversationId)
      await run(
        store.registerCheckout({
          commandId: 'register-after-enqueue',
          checkout: {
            id: checkoutId,
            projectId: SCRATCH_PROJECT_ID,
            kind: 'directory',
            path,
            createdAt: at,
            scratchConversationId: conversationId,
          },
        }),
      )
      const promoted = await run(store.promoteNextFollowUp(conversationId, command))
      expect(promoted?.followUp.checkoutId).toBe(checkoutId)
      expect((await run(store.readTaskSnapshot(taskId, 1))).runContexts?.[0]?.checkoutId).toBe(checkoutId)
    }))

  it.each(['directory', 'file'])('refuses an enclosing Git checkout with a .git %s', marker =>
    withScratch(async ({ run, profile, ensure }) => {
      if (marker === 'directory') {
        mkdirSync(join(profile, '.git'))
        writeFileSync(join(profile, '.git', 'HEAD'), 'ref: refs/heads/main\n')
      } else writeFileSync(join(profile, '.git'), 'gitdir: C:/repo/.git/worktrees/profile\n')
      expect(await run(ensure.pipe(Effect.flip))).toMatchObject({
        _tag: 'ScratchProjectInsideGitError',
        message: SCRATCH_INSIDE_GIT_MESSAGE,
      })
    }),
  )

  it('rejects a user Project at the fixed scratch ID', () =>
    withScratch(async ({ run, root, store, ensure }) => {
      await run(
        store.registerProject({
          project: { id: SCRATCH_PROJECT_ID, name: 'User project', createdAt: at, updatedAt: at },
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

  it('ignores a file named .git without a worktree pointer', () =>
    withScratch(async ({ run, profile, ensure }) => {
      writeFileSync(join(profile, '.git'), 'ordinary file')
      expect((await run(ensure)).mainCheckout.kind).toBe('directory')
    }))
})
