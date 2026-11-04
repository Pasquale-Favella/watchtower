import { dirname } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'

import { CheckoutActions } from '@/core/ports/checkout-actions.js'
import { CommandRunner } from '@/core/ports/process.js'
import { checkoutFilePathSchema } from '@/shared/schemas/checkout-inspection.js'
import {
  CheckoutActionError,
  checkoutActionMessages,
  type CheckoutGitFile,
  type CheckoutGitStatus,
} from '@/shared/schemas/workspace-checkout-actions.js'

import { runGit } from './checkout-inspector-git.js'
import { canonicalPath, resolveInCanonicalRoot } from './checkout-inspector-paths.js'

function failure(code: CheckoutActionError['code']): CheckoutActionError {
  return new CheckoutActionError({ code, message: checkoutActionMessages[code] })
}

/** Porcelain's NUL format preserves spaces and newlines in paths, including rename pairs. */
export function parseCheckoutGitStatus(output: string): CheckoutGitStatus {
  const records = output.split('\0')
  const files: CheckoutGitFile[] = []
  let truncated = false
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (!record || record.length < 4) continue
    const path = record.slice(3)
    const x = record[0] ?? ' '
    const y = record[1] ?? ' '
    let previousPath: string | undefined
    if ('RC'.includes(x) || 'RC'.includes(y)) previousPath = records[++index]
    if (
      !Schema.is(checkoutFilePathSchema)(path) ||
      (previousPath && !Schema.is(checkoutFilePathSchema)(previousPath))
    ) {
      truncated = true
      continue
    }
    if (files.length === 2000) {
      truncated = true
      break
    }
    files.push({ path, index: x, workingTree: y, ...(previousPath ? { previousPath } : {}) })
  }
  return { files, truncated }
}

export const CheckoutActionsLive = Layer.effect(
  CheckoutActions,
  Effect.gen(function* () {
    const runner = yield* CommandRunner
    const gate = yield* Semaphore.make(1)
    const git = Effect.fn('CheckoutActions.git')(function* (root: string, args: readonly string[]) {
      const result = yield* runGit(runner, root, args).pipe(Effect.mapError(() => failure('git-failed')))
      if (result.exitCode !== 0 || result.truncated) return yield* failure('git-failed')
      return result.stdout
    })
    const repository = Effect.fn('CheckoutActions.repository')(function* (directory: string) {
      const root = yield* canonicalPath(directory).pipe(Effect.mapError(() => failure('unavailable')))
      const top = yield* git(root, ['rev-parse', '--show-toplevel']).pipe(
        Effect.mapError(() => failure('not-repository')),
      )
      const actual = yield* canonicalPath(top.trim()).pipe(Effect.mapError(() => failure('unavailable')))
      if (root !== actual) return yield* failure('not-repository')
      return root
    })
    const pathsIn = Effect.fn('CheckoutActions.paths')(function* (root: string, paths: readonly string[]) {
      const decoded = yield* Schema.decodeUnknownEffect(
        Schema.Array(checkoutFilePathSchema).check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
      )(paths).pipe(Effect.mapError(() => failure('invalid-path')))
      for (const path of decoded) {
        const parent = dirname(path.replaceAll('\\', '/'))
        yield* resolveInCanonicalRoot(root, parent === '.' ? '' : parent).pipe(
          Effect.mapError(() => failure('invalid-path')),
        )
      }
      return [...new Set(decoded)]
    })
    const status = Effect.fn('CheckoutActions.status')(function* (directory: string) {
      const root = yield* repository(directory)
      return parseCheckoutGitStatus(yield* git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']))
    })
    const stage = Effect.fn('CheckoutActions.stage')(function* (directory: string, paths: readonly string[]) {
      const root = yield* repository(directory)
      const contained = yield* pathsIn(root, paths)
      yield* git(root, ['add', '--all', '--', ...contained])
    })
    const unstage = Effect.fn('CheckoutActions.unstage')(function* (directory: string, paths: readonly string[]) {
      const root = yield* repository(directory)
      const contained = yield* pathsIn(root, paths)
      const head = yield* runGit(runner, root, ['rev-parse', '--verify', '--quiet', 'HEAD']).pipe(
        Effect.mapError(() => failure('git-failed')),
      )
      if (head.exitCode === 0) yield* git(root, ['restore', '--staged', '--', ...contained])
      else if (head.exitCode === 1) yield* git(root, ['rm', '--cached', '--ignore-unmatch', '--', ...contained])
      else return yield* failure('git-failed')
    })
    const commit = Effect.fn('CheckoutActions.commit')(function* (directory: string, message: string) {
      if (!message.trim() || message.length > 16_384 || message.includes('\0')) return yield* failure('git-failed')
      const root = yield* repository(directory)
      const staged = yield* git(root, ['diff', '--cached', '--name-only', '-z'])
      if (!staged) return yield* failure('nothing-staged')
      yield* git(root, ['commit', '--message', message])
      const revision = (yield* git(root, ['rev-parse', '--verify', 'HEAD'])).trim()
      return { revision }
    })
    return CheckoutActions.of({
      status,
      stage: (root, paths) => gate.withPermit(stage(root, paths)),
      unstage: (root, paths) => gate.withPermit(unstage(root, paths)),
      commit: (root, message) => gate.withPermit(commit(root, message)),
    })
  }),
)
