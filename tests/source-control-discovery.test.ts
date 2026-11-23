import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Logger from 'effect/Logger'
import * as References from 'effect/References'
import * as RpcTest from 'effect/rpc/RpcTest'
import { describe, expect, it } from 'vitest'

import { CommandError, type CommandRun, makeRecordingCommandRunner } from '@/core/ports/process.js'
import {
  discoverSourceControl,
  parseGhAuthAccount,
  parseGhVersion,
  parseGitVersion,
} from '@/infrastructure/filesystem/source-control-discovery.js'
import { sourceControlHandlers } from '@/platform/electron/main/rpc/source-control-handlers.js'
import { SourceControlRpcGroup } from '@/shared/rpc/source-control.js'

const ACCOUNT = 'octocat-private-login'
const AUTH_STATUS = [
  'github.com',
  `  ✓ Logged in to github.com account ${ACCOUNT} (keyring)`,
  '  - Active account: true',
  '  - Git operations protocol: https',
  "  - Token scopes: 'repo'",
].join('\n')

const spawnFailure = (command: string) => Effect.fail(new CommandError({ reason: 'spawn', message: 'ENOENT', command }))

function fakeRunner(responses: { git?: string | null; gh?: string | null; auth?: string | null }) {
  const respond: CommandRun = (command, args) => {
    if (command === 'git') {
      return responses.git == null ? spawnFailure(command) : Effect.succeed({ stdout: responses.git, exitCode: 0 })
    }
    if (args[0] === '--version') {
      return responses.gh == null ? spawnFailure(command) : Effect.succeed({ stdout: responses.gh, exitCode: 0 })
    }
    return Effect.succeed({ stdout: responses.auth ?? '', exitCode: responses.auth == null ? 1 : 0 })
  }
  return makeRecordingCommandRunner(respond)
}

describe('source control output parsing', () => {
  it('reads the git version', () => {
    expect(parseGitVersion('git version 2.43.0.windows.1\n')).toBe('2.43.0.windows.1')
    expect(parseGitVersion('git version 2.39.5 (Apple Git-154)')).toBe('2.39.5')
    expect(parseGitVersion('command not found')).toBeNull()
  })

  it('reads the gh version', () => {
    expect(parseGhVersion('gh version 2.40.1 (2023-12-13)\nhttps://github.com/cli/cli/releases/tag/v2.40.1')).toBe(
      '2.40.1',
    )
    expect(parseGhVersion('')).toBeNull()
  })

  it('reads the signed-in account in both gh output formats', () => {
    expect(parseGhAuthAccount(AUTH_STATUS)).toBe(ACCOUNT)
    expect(parseGhAuthAccount('github.com\n  ✓ Logged in to github.com as octocat (oauth_token)')).toBe('octocat')
    expect(parseGhAuthAccount('You are not logged into any GitHub hosts.')).toBeNull()
  })

  it('prefers the active account when several are signed in', () => {
    const output = [
      'github.com',
      '  ✓ Logged in to github.com account first (keyring)',
      '  - Active account: false',
      '  ✓ Logged in to github.com account second (keyring)',
      '  - Active account: true',
    ].join('\n')
    expect(parseGhAuthAccount(output)).toBe('second')
  })
})

describe('discoverSourceControl', () => {
  const run = (responses: Parameters<typeof fakeRunner>[0]) =>
    Effect.runPromise(discoverSourceControl.pipe(Effect.provide(fakeRunner(responses).layer)))

  it('reports a signed-in gh with its account', async () => {
    await expect(
      run({ git: 'git version 2.43.0', gh: 'gh version 2.40.1 (2023-12-13)', auth: AUTH_STATUS }),
    ).resolves.toEqual({
      git: { available: true, version: '2.43.0' },
      github: { cli: 'ready', version: '2.40.1', account: ACCOUNT },
    })
  })

  it('reports a signed-out gh without an account', async () => {
    await expect(run({ git: 'git version 2.43.0', gh: 'gh version 2.40.1' })).resolves.toEqual({
      git: { available: true, version: '2.43.0' },
      github: { cli: 'unauthenticated', version: '2.40.1', account: null },
    })
  })

  it('reports missing tools as unavailable instead of failing', async () => {
    await expect(run({})).resolves.toEqual({
      git: { available: false, version: null },
      github: { cli: 'unavailable', version: null, account: null },
    })
  })

  it('asks the same read-only questions as project readiness, each time', async () => {
    const runner = fakeRunner({ git: 'git version 2.43.0', gh: 'gh version 2.40.1', auth: AUTH_STATUS })
    await Effect.runPromise(discoverSourceControl.pipe(Effect.provide(runner.layer)))
    await Effect.runPromise(discoverSourceControl.pipe(Effect.provide(runner.layer)))
    const commands = runner.calls.map(call => [call.command, ...call.args].join(' '))
    expect(commands.filter(command => command === 'gh auth status --hostname github.com')).toHaveLength(2)
    expect(commands).toContain('git --version')
    expect(runner.calls.every(call => call.options.env?.['GH_PROMPT_DISABLED'] === '1')).toBe(true)
  })

  it('never writes the account to the log', async () => {
    const lines: string[] = []
    const capture = Logger.make<unknown, undefined>(options => {
      lines.push(JSON.stringify([options.message, options.fiber.getRef(References.CurrentLogAnnotations)]))
    })
    const logging = Layer.merge(Logger.layer([capture]), Layer.succeed(References.MinimumLogLevel, 'All'))
    await Effect.runPromise(
      discoverSourceControl.pipe(
        Effect.provide(fakeRunner({ git: 'git version 2.43.0', gh: 'gh version 2.40.1', auth: AUTH_STATUS }).layer),
        Effect.provide(logging),
      ),
    )
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.join('\n')).not.toContain(ACCOUNT)
  })
})

describe('sourceControl:discover RPC', () => {
  it('serves discovery through the handler layer', async () => {
    const handlers = sourceControlHandlers.pipe(
      Layer.provide(fakeRunner({ git: 'git version 2.43.0', gh: 'gh version 2.40.1', auth: AUTH_STATUS }).layer),
    )
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(SourceControlRpcGroup)
        return yield* client['sourceControl:discover']({})
      }).pipe(Effect.scoped, Effect.provide(handlers)),
    )
    expect(result.github).toEqual({ cli: 'ready', version: '2.40.1', account: ACCOUNT })
    expect(result.git.available).toBe(true)
  })
})
