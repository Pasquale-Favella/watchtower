import { realpath } from 'node:fs'

import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'

import { CheckoutResolver, CheckoutResolverError } from '@/core/ports/checkout-resolver.js'
import { CommandRunner } from '@/core/ports/process.js'
import {
  type CheckoutResolverErrorCode,
  type CreateIsolatedWorktreeRequest,
  createIsolatedWorktreeRequestSchema,
  type RemoveWorktreeRequest,
  removeWorktreeRequestSchema,
  resolveCheckoutRequestSchema,
  type ResolvedCheckout,
} from '@/shared/schemas/checkout.js'

const failure = (code: CheckoutResolverErrorCode, message: string) => new CheckoutResolverError({ code, message })
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024
const GIT_TIMEOUT_MS = 10_000

export const CheckoutResolverLive = Layer.effect(
  CheckoutResolver,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const runner = yield* CommandRunner

    // Node's native implementation preserves the on-disk case on Windows.
    const canonical = (directory: string) =>
      Effect.tryPromise({
        try: () =>
          new Promise<string>((resolve, reject) =>
            realpath.native(directory, (error, value) => (error ? reject(error) : resolve(value))),
          ),
        catch: () => failure('filesystem-unavailable', 'Cannot canonicalize the checkout path'),
      })
    const runGit = Effect.fn('CheckoutResolver.runGit')(function* (cwd: string, args: readonly string[]) {
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
                failure(error.reason === 'spawn' ? 'git-unavailable' : 'git-failed', error.message),
              ),
            )
          const chunks: Uint8Array[] = []
          let size = 0
          yield* Stream.runForEach(handle.stdout, chunk => {
            size += chunk.byteLength
            if (size > MAX_GIT_OUTPUT_BYTES) return Effect.fail(failure('git-failed', 'Git output exceeded 1 MiB'))
            chunks.push(chunk)
            return Effect.void
          }).pipe(
            Effect.mapError(error =>
              error instanceof CheckoutResolverError ? error : failure('git-failed', error.message),
            ),
          )
          const exitCode = yield* handle.exitCode.pipe(Effect.mapError(error => failure('git-failed', error.message)))
          return { exitCode, stdout: Buffer.concat(chunks).toString('utf8') }
        }),
      )
      const result = yield* operation.pipe(Effect.timeoutOption(Duration.millis(GIT_TIMEOUT_MS)))
      if (Option.isNone(result)) return yield* failure('git-failed', 'Git command timed out')
      return result.value
    })
    const gitText = Effect.fn('CheckoutResolver.gitText')(function* (cwd: string, args: readonly string[]) {
      const result = yield* runGit(cwd, args)
      if (result.exitCode !== 0)
        return yield* failure('git-failed', `Git ${args[0]} failed with exit code ${result.exitCode}`)
      return result.stdout.replace(/\r?\n$/, '')
    })
    const resolve = Effect.fn('CheckoutResolver.resolve')(function* (
      input: string,
    ): Effect.fn.Return<ResolvedCheckout, CheckoutResolverError> {
      yield* Schema.decodeUnknownEffect(resolveCheckoutRequestSchema)({ path: input }).pipe(
        Effect.mapError(() => failure('invalid-input', 'Invalid checkout path')),
      )
      const absolute = path.resolve(input)
      const stat = yield* fs
        .stat(absolute)
        .pipe(
          Effect.mapError(error =>
            failure(
              error.reason._tag === 'NotFound' ? 'path-missing' : 'filesystem-unavailable',
              'Cannot inspect checkout path',
            ),
          ),
        )
      if (stat.type !== 'Directory') return yield* failure('not-a-directory', 'Checkout path is not a directory')
      const directory = yield* canonical(absolute)
      const inside = yield* runGit(directory, ['rev-parse', '--is-inside-work-tree'])
      if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true')
        return {
          canonicalPath: directory,
          kind: 'directory',
          repositoryIdentity: null,
          mainCheckoutPath: null,
          branch: null,
          headRevision: null,
          dirty: { trackedChanges: 0, untrackedCount: 0, ignoredCount: 0 },
        }
      const canonicalPath = yield* canonical(yield* gitText(directory, ['rev-parse', '--show-toplevel']))
      const repositoryIdentity = yield* canonical(
        yield* gitText(directory, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      )
      const worktrees = yield* gitText(directory, ['worktree', 'list', '--porcelain', '-z'])
      const firstPath = worktrees
        .split('\0')
        .find(record => record.startsWith('worktree '))
        ?.slice(9)
      if (!firstPath) return yield* failure('not-a-repository', 'Git did not identify a main checkout')
      const mainCheckoutPath = yield* canonical(firstPath)
      const branchResult = yield* runGit(directory, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
      const headResult = yield* runGit(directory, ['rev-parse', '--verify', '--quiet', 'HEAD'])
      if (branchResult.exitCode !== 0 && branchResult.exitCode !== 1)
        return yield* failure('git-failed', 'Cannot inspect the checkout branch')
      if (headResult.exitCode !== 0 && headResult.exitCode !== 1)
        return yield* failure('git-failed', 'Cannot inspect the checkout revision')
      const status = yield* gitText(directory, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignored=matching',
        '--ignore-submodules=none',
      ])
      const dirty = { trackedChanges: 0, untrackedCount: 0, ignoredCount: 0 }
      const records = status.split('\0')
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index]
        if (!record) continue
        const state = record.slice(0, 2)
        if (state === '??') dirty.untrackedCount += 1
        else if (state === '!!') dirty.ignoredCount += 1
        else {
          dirty.trackedChanges += 1
          if (state.includes('R') || state.includes('C')) index += 1
        }
      }
      return {
        canonicalPath,
        kind: canonicalPath === mainCheckoutPath ? 'main' : 'worktree',
        repositoryIdentity,
        mainCheckoutPath,
        branch: branchResult.exitCode === 0 ? branchResult.stdout.trimEnd() : null,
        headRevision: headResult.exitCode === 0 ? headResult.stdout.trimEnd() : null,
        dirty,
      }
    })
    const createIsolatedWorktree = Effect.fn('CheckoutResolver.createIsolatedWorktree')(function* (
      input: CreateIsolatedWorktreeRequest,
    ): Effect.fn.Return<ResolvedCheckout, CheckoutResolverError> {
      const request = yield* Schema.decodeUnknownEffect(createIsolatedWorktreeRequestSchema)(input).pipe(
        Effect.mapError(() => failure('invalid-input', 'Invalid worktree creation request')),
      )
      const repository = yield* resolve(request.repositoryPath)
      if (repository.kind === 'directory')
        return yield* failure('not-a-repository', 'Worktree creation requires a Git checkout')
      const target = path.resolve(request.worktreePath)
      const exists = yield* fs
        .exists(target)
        .pipe(Effect.mapError(() => failure('filesystem-unavailable', 'Cannot inspect worktree target')))
      if (exists) {
        const entries = yield* fs
          .readDirectory(target)
          .pipe(Effect.mapError(() => failure('worktree-conflict', 'Worktree target is not an empty directory')))
        if (entries.length > 0) return yield* failure('worktree-conflict', 'Worktree target is not empty')
      }
      const branchCheck = yield* runGit(repository.canonicalPath, ['check-ref-format', '--branch', request.branch])
      if (branchCheck.exitCode !== 0 || request.branch === 'HEAD')
        return yield* failure('invalid-input', 'Invalid worktree branch name')
      const duplicate = yield* runGit(repository.canonicalPath, [
        'show-ref',
        '--verify',
        '--quiet',
        `refs/heads/${request.branch}`,
      ])
      if (duplicate.exitCode === 0) return yield* failure('worktree-conflict', 'Worktree branch already exists')
      if (duplicate.exitCode !== 1) return yield* failure('git-failed', 'Cannot inspect existing branches')
      const base = yield* runGit(repository.canonicalPath, [
        'rev-parse',
        '--verify',
        '--quiet',
        `${request.baseRevision ?? 'HEAD'}^{commit}`,
      ])
      if (base.exitCode !== 0) return yield* failure('invalid-input', 'Base revision must identify an existing commit')
      const created = yield* runGit(repository.canonicalPath, [
        'worktree',
        'add',
        '--no-track',
        '-b',
        request.branch,
        '--',
        target,
        base.stdout.trim(),
      ])
      if (created.exitCode !== 0)
        return yield* failure('worktree-conflict', 'Git refused to create the isolated worktree')
      return yield* resolve(target)
    })
    const removeWorktree = Effect.fn('CheckoutResolver.removeWorktree')(function* (
      input: RemoveWorktreeRequest,
    ): Effect.fn.Return<void, CheckoutResolverError> {
      const request = yield* Schema.decodeUnknownEffect(removeWorktreeRequestSchema)(input).pipe(
        Effect.mapError(() => failure('invalid-input', 'Only non-forced worktree removal is supported')),
      )
      const checkout = yield* resolve(request.worktreePath)
      if (checkout.kind === 'directory')
        return yield* failure('not-a-repository', 'Worktree removal requires a Git checkout')
      if (checkout.kind === 'main') return yield* failure('worktree-conflict', 'A main checkout must never be removed')
      if (checkout.dirty.trackedChanges > 0 || checkout.dirty.untrackedCount > 0 || checkout.dirty.ignoredCount > 0) {
        return yield* failure('dirty-checkout', 'A dirty worktree must never be removed')
      }
      const removed = yield* runGit(checkout.mainCheckoutPath, ['worktree', 'remove', '--', checkout.canonicalPath])
      if (removed.exitCode !== 0)
        return yield* failure('worktree-conflict', 'Git refused to remove the worktree without force')
    })
    return CheckoutResolver.of({
      resolve,
      createIsolatedWorktree,
      removeWorktree,
    })
  }),
)
