import * as Effect from 'effect/Effect'

import { CommandRunner } from '@/core/ports/process.js'
import type { SourceControlDiscovery } from '@/shared/rpc/source-control.js'

import { commandEnvironment, LOCAL_TIMEOUT_MS } from './project-provisioner.js'

/** `git version 2.43.0.windows.1` -> `2.43.0.windows.1`. */
export function parseGitVersion(output: string): string | null {
  return /^git version (\S+)/m.exec(output)?.[1] ?? null
}

/** `gh version 2.40.1 (2023-12-13)` -> `2.40.1`. */
export function parseGhVersion(output: string): string | null {
  return /^gh version (\S+)/m.exec(output)?.[1] ?? null
}

/**
 * The account from `gh config get user --host github.com`: a bare login read from the local hosts.yml. Empty output
 * means no account is recorded.
 */
export function parseGhConfigUser(output: string): string | null {
  const account = output.trim()
  return account === '' ? null : account
}

/** Every command discovery runs. All of them read local files, the keyring or version strings: none reaches the network. */
export const GH_TOKEN_PRESENCE_ARGS = ['auth', 'token', '--hostname', 'github.com'] as const
export const GH_ACCOUNT_ARGS = ['config', 'get', 'user', '--host', 'github.com'] as const

const probe = (tool: 'git' | 'gh', args: readonly string[]) =>
  Effect.gen(function* () {
    const runner = yield* CommandRunner
    return yield* runner.run(tool, args, {
      timeoutMs: LOCAL_TIMEOUT_MS,
      env: commandEnvironment,
      extendEnv: true,
      windowsHide: true,
    })
  }).pipe(Effect.result)

/**
 * Reads, without side effects and without the network, whether `git` and `gh` run on this computer and whether gh holds
 * a stored token for github.com. It never runs `gh auth status`, which validates credentials online. The token is
 * checked by exit code only: its output is dropped here and never returned or logged. The account name is never logged:
 * only the coarse states are.
 */
export const discoverSourceControl: Effect.Effect<SourceControlDiscovery, never, CommandRunner> = Effect.gen(
  function* () {
    const [gitResult, ghResult] = yield* Effect.all([probe('git', ['--version']), probe('gh', ['--version'])], {
      concurrency: 'unbounded',
    })
    const gitVersion =
      gitResult._tag === 'Success' && gitResult.success.exitCode === 0
        ? parseGitVersion(gitResult.success.stdout)
        : null
    const git = { available: gitVersion !== null, version: gitVersion }

    if (ghResult._tag === 'Failure' || ghResult.success.exitCode !== 0) {
      yield* Effect.logDebug('Source control discovery finished', { git: git.available, github: 'unavailable' })
      return { git, github: { cli: 'unavailable' as const, version: null, account: null } }
    }
    const version = parseGhVersion(ghResult.success.stdout)
    const hasToken = yield* probe('gh', GH_TOKEN_PRESENCE_ARGS).pipe(
      Effect.map(result => result._tag === 'Success' && result.success.exitCode === 0),
    )
    let account: string | null = null
    if (hasToken) {
      const configured = yield* probe('gh', GH_ACCOUNT_ARGS)
      account =
        configured._tag === 'Success' && configured.success.exitCode === 0
          ? parseGhConfigUser(configured.success.stdout)
          : null
    }
    const github = { cli: hasToken ? ('ready' as const) : ('unauthenticated' as const), version, account }
    yield* Effect.logDebug('Source control discovery finished', { git: git.available, github: github.cli })
    return { git, github }
  },
).pipe(Effect.withSpan('SourceControl.discover'))
