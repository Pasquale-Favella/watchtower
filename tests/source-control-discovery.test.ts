import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Logger from 'effect/Logger'
import * as References from 'effect/References'
import * as RpcTest from 'effect/rpc/RpcTest'
import { describe, expect, it } from 'vitest'

import { CommandError, type CommandRun, makeRecordingCommandRunner } from '@/core/ports/process.js'
import {
  discoverSourceControl,
  GH_ACCOUNT_ARGS,
  GH_TOKEN_PRESENCE_ARGS,
  parseGhConfigUser,
  parseGhVersion,
  parseGitVersion,
} from '@/infrastructure/filesystem/source-control-discovery.js'
import { sourceControlHandlers } from '@/platform/electron/main/rpc/source-control-handlers.js'
import { SourceControlRpcGroup } from '@/shared/rpc/source-control.js'

const ACCOUNT = 'octocat-private-login'
const TOKEN = 'gho_secretTokenValue1234567890'

const spawnFailure = (command: string) => Effect.fail(new CommandError({ reason: 'spawn', message: 'ENOENT', command }))

/** `token` is whether gh holds a stored token; `account` is what `gh config get user` prints. */
function fakeRunner(responses: { git?: string | null; gh?: string | null; token?: boolean; account?: string | null }) {
  const respond: CommandRun = (command, args) => {
    if (command === 'git') {
      return responses.git == null ? spawnFailure(command) : Effect.succeed({ stdout: responses.git, exitCode: 0 })
    }
    if (args[0] === '--version') {
      return responses.gh == null ? spawnFailure(command) : Effect.succeed({ stdout: responses.gh, exitCode: 0 })
    }
    if (args[0] === 'auth' && args[1] === 'token') {
      return Effect.succeed(responses.token ? { stdout: TOKEN + '\n', exitCode: 0 } : { stdout: '', exitCode: 1 })
    }
    if (args[0] === 'config') {
      return Effect.succeed(
        responses.account == null ? { stdout: '', exitCode: 1 } : { stdout: responses.account + '\n', exitCode: 0 },
      )
    }
    return Effect.fail(new CommandError({ reason: 'spawn', message: 'unexpected command', command }))
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

  it('reads the account gh recorded locally', () => {
    expect(parseGhConfigUser(`${ACCOUNT}\n`)).toBe(ACCOUNT)
    expect(parseGhConfigUser('  octocat \r\n')).toBe('octocat')
    expect(parseGhConfigUser('')).toBeNull()
    expect(parseGhConfigUser('\n')).toBeNull()
  })
})

describe('discoverSourceControl', () => {
  const run = (responses: Parameters<typeof fakeRunner>[0]) =>
    Effect.runPromise(discoverSourceControl.pipe(Effect.provide(fakeRunner(responses).layer)))

  it('reports a signed-in gh with its account', async () => {
    await expect(
      run({ git: 'git version 2.43.0', gh: 'gh version 2.40.1 (2023-12-13)', token: true, account: ACCOUNT }),
    ).resolves.toEqual({
      git: { available: true, version: '2.43.0' },
      github: { cli: 'ready', version: '2.40.1', account: ACCOUNT },
    })
  })

  it('reports a signed-out gh without an account', async () => {
    await expect(run({ git: 'git version 2.43.0', gh: 'gh version 2.40.1', account: ACCOUNT })).resolves.toEqual({
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

  it('reports a signed-in gh without a recorded account as ready with no account', async () => {
    await expect(run({ git: 'git version 2.43.0', gh: 'gh version 2.40.1', token: true })).resolves.toEqual({
      git: { available: true, version: '2.43.0' },
      github: { cli: 'ready', version: '2.40.1', account: null },
    })
  })

  it('runs only local commands, each time, and never gh auth status', async () => {
    const runner = fakeRunner({ git: 'git version 2.43.0', gh: 'gh version 2.40.1', token: true, account: ACCOUNT })
    await Effect.runPromise(discoverSourceControl.pipe(Effect.provide(runner.layer)))
    await Effect.runPromise(discoverSourceControl.pipe(Effect.provide(runner.layer)))
    const commands = runner.calls.map(call => [call.command, ...call.args].join(' '))
    expect(commands.slice().sort()).toEqual(
      [
        ...Array(2).fill([
          'git --version',
          'gh --version',
          'gh auth token --hostname github.com',
          'gh config get user --host github.com',
        ]),
      ]
        .flat()
        .sort(),
    )
    expect(commands.some(command => command.includes('auth status'))).toBe(false)
    expect(['gh', ...GH_TOKEN_PRESENCE_ARGS].join(' ')).toBe('gh auth token --hostname github.com')
    expect(['gh', ...GH_ACCOUNT_ARGS].join(' ')).toBe('gh config get user --host github.com')
    expect(runner.calls.every(call => call.options.env?.['GH_PROMPT_DISABLED'] === '1')).toBe(true)
  })

  it('does not look up the account when no token is stored', async () => {
    const runner = fakeRunner({ git: 'git version 2.43.0', gh: 'gh version 2.40.1', account: ACCOUNT })
    await expect(Effect.runPromise(discoverSourceControl.pipe(Effect.provide(runner.layer)))).resolves.toMatchObject({
      github: { cli: 'unauthenticated', account: null },
    })
    expect(runner.calls.map(call => call.args.join(' '))).not.toContain('config get user --host github.com')
  })

  it('never returns the token', async () => {
    const result = await run({ git: 'git version 2.43.0', gh: 'gh version 2.40.1', token: true, account: ACCOUNT })
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })

  it('never writes the account or token to the log', async () => {
    const lines: string[] = []
    const capture = Logger.make<unknown, undefined>(options => {
      lines.push(JSON.stringify([options.message, options.fiber.getRef(References.CurrentLogAnnotations)]))
    })
    const logging = Layer.merge(Logger.layer([capture]), Layer.succeed(References.MinimumLogLevel, 'All'))
    await Effect.runPromise(
      discoverSourceControl.pipe(
        Effect.provide(
          fakeRunner({ git: 'git version 2.43.0', gh: 'gh version 2.40.1', token: true, account: ACCOUNT }).layer,
        ),
        Effect.provide(logging),
      ),
    )
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.join('\n')).not.toContain(ACCOUNT)
    expect(lines.join('\n')).not.toContain(TOKEN)
  })
})

describe('sourceControl:discover RPC', () => {
  it('serves discovery through the handler layer', async () => {
    const handlers = sourceControlHandlers.pipe(
      Layer.provide(
        fakeRunner({ git: 'git version 2.43.0', gh: 'gh version 2.40.1', token: true, account: ACCOUNT }).layer,
      ),
    )
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(SourceControlRpcGroup)
        return yield* client['sourceControl:discover']({})
      }).pipe(Effect.scoped, Effect.provide(handlers)),
    )
    expect(result.github).toEqual({ cli: 'ready', version: '2.40.1', account: ACCOUNT })
    expect(JSON.stringify(result)).not.toContain(TOKEN)
    expect(result.git.available).toBe(true)
  })
})
