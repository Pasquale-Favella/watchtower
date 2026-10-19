import * as Effect from 'effect/Effect'
import * as Stream from 'effect/Stream'
import { describe, expect, it } from 'vitest'

import { CommandRunner } from '../src/main/agents/command-runner.js'
import { CommandRunnerLiveLayer } from '../src/main/agents/command-runner-live.js'

describe('CommandRunner fast child startup', () => {
  it('keeps output from a child that writes and exits immediately', async () => {
    const captured = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* CommandRunner
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* runner.start(process.execPath, ['-e', 'process.stdout.write("fast-child-output")'])
            const exitCode = yield* handle.exitCode
            // Read only after exit: output must remain buffered across the
            // child finishing before the caller subscribes to stdout.
            const output = yield* Stream.mkString(Stream.decodeText(handle.stdout))
            return { output, exitCode }
          }),
        )
      }).pipe(Effect.provide(CommandRunnerLiveLayer)),
    )

    expect(captured).toEqual({ output: 'fast-child-output', exitCode: 0 })
  })
})
