import * as Effect from 'effect/Effect'

import { CommandRunner } from '@/core/ports/process.js'
import type { SourceControlDiscovery } from '@/shared/rpc/source-control.js'

import { commandEnvironment, GH_AUTH_STATUS_ARGS, LOCAL_TIMEOUT_MS } from './project-provisioner.js'

/** `git version 2.43.0.windows.1` -> `2.43.0.windows.1`. */
export function parseGitVersion(output: string): string | null {
  return /^git version (\S+)/m.exec(output)?.[1] ?? null
}

/** `gh version 2.40.1 (2023-12-13)` -> `2.40.1`. */
export function parseGhVersion(output: string): string | null {
  return /^gh version (\S+)/m.exec(output)?.[1] ?? null
}

/**
 * The signed-in account from `gh auth status`: `Logged in to github.com account octocat (keyring)`, or
 * `Logged in to github.com as octocat` on older releases. When several accounts are signed in, the active one wins.
 */
export function parseGhAuthAccount(output: string): string | null {
  const pattern = /Logged in to \S+ (?:account|as) (\S+)/
  let latest: string | null = null
  let first: string | null = null
  for (const line of output.split(/\r?\n/)) {
    const account = pattern.exec(line)?.[1]
    if (account !== undefined) {
      latest = account
      first ??= account
    } else if (latest !== null && /Active account:\s*true/i.test(line)) {
      return latest
    }
  }
  return first
}

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
 * Reads, without side effects, whether `git` and `gh` run on this computer and whether gh is signed in.
 * Never fails and never logs the account name: only the coarse states are logged.
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
    const status = yield* probe('gh', GH_AUTH_STATUS_ARGS)
    const ready = status._tag === 'Success' && status.success.exitCode === 0
    const github = {
      cli: ready ? ('ready' as const) : ('unauthenticated' as const),
      version,
      account: ready ? parseGhAuthAccount(status.success.stdout) : null,
    }
    yield* Effect.logDebug('Source control discovery finished', { git: git.available, github: github.cli })
    return { git, github }
  },
).pipe(Effect.withSpan('SourceControl.discover'))
