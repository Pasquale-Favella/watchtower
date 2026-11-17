import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'

import { type CommandResult, CommandRunner } from '@/core/ports/process.js'
import { ProjectProvisioner, ProjectSetupError } from '@/core/ports/project-provisioner.js'
import {
  type ProjectRemoteSource,
  type ProjectSetupErrorCode,
  remoteRepositorySchema,
} from '@/shared/schemas/workspace-projects.js'

const LOCAL_TIMEOUT_MS = 10_000
const NETWORK_TIMEOUT_MS = 60_000
const CLONE_TIMEOUT_MS = 10 * 60_000
/** gh's documented exit status when a command needs authentication. */
const GH_AUTH_REQUIRED = 4

// No terminal is attached, and ambient Git overrides must not redirect writes to another checkout.
const env = {
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  GIT_TERMINAL_PROMPT: '0',
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
}
const decodeRepository = Schema.decodeUnknownEffect(Schema.fromJsonString(remoteRepositorySchema))
const fail = (code: ProjectSetupErrorCode) => Effect.fail(ProjectSetupError.of(code))

/** gh stores an HTTPS or SSH origin depending on its protocol setting; local remotes may be stored resolved. */
export function originMatches(origin: string, source: ProjectRemoteSource, resolve: (path: string) => string): boolean {
  if (source._tag === 'github') {
    const normalized = origin.toLowerCase().replace(/\.git$/, '')
    const repository = source.repository.toLowerCase()
    return normalized.endsWith(`/${repository}`) || normalized.endsWith(`:${repository}`)
  }
  return origin === source.remoteUrl || resolve(origin) === resolve(source.remoteUrl)
}

/** gh repository names allow letters, digits, `.`, `-` and `_`. */
export function githubRepositoryName(folderName: string): string {
  return folderName.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '')
}

export const ProjectProvisionerLive = Layer.effect(
  ProjectProvisioner,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const runner = yield* CommandRunner

    const exec = (
      tool: 'git' | 'gh',
      args: readonly string[],
      options: { readonly cwd?: string; readonly timeoutMs: number },
    ): Effect.Effect<CommandResult, ProjectSetupError> =>
      runner
        .run(tool, args, { cwd: options.cwd, timeoutMs: options.timeoutMs, env, extendEnv: true, windowsHide: true })
        .pipe(
          Effect.catchTag('CommandError', error =>
            fail(error.reason === 'timeout' ? 'timeout' : tool === 'git' ? 'git-unavailable' : 'gh-unavailable'),
          ),
        )
    const ghFailure = (result: CommandResult, otherwise: ProjectSetupErrorCode) =>
      fail(result.exitCode === GH_AUTH_REQUIRED ? 'gh-unauthenticated' : otherwise)

    const isRepository = (directory: string) =>
      fs.exists(path.join(directory, '.git')).pipe(Effect.orElseSucceed(() => false))

    /** Missing, or an empty directory; anything else would be overwritten or merged into. */
    const ensureVacant = Effect.fnUntraced(function* (target: string) {
      const stat = yield* fs.stat(target).pipe(Effect.option)
      if (stat._tag === 'None') return
      if (stat.value.type !== 'Directory') return yield* fail('target-not-empty')
      const entries = yield* fs.readDirectory(target).pipe(Effect.orElseSucceed(() => ['unreadable']))
      if (entries.length > 0) return yield* fail('target-not-empty')
    })

    const initialize = Effect.fn('ProjectProvisioner.initialize')(function* (input: string) {
      const target = path.resolve(input)
      if (yield* isRepository(target)) return
      yield* fs
        .makeDirectory(target, { recursive: true })
        .pipe(Effect.mapError(() => ProjectSetupError.of('init-failed')))
      const result = yield* exec('git', ['init', '--quiet', '--', target], { timeoutMs: LOCAL_TIMEOUT_MS })
      if (result.exitCode !== 0) return yield* fail('init-failed')
    })

    /** A repeated clone command finds its own finished clone: a repository whose `origin` is this source. */
    const holdsClone = Effect.fnUntraced(function* (target: string, source: ProjectRemoteSource) {
      if (!(yield* isRepository(target))) return false
      const origin = yield* exec('git', ['remote', 'get-url', 'origin'], { cwd: target, timeoutMs: LOCAL_TIMEOUT_MS })
      return origin.exitCode === 0 && originMatches(origin.stdout.trim(), source, path.resolve)
    })

    const clone = Effect.fn('ProjectProvisioner.clone')(function* (source: ProjectRemoteSource, destination: string) {
      const target = path.resolve(destination)
      if (yield* holdsClone(target, source)) return
      yield* ensureVacant(target)
      const result =
        source._tag === 'github'
          ? yield* exec('gh', ['repo', 'clone', source.repository, target, '--', '--quiet'], {
              timeoutMs: CLONE_TIMEOUT_MS,
            })
          : yield* exec('git', ['-c', 'protocol.ext.allow=never', 'clone', '--quiet', '--', source.remoteUrl, target], {
              timeoutMs: CLONE_TIMEOUT_MS,
            })
      if (result.exitCode === 0) return
      return yield* source._tag === 'github' ? ghFailure(result, 'clone-failed') : fail('clone-failed')
    })

    const publishToGitHub = Effect.fn('ProjectProvisioner.publishToGitHub')(function* (input: string, name: string) {
      const target = path.resolve(input)
      const origin = yield* exec('git', ['remote', 'get-url', 'origin'], { cwd: target, timeoutMs: LOCAL_TIMEOUT_MS })
      if (origin.exitCode === 0) return
      const repository = githubRepositoryName(name)
      if (!repository) return yield* fail('publish-failed')
      const result = yield* exec(
        'gh',
        ['repo', 'create', repository, '--private', '--source', target, '--remote', 'origin'],
        { cwd: target, timeoutMs: NETWORK_TIMEOUT_MS },
      )
      if (result.exitCode !== 0) return yield* ghFailure(result, 'publish-failed')
    })

    const lookupGitHubRepository = Effect.fn('ProjectProvisioner.lookupGitHubRepository')(function* (
      repository: string,
    ) {
      const result = yield* exec('gh', ['repo', 'view', repository, '--json', 'nameWithOwner,url'], {
        timeoutMs: NETWORK_TIMEOUT_MS,
      })
      if (result.exitCode !== 0) return yield* ghFailure(result, 'remote-not-found')
      return yield* decodeRepository(result.stdout).pipe(
        Effect.mapError(() => ProjectSetupError.of('remote-not-found')),
      )
    })

    // Suspended so each read spawns `gh` again; sign-in state changes outside the application.
    const readiness = Effect.suspend(() =>
      exec('gh', ['auth', 'status', '--hostname', 'github.com'], { timeoutMs: LOCAL_TIMEOUT_MS }),
    ).pipe(
      Effect.map(result => ({ github: result.exitCode === 0 ? ('ready' as const) : ('unauthenticated' as const) })),
      Effect.catch(error =>
        Effect.succeed({
          github: error.code === 'gh-unavailable' ? ('unavailable' as const) : ('unauthenticated' as const),
        }),
      ),
      Effect.withSpan('ProjectProvisioner.readiness'),
    )

    return ProjectProvisioner.of({ initialize, clone, publishToGitHub, lookupGitHubRepository, readiness })
  }),
)
