import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import { describe, expect, it } from 'vitest'

import { CommandError, makeRecordingCommandRunner } from '../src/main/agents/command-runner.js'
import { getRepoUrlEffect } from '../src/main/pipeline/git-remote.js'

function runWith(respond: Parameters<typeof makeRecordingCommandRunner>[0], cwd: string) {
  const { layer, calls } = makeRecordingCommandRunner(respond)
  const effect = getRepoUrlEffect(cwd).pipe(Effect.provide(layer))
  return { calls, effect }
}

describe('getRepoUrlEffect', () => {
  it('runs git origin lookup in the project directory with its bounded deadline', async () => {
    const { calls, effect } = runWith(
      () => Effect.succeed({ stdout: '  git@github.com:owner/repo.git\n', exitCode: 0 }),
      '/work/project',
    )

    await expect(Effect.runPromise(effect)).resolves.toBe('git@github.com:owner/repo.git')
    expect(calls).toEqual([
      {
        command: 'git',
        args: ['remote', 'get-url', 'origin'],
        options: { cwd: '/work/project', timeoutMs: 2000 },
      },
    ])
  })

  it('returns undefined for missing remotes and expected command failures', async () => {
    const nonzero = runWith(() => Effect.succeed({ stdout: 'ignored output', exitCode: 2 }), '/work/no-remote')
    const typedFailure = runWith(
      () => Effect.fail(new CommandError({ reason: 'spawn', message: 'git missing', command: 'git' })),
      '/work/no-git',
    )
    const timeout = runWith(
      () => Effect.fail(new CommandError({ reason: 'timeout', message: 'git timed out', command: 'git' })),
      '/work/timeout',
    )
    const empty = runWith(() => Effect.succeed({ stdout: '  \n', exitCode: 0 }), '/work/empty-remote')

    await expect(Effect.runPromise(nonzero.effect)).resolves.toBeUndefined()
    await expect(Effect.runPromise(typedFailure.effect)).resolves.toBeUndefined()
    await expect(Effect.runPromise(timeout.effect)).resolves.toBeUndefined()
    await expect(Effect.runPromise(empty.effect)).resolves.toBeUndefined()
  })

  it('does not turn defects into a missing remote', async () => {
    const defect = new Error('runner defect')
    const { effect } = runWith(() => Effect.die(defect), '/work/defect')

    await expect(Effect.runPromise(effect)).rejects.toBe(defect)
  })

  it('preserves fiber interruption while the runner is pending', async () => {
    let entered!: () => void
    const started = new Promise<void>(resolve => {
      entered = resolve
    })
    const { effect } = runWith(
      () =>
        Effect.gen(function* () {
          entered()
          return yield* Effect.never
        }),
      '/work/interrupted',
    )
    const fiber = Effect.runFork(effect)
    await started

    await Effect.runPromise(Fiber.interrupt(fiber))
    const exit = await Effect.runPromise(Fiber.await(fiber))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  })
})
