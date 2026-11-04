import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'

import { CheckoutResolverError } from '@/core/ports/checkout-resolver.js'
import type { CommandRunner } from '@/core/ports/process.js'
import type { CheckoutResolverErrorCode } from '@/shared/schemas/checkout.js'

export const gitFailure = (code: CheckoutResolverErrorCode, message: string) =>
  new CheckoutResolverError({ code, message })
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024
const GIT_TIMEOUT_MS = 10_000

export interface GitResult {
  readonly exitCode: number
  readonly stdout: string
}

/** Bounded Git runner. Output is capped, the call times out, and ambient Git overrides never redirect it. */
export function makeGitRunner(runner: CommandRunner['Service']) {
  const runGit = Effect.fn('Git.run')(function* (cwd: string, args: readonly string[]) {
    const operation = Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* runner
          .start('git', ['--no-optional-locks', ...args], {
            cwd,
            windowsHide: true,
            extendEnv: true,
            // Ambient Git overrides must not redirect identity or writes to another checkout.
            env: {
              GIT_DIR: undefined,
              GIT_WORK_TREE: undefined,
              GIT_COMMON_DIR: undefined,
              GIT_INDEX_FILE: undefined,
              GIT_OBJECT_DIRECTORY: undefined,
              GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
            },
          })
          .pipe(
            Effect.mapError(error =>
              gitFailure(error.reason === 'spawn' ? 'git-unavailable' : 'git-failed', error.message),
            ),
          )
        const chunks: Uint8Array[] = []
        let size = 0
        yield* Stream.runForEach(handle.stdout, chunk => {
          size += chunk.byteLength
          if (size > MAX_GIT_OUTPUT_BYTES) return Effect.fail(gitFailure('git-failed', 'Git output exceeded 1 MiB'))
          chunks.push(chunk)
          return Effect.void
        }).pipe(
          Effect.mapError(error =>
            error instanceof CheckoutResolverError ? error : gitFailure('git-failed', error.message),
          ),
        )
        const exitCode = yield* handle.exitCode.pipe(Effect.mapError(error => gitFailure('git-failed', error.message)))
        return { exitCode, stdout: Buffer.concat(chunks).toString('utf8') } satisfies GitResult
      }),
    )
    const result = yield* operation.pipe(Effect.timeoutOption(Duration.millis(GIT_TIMEOUT_MS)))
    if (Option.isNone(result)) return yield* gitFailure('git-failed', 'Git command timed out')
    return result.value
  })
  const gitText = Effect.fn('Git.text')(function* (cwd: string, args: readonly string[]) {
    const result = yield* runGit(cwd, args)
    if (result.exitCode !== 0)
      return yield* gitFailure('git-failed', `Git ${args[0]} failed with exit code ${result.exitCode}`)
    return result.stdout.replace(/\r?\n$/, '')
  })
  return { runGit, gitText }
}
