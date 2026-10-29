import { CommandRunnerLive } from '../src/infrastructure/process/command-runner.js'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as PlatformError from 'effect/PlatformError'
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner'
import * as Sink from 'effect/Sink'
import * as Stream from 'effect/Stream'
import { describe, expect, it } from 'vitest'

import { CommandError, CommandRunner } from '../src/core/ports/process.js'

function spawnerLayer(
  stdout: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  stderr: Stream.Stream<Uint8Array, PlatformError.PlatformError> = Stream.empty,
): Layer.Layer<CommandRunner> {
  const handle = ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout,
    stderr,
    all: Stream.merge(stdout, stderr),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  })
  const spawner = ChildProcessSpawner.make(() => Effect.succeed(handle))
  return CommandRunnerLive.pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)))
}

const bytes = (value: string) => new TextEncoder().encode(value)

describe('CommandRunner official spawner adapter', () => {
  it('fans stdout and stderr into independent streams and their merged stream', async () => {
    const layer = spawnerLayer(
      Stream.fromIterable([bytes('out-1'), bytes('out-2')]),
      Stream.fromIterable([bytes('err')]),
    )
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runner = yield* CommandRunner
          const handle = yield* runner.start('command', [], { pipeStderr: true })
          const [stdout, stderr, all] = yield* Effect.all(
            [handle.stdout, handle.stderr, handle.all].map(stream => Stream.mkString(Stream.decodeText(stream))),
            { concurrency: 'unbounded' },
          )
          return { stdout, stderr, all }
        }).pipe(Effect.provide(layer)),
      ),
    )

    expect(result.stdout).toBe('out-1out-2')
    expect(result.stderr).toBe('err')
    expect(result.all).toHaveLength(result.stdout.length + result.stderr.length)
    expect(result.all.split(/(?=err|out-)/).sort()).toEqual(['err', 'out-1', 'out-2'])
  })

  it('maps an upstream output-stream failure to CommandError reason stream', async () => {
    const cause = PlatformError.systemError({
      _tag: 'Unknown',
      module: 'ChildProcess',
      method: 'stdout',
      description: 'read failed',
    })
    const layer = spawnerLayer(Stream.fail(cause))
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runner = yield* CommandRunner
          const handle = yield* runner.start('command', [])
          return yield* Stream.runCollect(handle.stdout).pipe(Effect.flip)
        }).pipe(Effect.provide(layer)),
      ),
    )

    expect(error).toBeInstanceOf(CommandError)
    expect(error.reason).toBe('stream')
    expect(error.message).toContain('stdout')
  })

  it('maps a spawner acquisition error to CommandError reason spawn', async () => {
    const cause = PlatformError.systemError({
      _tag: 'NotFound',
      module: 'ChildProcess',
      method: 'spawn',
      description: 'missing executable',
    })
    const spawner = ChildProcessSpawner.make(() => Effect.fail(cause))
    const layer = CommandRunnerLive.pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)))
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runner = yield* CommandRunner
          return yield* runner.start('missing', []).pipe(Effect.flip)
        }).pipe(Effect.provide(layer)),
      ),
    )

    expect(error).toBeInstanceOf(CommandError)
    expect(error.reason).toBe('spawn')
  })
})
