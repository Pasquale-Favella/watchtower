import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Stream from 'effect/Stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CheckoutResolver } from '@/core/ports/checkout-resolver.js'
import { CommandError, CommandRunner } from '@/core/ports/process.js'
import { CheckoutResolverLive } from '@/infrastructure/filesystem/checkout-resolver.js'
import { NodePlatformLive } from '@/infrastructure/platform/platform-live.js'
import { CommandRunnerLive } from '@/infrastructure/process/command-runner.js'

const roots: string[] = []
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const fixture = () => {
  const root = mkdtempSync(join(process.cwd(), '.checkout-resolver-test-'))
  roots.push(root)
  // A bare boundary keeps non-repository fixtures from discovering Watchtower's checkout.
  git(root, 'init', '--bare', '--quiet')
  return root
}
const repository = (directory: string) => {
  mkdirSync(directory, { recursive: true })
  git(directory, 'init', '--quiet', '--initial-branch=main')
  git(directory, 'config', 'core.autocrlf', 'false')
  git(directory, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(directory, 'tracked.txt'), 'original\n')
  git(directory, 'add', '--', 'tracked.txt')
  git(
    directory,
    '-c',
    'user.name=Checkout Test',
    '-c',
    'user.email=checkout@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'Initial',
  )
  return directory
}
const withResolver = async (
  use: (resolver: CheckoutResolver['Service'], run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>) => Promise<void>,
  runnerLayer = CommandRunnerLive,
) => {
  const runtime = ManagedRuntime.make(
    CheckoutResolverLive.pipe(Layer.provideMerge(runnerLayer), Layer.provide(NodePlatformLive)),
  )
  try {
    await use(await runtime.runPromise(CheckoutResolver), effect => runtime.runPromise(effect))
  } finally {
    await runtime.dispose()
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('CheckoutResolver', () => {
  it('distinguishes Projects whose repository directories have the same leaf name', async () => {
    const root = fixture()
    const first = repository(join(root, 'first', 'same-name'))
    const second = repository(join(root, 'second', 'same-name'))
    await withResolver(async (resolver, run) => {
      const a = await run(resolver.resolve(first))
      const b = await run(resolver.resolve(second))
      expect(a).toMatchObject({
        kind: 'main',
        branch: 'main',
        mainCheckoutPath: a.canonicalPath,
        dirty: { trackedChanges: 0, untrackedCount: 0 },
      })
      expect(a.repositoryIdentity).not.toBe(b.repositoryIdentity)
      expect(a.headRevision).toMatch(/^[a-f0-9]{40,64}$/)
    })
  })

  it('creates an independent worktree without changing a dirty main checkout', async () => {
    const root = fixture()
    const main = repository(join(root, 'main'))
    writeFileSync(join(main, 'tracked.txt'), 'user changes\n')
    writeFileSync(join(main, 'untracked.txt'), 'user files\n')
    await withResolver(async (resolver, run) => {
      const before = await run(resolver.resolve(main))
      const created = await run(
        resolver.createIsolatedWorktree({
          repositoryPath: main,
          worktreePath: join(root, 'isolated'),
          branch: 'agent/task',
        }),
      )
      expect(created).toMatchObject({
        kind: 'worktree',
        branch: 'agent/task',
        repositoryIdentity: before.repositoryIdentity,
        mainCheckoutPath: before.canonicalPath,
        headRevision: before.headRevision,
        dirty: { trackedChanges: 0, untrackedCount: 0 },
      })
      expect(await run(resolver.resolve(main))).toEqual(before)
    })
  })
  it('removes only a clean linked worktree, preserving its main checkout and branch', async () => {
    const root = fixture()
    const main = repository(join(root, 'main'))
    const linked = join(root, 'linked')
    git(main, 'worktree', 'add', '--quiet', '-b', 'agent/remove', '--', linked)
    await withResolver(async (resolver, run) => {
      await run(resolver.removeWorktree({ worktreePath: linked, force: false }))
      await expect(run(resolver.resolve(linked))).rejects.toMatchObject({ code: 'path-missing' })
      expect(await run(resolver.resolve(main))).toMatchObject({ kind: 'main', branch: 'main' })
      await expect(
        run(resolver.createIsolatedWorktree({ repositoryPath: main, worktreePath: linked, branch: 'agent/remove' })),
      ).rejects.toMatchObject({ code: 'worktree-conflict' })
    })
  })

  it('maps a main checkout and a real linked worktree to one Project identity', async () => {
    const root = fixture()
    const main = repository(join(root, 'main'))
    const linked = join(root, 'linked')
    git(main, 'worktree', 'add', '--quiet', '-b', 'agent/linked', '--', linked)
    mkdirSync(join(linked, 'nested'))
    await withResolver(async (resolver, run) => {
      const a = await run(resolver.resolve(main))
      const b = await run(resolver.resolve(linked))
      expect(b).toMatchObject({
        kind: 'worktree',
        mainCheckoutPath: a.canonicalPath,
        repositoryIdentity: a.repositoryIdentity,
        branch: 'agent/linked',
        headRevision: a.headRevision,
      })
      expect(b.canonicalPath).not.toBe(a.canonicalPath)
      expect(await run(resolver.resolve(join(linked, 'nested')))).toEqual(b)
    })
  })

  it('reports missing paths, files and plain directories without fabricating a repository', async () => {
    const root = fixture()
    const directory = join(root, 'plain')
    mkdirSync(directory)
    const file = join(directory, 'file')
    writeFileSync(file, 'not a directory')
    await withResolver(async (resolver, run) => {
      await expect(run(resolver.resolve(join(root, 'missing')))).rejects.toMatchObject({ code: 'path-missing' })
      await expect(run(resolver.resolve(file))).rejects.toMatchObject({ code: 'not-a-directory' })
      expect(await run(resolver.resolve(directory))).toMatchObject({
        kind: 'directory',
        repositoryIdentity: null,
        mainCheckoutPath: null,
        branch: null,
        headRevision: null,
      })
      await expect(
        run(
          resolver.createIsolatedWorktree({
            repositoryPath: directory,
            worktreePath: join(root, 'target'),
            branch: 'agent/not-git',
          }),
        ),
      ).rejects.toMatchObject({ code: 'not-a-repository' })
      await expect(run(resolver.removeWorktree({ worktreePath: directory, force: false }))).rejects.toMatchObject({
        code: 'not-a-repository',
      })
    })
  })

  it('counts tracked modifications and every untracked file, including unusual filenames', async () => {
    const root = fixture()
    const main = repository(join(root, 'main'))
    writeFileSync(join(main, 'tracked.txt'), 'modified\n')
    mkdirSync(join(main, 'untracked'))
    writeFileSync(join(main, 'untracked', 'one.txt'), 'one')
    writeFileSync(join(main, 'untracked', 'two with spaces.txt'), 'two')
    await withResolver(async (resolver, run) => {
      expect((await run(resolver.resolve(main))).dirty).toEqual({
        trackedChanges: 1,
        untrackedCount: 2,
        ignoredCount: 0,
      })
    })
  })

  it('reports a detached HEAD without treating its revision as a branch', async () => {
    const root = fixture()
    const main = repository(join(root, 'main'))
    const head = git(main, 'rev-parse', 'HEAD')
    git(main, 'checkout', '--quiet', '--detach')
    await withResolver(async (resolver, run) => {
      expect(await run(resolver.resolve(main))).toMatchObject({ kind: 'main', branch: null, headRevision: head })
    })
  })

  it('resolves an unborn main checkout without inventing a commit', async () => {
    const root = fixture()
    const main = join(root, 'unborn')
    mkdirSync(main)
    git(main, 'init', '--quiet', '--initial-branch=main')
    await withResolver(async (resolver, run) => {
      expect(await run(resolver.resolve(main))).toMatchObject({ kind: 'main', branch: 'main', headRevision: null })
      await expect(
        run(
          resolver.createIsolatedWorktree({
            repositoryPath: main,
            worktreePath: join(root, 'target'),
            branch: 'agent/unborn',
          }),
        ),
      ).rejects.toMatchObject({ code: 'invalid-input' })
    })
  })

  it.skipIf(process.platform !== 'win32')(
    'collapses Windows case aliases to the same canonical checkout path',
    async () => {
      const root = fixture()
      const main = repository(join(root, 'MixedCase'))
      await withResolver(async (resolver, run) => {
        const original = await run(resolver.resolve(main))
        const alias = await run(resolver.resolve(main.toUpperCase()))
        expect(alias).toEqual(original)
      })
    },
  )

  it('collapses a symlink or Windows junction to the same canonical checkout path', async context => {
    const root = fixture()
    const main = repository(join(root, 'main'))
    const link = join(root, 'alias')
    try {
      symlinkSync(main, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'EACCES')
        context.skip()
      throw error
    }
    await withResolver(async (resolver, run) => {
      const original = await run(resolver.resolve(main))
      expect(await run(resolver.resolve(link))).toEqual(original)
      await expect(run(resolver.removeWorktree({ worktreePath: link, force: false }))).rejects.toMatchObject({
        code: 'worktree-conflict',
      })
      expect(readFileSync(join(main, 'tracked.txt'), 'utf8')).toBe('original\n')
    })
  })

  it('refuses non-empty and file worktree targets without changing user files', async () => {
    const root = fixture()
    const main = repository(join(root, 'main'))
    const target = join(root, 'occupied')
    mkdirSync(target)
    const userFile = join(target, 'user.txt')
    writeFileSync(userFile, 'keep me')
    await withResolver(async (resolver, run) => {
      for (const worktreePath of [target, userFile, main]) {
        await expect(
          run(resolver.createIsolatedWorktree({ repositoryPath: main, worktreePath, branch: 'agent/conflict' })),
        ).rejects.toMatchObject({ code: 'worktree-conflict' })
      }
      expect(readFileSync(userFile, 'utf8')).toBe('keep me')
      expect(await run(resolver.resolve(main))).toMatchObject({ kind: 'main', branch: 'main' })
    })
  })

  it('refuses an existing branch instead of resetting it', async () => {
    const root = fixture()
    const main = repository(join(root, 'main'))
    await withResolver(async (resolver, run) => {
      await expect(
        run(
          resolver.createIsolatedWorktree({ repositoryPath: main, worktreePath: join(root, 'target'), branch: 'main' }),
        ),
      ).rejects.toMatchObject({ code: 'worktree-conflict' })
      expect(await run(resolver.resolve(main))).toMatchObject({ kind: 'main', branch: 'main' })
    })
  })

  it('creates at an explicit older revision in an existing empty target directory', async () => {
    const root = fixture()
    const main = repository(join(root, 'main'))
    const base = git(main, 'rev-parse', 'HEAD')
    writeFileSync(join(main, 'tracked.txt'), 'second revision\n')
    git(main, 'add', '--', 'tracked.txt')
    git(
      main,
      '-c',
      'user.name=Checkout Test',
      '-c',
      'user.email=checkout@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'Second',
    )
    const target = join(root, 'empty')
    mkdirSync(target)
    await withResolver(async (resolver, run) => {
      expect(
        await run(
          resolver.createIsolatedWorktree({
            repositoryPath: main,
            worktreePath: target,
            branch: 'agent/base',
            baseRevision: base,
          }),
        ),
      ).toMatchObject({ kind: 'worktree', canonicalPath: realpathSync.native(target), headRevision: base })
      expect(readFileSync(join(target, 'tracked.txt'), 'utf8')).toBe('original\n')
      expect(readFileSync(join(main, 'tracked.txt'), 'utf8')).toBe('second revision\n')
    })
  })

  it.each(['tracked', 'untracked', 'ignored'] as const)(
    'refuses to remove a worktree containing %s user changes',
    async kind => {
      const root = fixture()
      const main = repository(join(root, 'main'))
      const linked = join(root, 'linked')
      git(main, 'worktree', 'add', '--quiet', '-b', 'agent/dirty', '--', linked)
      if (kind === 'tracked') writeFileSync(join(linked, 'tracked.txt'), 'user changes\n')
      else if (kind === 'untracked') writeFileSync(join(linked, 'untracked.txt'), 'user files\n')
      else {
        writeFileSync(join(main, '.git', 'info', 'exclude'), 'ignored.txt\n')
        writeFileSync(join(linked, 'ignored.txt'), 'ignored user files\n')
      }
      await withResolver(async (resolver, run) => {
        await expect(run(resolver.removeWorktree({ worktreePath: linked, force: false }))).rejects.toMatchObject({
          code: 'dirty-checkout',
        })
        expect(await run(resolver.resolve(linked))).toMatchObject({ kind: 'worktree', branch: 'agent/dirty' })
      })
    },
  )

  it('never removes a main checkout and rejects a forced removal request', async () => {
    const root = fixture()
    const main = repository(join(root, 'main'))
    await withResolver(async (resolver, run) => {
      await expect(run(resolver.removeWorktree({ worktreePath: main, force: false }))).rejects.toMatchObject({
        code: 'worktree-conflict',
      })
      await expect(run(resolver.removeWorktree({ worktreePath: main, force: true } as never))).rejects.toMatchObject({
        code: 'invalid-input',
      })
      expect(await run(resolver.resolve(main))).toMatchObject({ kind: 'main', branch: 'main' })
    })
  })

  it.each(['-unsafe', 'invalid..branch', 'HEAD'])('rejects invalid branch %s before mutation', async branch => {
    const root = fixture()
    const main = repository(join(root, 'main'))
    await withResolver(async (resolver, run) => {
      await expect(
        run(resolver.createIsolatedWorktree({ repositoryPath: main, worktreePath: join(root, 'target'), branch })),
      ).rejects.toMatchObject({ code: 'invalid-input' })
      await expect(run(resolver.resolve(join(root, 'target')))).rejects.toMatchObject({ code: 'path-missing' })
    })
  })

  it('rejects invalid path input with a typed error', async () => {
    await withResolver(async (resolver, run) => {
      for (const path of ['', 'bad\0path'])
        await expect(run(resolver.resolve(path))).rejects.toMatchObject({ code: 'invalid-input' })
    })
  })

  it('ignores inherited Git directory, worktree and index overrides', async () => {
    const root = fixture()
    const main = repository(join(root, 'main'))
    const unrelated = repository(join(root, 'unrelated'))
    vi.stubEnv('GIT_DIR', join(unrelated, '.git'))
    vi.stubEnv('GIT_WORK_TREE', unrelated)
    vi.stubEnv('GIT_INDEX_FILE', join(unrelated, '.git', 'index'))
    await withResolver(async (resolver, run) => {
      expect(await run(resolver.resolve(main))).toMatchObject({
        kind: 'main',
        canonicalPath: realpathSync.native(main),
        repositoryIdentity: realpathSync.native(join(main, '.git')),
        mainCheckoutPath: realpathSync.native(main),
      })
    })
  })

  it('returns a typed failure when Git cannot be spawned', async () => {
    const root = fixture()
    const error = new CommandError({ reason: 'spawn', command: 'git', message: 'git is unavailable' })
    const unavailable = CommandRunner.layerWithRunner(
      () => Effect.fail(error),
      () => Effect.fail(error),
    )
    await withResolver(async (resolver, run) => {
      await expect(run(resolver.resolve(root))).rejects.toMatchObject({ code: 'git-unavailable' })
    }, unavailable)
  })

  it('refuses oversized Git output instead of accepting incomplete checkout evidence', async () => {
    const root = fixture()
    const oversized = CommandRunner.layerWithRunner(
      () => Effect.succeed({ stdout: '', exitCode: 0 }),
      () =>
        Effect.succeed({
          pid: -1,
          exitCode: Effect.succeed(0),
          isRunning: Effect.succeed(false),
          stdout: Stream.succeed(new Uint8Array(1024 * 1024 + 1)),
          stderr: Stream.empty,
          all: Stream.empty,
          kill: Effect.void,
        }),
    )
    await withResolver(async (resolver, run) => {
      await expect(run(resolver.resolve(root))).rejects.toMatchObject({
        code: 'git-failed',
        message: 'Git output exceeded 1 MiB',
      })
    }, oversized)
  })

  it('bounds a stalled Git spawn with a typed timeout', async () => {
    const root = fixture()
    const stalled = CommandRunner.layerWithRunner(
      () => Effect.never,
      () => Effect.never,
    )
    await withResolver(async (resolver, run) => {
      await expect(run(resolver.resolve(root))).rejects.toMatchObject({
        code: 'git-failed',
        message: 'Git command timed out',
      })
    }, stalled)
  })
})
