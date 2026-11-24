import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve as resolvePath, sep } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import { afterAll, describe, expect, it } from 'vitest'

import {
  WorkspaceProjectSetup,
  WorkspaceProjectSetupLive,
} from '@/core/application/commands/workspace-project-setup.js'
import { WorkspaceProjectsLive } from '@/core/application/commands/workspace-projects.js'
import { CommandError, type CommandResult, CommandRunner, makeRecordingCommandRunner } from '@/core/ports/process.js'
import { ProjectProvisioner } from '@/core/ports/project-provisioner.js'
import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { CheckoutResolverLive } from '@/infrastructure/filesystem/checkout-resolver.js'
import {
  githubRepositoryName,
  originMatches,
  ProjectProvisionerLive,
} from '@/infrastructure/filesystem/project-provisioner.js'
import { NodePlatformLive } from '@/infrastructure/platform/platform-live.js'
import { CommandRunnerLive } from '@/infrastructure/process/command-runner.js'
import { WorkspaceStoreLive } from '@/infrastructure/sqlite/workspace/workspace-store.js'
import { projectIdSchema, workspaceCheckoutIdSchema } from '@/shared/schemas/workspace.js'

const cache = resolvePath('node_modules/.cache')
mkdirSync(cache, { recursive: true })
const root = mkdtempSync(join(cache, 'workspace-project-setup-'))
if (!resolvePath(root).startsWith(`${cache}${sep}`)) throw new Error('Unexpected fixture cleanup path')
afterAll(() => rmSync(root, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { windowsHide: true, stdio: 'pipe' })
    .toString()
    .trim()

const liveProvisioner = (commitFails = false) =>
  ProjectProvisionerLive.pipe(
    Layer.provide(
      Layer.effect(
        CommandRunner,
        Effect.map(CommandRunner, runner =>
          CommandRunner.of({
            ...runner,
            run: (command, args, options) =>
              commitFails && args[0] === 'commit'
                ? Effect.succeed({ stdout: '', exitCode: 128 })
                : runner.run(
                    command,
                    [
                      '-c',
                      'init.defaultBranch=trunk',
                      '-c',
                      'user.name=Test',
                      '-c',
                      'user.email=test@example.invalid',
                      '-c',
                      'commit.gpgSign=false',
                      '-c',
                      'core.hooksPath=/dev/null',
                      ...args,
                    ],
                    options,
                  ),
          }),
        ),
      ).pipe(Layer.provide(CommandRunnerLive)),
    ),
    Layer.provide(NodePlatformLive),
  )
const fakeProvisioner = (respond: (command: string, args: readonly string[]) => CommandResult) => {
  const runner = makeRecordingCommandRunner((command, args) => Effect.succeed(respond(command, args)))
  return {
    calls: runner.calls,
    layer: ProjectProvisionerLive.pipe(Layer.provide(runner.layer), Layer.provide(NodePlatformLive)),
  }
}
const provisioner = <A, E, UseError>(
  layer: Layer.Layer<ProjectProvisioner, E>,
  use: (service: ProjectProvisioner['Service']) => Effect.Effect<A, UseError>,
) => Effect.runPromise(Effect.flatMap(ProjectProvisioner, use).pipe(Effect.provide(layer)))

describe('ProjectProvisionerLive with real Git', () => {
  it('initializes Git in place with the configured branch and no working-tree changes or commits', async () => {
    const target = join(root, 'initialize-in-place')
    mkdirSync(target)
    writeFileSync(join(target, 'notes.md'), 'keep me')
    await provisioner(liveProvisioner(), service => service.initializeInPlace(target))
    expect(readdirSync(target).sort()).toEqual(['.git', 'notes.md'])
    expect(readFileSync(join(target, 'notes.md'), 'utf8')).toBe('keep me')
    expect(git(target, 'symbolic-ref', '--short', 'HEAD')).toBe('trunk')
    expect(git(target, 'rev-list', '--all', '--count')).toBe('0')
    expect(git(target, 'ls-files')).toBe('')
  })

  it('creates a missing folder as a repository and leaves an existing repository alone', async () => {
    const target = join(root, 'created', 'nested')
    await provisioner(liveProvisioner(), service => service.initialize(target, 'Project heading'))
    expect(git(target, 'rev-parse', '--is-inside-work-tree')).toBe('true')
    expect(git(target, 'branch', '--show-current')).toBe('trunk')
    expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('# Project heading\n')
    expect(git(target, 'log', '--format=%s')).toBe('Initial commit')
    writeFileSync(join(target, 'kept.txt'), 'kept')
    await provisioner(liveProvisioner(), service => service.initialize(target, 'Ignored heading'))
    expect(existsSync(join(target, 'kept.txt'))).toBe(true)
    expect(git(target, 'log', '--format=%s')).toBe('Initial commit')
    expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('# Project heading\n')
  })

  it('initializes an existing folder without touching its files', async () => {
    const target = join(root, 'plain')
    mkdirSync(target)
    writeFileSync(join(target, 'notes.md'), 'notes')
    await provisioner(liveProvisioner(), service => service.initialize(target, 'Plain'))
    expect(git(target, 'status', '--porcelain')).toBe('?? notes.md')
  })

  it('clones a local remote into a missing destination and refuses a non-empty one', async () => {
    const remote = join(root, 'remote')
    mkdirSync(remote)
    git(remote, 'init', '--quiet')
    git(
      remote,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'Initial',
    )
    const destination = join(root, 'clones', 'copy')
    await provisioner(liveProvisioner(), service => service.clone({ _tag: 'git', remoteUrl: remote }, destination))
    expect(git(destination, 'log', '--format=%s')).toBe('Initial')
    // A repeated command finds its own clone; another repository at the destination is refused.
    await provisioner(liveProvisioner(), service => service.clone({ _tag: 'git', remoteUrl: remote }, destination))
    const other = join(root, 'clones', 'other')
    mkdirSync(other)
    git(other, 'init', '--quiet')
    expect(
      await provisioner(liveProvisioner(), service =>
        service.clone({ _tag: 'git', remoteUrl: remote }, other).pipe(Effect.flip),
      ),
    ).toMatchObject({ code: 'target-not-empty' })
    const occupied = join(root, 'occupied')
    mkdirSync(occupied)
    writeFileSync(join(occupied, 'file.txt'), '')
    const refused = await provisioner(liveProvisioner(), service =>
      service.clone({ _tag: 'git', remoteUrl: remote }, occupied).pipe(Effect.flip),
    )
    expect(refused).toMatchObject({ code: 'target-not-empty' })
  })

  it('returns the install message when Git cannot start', async () => {
    const runner = CommandRunner.layerWithRunner(() =>
      Effect.fail(new CommandError({ reason: 'spawn', command: 'git', message: 'ENOENT' })),
    )
    const layer = ProjectProvisionerLive.pipe(Layer.provide(runner), Layer.provide(NodePlatformLive))
    expect(
      await provisioner(layer, service => service.initialize(join(root, 'no-git'), 'Project').pipe(Effect.flip)),
    ).toMatchObject({
      code: 'git-unavailable',
      message: "Git isn't installed on this machine. Install Git to create a project.",
    })
  })
})

describe('ProjectProvisionerLive with gh', () => {
  it('maps gh readiness and authentication failures to fixed codes', async () => {
    const signedOut = fakeProvisioner(() => ({ stdout: '', exitCode: 1 }))
    expect(await provisioner(signedOut.layer, service => service.readiness)).toEqual({ github: 'unauthenticated' })
    const needsAuth = fakeProvisioner(() => ({ stdout: '', exitCode: 4 }))
    expect(
      await provisioner(needsAuth.layer, service => service.lookupGitHubRepository('owner/repo').pipe(Effect.flip)),
    ).toMatchObject({ code: 'gh-unauthenticated' })
    const missing = fakeProvisioner(() => ({ stdout: '', exitCode: 1 }))
    expect(
      await provisioner(missing.layer, service => service.lookupGitHubRepository('owner/repo').pipe(Effect.flip)),
    ).toMatchObject({ code: 'remote-not-found' })
  })

  it('decodes a looked-up repository and clones GitHub sources through gh', async () => {
    const fake = fakeProvisioner((command, args) =>
      args[1] === 'view'
        ? { stdout: JSON.stringify({ nameWithOwner: 'Owner/Repo', url: 'https://github.com/Owner/Repo' }), exitCode: 0 }
        : { stdout: '', exitCode: 0 },
    )
    expect(await provisioner(fake.layer, service => service.lookupGitHubRepository('owner/repo'))).toEqual({
      nameWithOwner: 'Owner/Repo',
      url: 'https://github.com/Owner/Repo',
    })
    const destination = join(root, 'gh-clone')
    await provisioner(fake.layer, service => service.clone({ _tag: 'github', repository: 'Owner/Repo' }, destination))
    expect(fake.calls.at(-1)).toMatchObject({
      command: 'gh',
      args: ['repo', 'clone', 'Owner/Repo', resolvePath(destination), '--', '--quiet'],
      options: { env: { GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' } },
    })
  })

  it('publishes a private origin only when the checkout has none', async () => {
    const target = join(root, 'publish')
    const withOrigin = fakeProvisioner(() => ({ stdout: 'https://github.com/o/r.git\n', exitCode: 0 }))
    await provisioner(withOrigin.layer, service => service.publishToGitHub(target, 'My App'))
    expect(withOrigin.calls.map(call => call.command)).toEqual(['git'])
    const withoutOrigin = fakeProvisioner(command => ({ stdout: '', exitCode: command === 'git' ? 2 : 0 }))
    await provisioner(withoutOrigin.layer, service => service.publishToGitHub(target, 'My App'))
    expect(withoutOrigin.calls.at(-1)?.args).toEqual([
      'repo',
      'create',
      'My-App',
      '--private',
      '--source',
      resolvePath(target),
      '--remote',
      'origin',
    ])
  })

  it.each([
    ['My App', 'My-App'],
    ['--force', 'force'],
    ['.hidden', 'hidden'],
    ['ünïcode', 'n-code'],
  ])('derives the GitHub repository name from %s', (folder, expected) => {
    expect(githubRepositoryName(folder)).toBe(expected)
  })
})

describe('WorkspaceProjectSetup', () => {
  const runtime = (
    calls: string[],
    provisionerLayer = Layer.succeed(
      ProjectProvisioner,
      ProjectProvisioner.of({
        initialize: path =>
          Effect.sync(() => {
            calls.push(`init ${path}`)
            mkdirSync(path, { recursive: true })
            git(path, 'init', '--quiet')
          }),
        initializeInPlace: () => Effect.die('Unexpected in-place initialization'),
        clone: (source, path) =>
          Effect.sync(() => {
            calls.push(`clone ${source._tag} ${path}`)
            mkdirSync(path, { recursive: true })
            git(path, 'init', '--quiet')
          }),
        publishToGitHub: (path, name) => Effect.sync(() => void calls.push(`publish ${name}`)),
        lookupGitHubRepository: () => Effect.die('unused'),
        readiness: Effect.succeed({ github: 'ready' }),
      }),
    ),
  ) =>
    ManagedRuntime.make(
      WorkspaceProjectSetupLive.pipe(
        Layer.provideMerge(WorkspaceProjectsLive),
        Layer.provide(provisionerLayer),
        Layer.provideMerge(
          Layer.merge(
            WorkspaceStoreLive({ filename: ':memory:' }),
            CheckoutResolverLive.pipe(Layer.provide(CommandRunnerLive), Layer.provide(NodePlatformLive)),
          ),
        ),
        Layer.provide(NodePlatformLive),
      ),
    )
  const ids = (suffix: string) => ({
    commandId: `setup-${suffix}`,
    projectId: projectIdSchema.make(`project-${suffix}`),
    checkoutId: workspaceCheckoutIdSchema.make(`checkout-${suffix}`),
  })

  it('prepares, optionally publishes, then registers; a replay registers without publishing twice', async () => {
    const calls: string[] = []
    const app = runtime(calls)
    try {
      const setup = await app.runPromise(WorkspaceProjectSetup)
      const path = join(root, 'setup-new')
      const request = { ...ids('new'), path, name: 'setup-new', publish: 'github-private' as const }
      const created = await app.runPromise(setup.create(request))
      expect(created).toMatchObject({ project: { name: 'setup-new' }, replayed: false })
      expect(calls).toEqual([`init ${path}`, 'publish setup-new'])
      expect(await app.runPromise(setup.create({ ...request, publish: 'none' }))).toMatchObject({ replayed: true })
      expect(calls).toEqual([`init ${path}`, 'publish setup-new', `init ${path}`])
    } finally {
      await app.dispose()
    }
  })

  it('registers a new repository with a staged README when the initial commit fails', async () => {
    const app = runtime([], liveProvisioner(true))
    try {
      const setup = await app.runPromise(WorkspaceProjectSetup)
      const path = join(root, 'setup-uncommitted')
      const created = await app.runPromise(
        setup.create({ ...ids('uncommitted'), path, name: 'Uncommitted', publish: 'none' }),
      )
      expect(created.mainCheckout).toMatchObject({ kind: 'main', branch: 'trunk' })
      expect(git(path, 'status', '--porcelain')).toBe('A  README.md')
      expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('# Uncommitted\n')
    } finally {
      await app.dispose()
    }
  })

  it('replays a clone command into its original registration', async () => {
    const calls: string[] = []
    const path = join(root, 'setup-clone')
    const app = runtime(calls)
    try {
      const setup = await app.runPromise(WorkspaceProjectSetup)
      const request = {
        ...ids('clone'),
        path,
        name: 'setup-clone',
        source: { _tag: 'git' as const, remoteUrl: 'https://example.invalid/r.git' },
      }
      await app.runPromise(setup.clone(request))
      expect(await app.runPromise(setup.clone(request))).toMatchObject({ replayed: true })
      expect(calls).toEqual([`clone git ${path}`, `clone git ${path}`])
    } finally {
      await app.dispose()
    }
  })

  it('rejects option-shaped remotes before any provisioning', async () => {
    const calls: string[] = []
    const app = runtime(calls)
    try {
      const setup = await app.runPromise(WorkspaceProjectSetup)
      const failure = await app.runPromise(
        setup
          .clone({
            ...ids('bad'),
            path: join(root, 'bad'),
            name: 'bad',
            source: { _tag: 'git', remoteUrl: '--upload-pack=x' },
          })
          .pipe(Effect.flip),
      )
      expect(failure).toMatchObject({ code: 'invalid-input' })
      expect(calls).toEqual([])
    } finally {
      await app.dispose()
    }
  })

  it.each(['isScratch', 'isCoach'] as const)('refuses create and clone for a folder marked %s', async marker => {
    const calls: string[] = []
    const app = runtime(calls)
    const target = join(root, marker)
    const alias = join(root, `${marker}-alias`)
    mkdirSync(target)
    symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      const store = await app.runPromise(WorkspaceStore)
      const setup = await app.runPromise(WorkspaceProjectSetup)
      const at = '2026-10-30T08:00:00Z'
      const managed = ids(marker)
      await app.runPromise(
        store.registerProject({
          project: { id: managed.projectId, name: marker, [marker]: true, createdAt: at, updatedAt: at },
          mainCheckout: {
            id: managed.checkoutId,
            path: realpathSync.native(target),
            kind: 'directory',
            createdAt: at,
          },
        }),
      )
      const failure = { code: 'membership-conflict', message: 'This folder is managed by Watchtower.' }
      const request = { ...ids(`${marker}-new`), path: alias, name: 'Project' }
      expect(
        await app.runPromise(setup.create({ ...request, publish: 'github-private' }).pipe(Effect.flip)),
      ).toMatchObject(failure)
      expect(
        await app.runPromise(
          setup
            .clone({
              ...request,
              source: { _tag: 'git', remoteUrl: 'https://example.invalid/repo.git' },
            })
            .pipe(Effect.flip),
        ),
      ).toMatchObject(failure)
      expect(calls).toEqual([])
      expect(readdirSync(target)).toEqual([])
    } finally {
      await app.dispose()
    }
  })
})

describe('originMatches', () => {
  it.each([
    ['https://github.com/Owner/Repo.git', true],
    ['git@github.com:owner/repo.git', true],
    ['https://github.com/owner/repository.git', false],
    ['https://github.com/other/repo.git', false],
  ])('matches GitHub origin %s', (origin, expected) => {
    expect(originMatches(origin, { _tag: 'github', repository: 'owner/repo' }, resolvePath)).toBe(expected)
  })
})
