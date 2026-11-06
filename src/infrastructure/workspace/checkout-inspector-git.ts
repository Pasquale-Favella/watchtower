import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'

import { CheckoutInspectionError } from '@/core/ports/checkout-inspection.js'
import { CommandRunner } from '@/core/ports/process.js'

export type CommandRunnerService = CommandRunner['Service']

const GIT_TIMEOUT_MS = 15_000
/** Listing commands feed bounded collections; this ceiling is a safety net, not a user-facing limit. */
export const GIT_LISTING_MAX_BYTES = 16 * 1024 * 1024

const EMPTY_TREE_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const EMPTY_TREE_SHA256 = '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321'

/** Ambient Git overrides must not redirect reads or writes to another repository. */
const gitEnvironment = {
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
}

export interface GitResult {
  readonly exitCode: number
  readonly stdout: string
  /** True when stdout reached its byte budget; the child was stopped and the output is a prefix. */
  readonly truncated: boolean
}

export const gitFailure = (code: CheckoutInspectionError['code'], message: string) =>
  new CheckoutInspectionError({ code, message })

/**
 * Runs the user's git CLI with a deadline and a byte budget. Output past the budget stops the child and
 * reports `truncated`, so callers can keep bounded prefixes instead of failing the whole inspection.
 */
export const runGit = Effect.fn('CheckoutInspection.runGit')(function* (
  runner: CommandRunnerService,
  cwd: string,
  args: readonly string[],
  maxBytes = GIT_LISTING_MAX_BYTES,
): Effect.fn.Return<GitResult, CheckoutInspectionError> {
  const operation = Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* runner
        .start('git', ['--no-optional-locks', '--literal-pathspecs', ...args], {
          cwd,
          windowsHide: true,
          extendEnv: true,
          env: gitEnvironment,
        })
        .pipe(
          Effect.mapError(error =>
            gitFailure(error.reason === 'spawn' ? 'unavailable' : 'failed', 'Git could not be started'),
          ),
        )
      const chunks: Uint8Array[] = []
      let size = 0
      let truncated = false
      yield* Stream.runForEachWhile(handle.stdout, chunk =>
        Effect.sync(() => {
          const room = maxBytes - size
          if (chunk.byteLength <= room) {
            chunks.push(chunk)
            size += chunk.byteLength
            return true
          }
          if (room > 0) chunks.push(chunk.subarray(0, room))
          size = maxBytes
          truncated = true
          return false
        }),
      ).pipe(Effect.mapError(() => gitFailure('failed', 'Git output could not be read')))
      if (truncated) yield* handle.kill
      const exitCode = yield* handle.exitCode.pipe(
        Effect.mapError(() => gitFailure('failed', 'Git did not report an exit code')),
      )
      return { exitCode, stdout: Buffer.concat(chunks).toString('utf8'), truncated }
    }),
  )
  const result = yield* operation.pipe(Effect.timeoutOption(Duration.millis(GIT_TIMEOUT_MS)))
  if (Option.isNone(result)) return yield* gitFailure('failed', 'Git command timed out')
  return result.value
})

/** A command whose successful output is one trimmed line, or a failure with no Git diagnostics attached. */
export const gitLine = Effect.fn('CheckoutInspection.gitLine')(function* (
  runner: CommandRunnerService,
  cwd: string,
  args: readonly string[],
): Effect.fn.Return<string, CheckoutInspectionError> {
  const result = yield* runGit(runner, cwd, args)
  if (result.exitCode !== 0 || result.truncated) return yield* gitFailure('failed', `Git ${args[0]} failed`)
  return result.stdout.trim()
})

/** Chooses the empty-tree object that matches the repository's object format, for an unborn HEAD. */
export const emptyTreeRevision = Effect.fn('CheckoutInspection.emptyTreeRevision')(function* (
  runner: CommandRunnerService,
  cwd: string,
): Effect.fn.Return<string, CheckoutInspectionError> {
  const format = yield* runGit(runner, cwd, ['rev-parse', '--show-object-format'])
  return format.exitCode === 0 && format.stdout.trim() === 'sha256' ? EMPTY_TREE_SHA256 : EMPTY_TREE_SHA1
})

export interface NumstatEntry {
  readonly additions: number
  readonly deletions: number
  readonly binary: boolean
}

/** Parses `git diff --numstat -z`. Renames carry an empty path field followed by the source and destination. */
export function parseNumstatZ(stdout: string): Map<string, NumstatEntry> {
  const tokens = stdout.split('\0')
  const entries = new Map<string, NumstatEntry>()
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index]
    index += 1
    if (!token) continue
    const [added = '', deleted = '', ...rest] = token.split('\t')
    const pathField = rest.join('\t')
    let path = pathField
    if (pathField === '') {
      path = tokens[index + 1] ?? ''
      index += 2
    }
    if (!path) continue
    const binary = added === '-' || deleted === '-'
    entries.set(path, {
      additions: binary ? 0 : Number(added),
      deletions: binary ? 0 : Number(deleted),
      binary,
    })
  }
  return entries
}

export interface NameStatusEntry {
  readonly status: 'added' | 'modified' | 'deleted' | 'renamed'
  readonly path: string
  readonly previousPath?: string
}

function statusOf(letter: string): NameStatusEntry['status'] {
  switch (letter) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    default:
      return 'modified'
  }
}

/** Parses `git diff --name-status -z` with rename detection enabled. */
export function parseNameStatusZ(stdout: string): NameStatusEntry[] {
  const tokens = stdout.split('\0')
  const entries: NameStatusEntry[] = []
  for (let index = 0; index < tokens.length;) {
    const code = tokens[index]
    index += 1
    if (!code) continue
    const letter = code.charAt(0)
    if (letter === 'R' || letter === 'C') {
      const previousPath = tokens[index] ?? ''
      const path = tokens[index + 1] ?? ''
      index += 2
      if (!path) continue
      entries.push(letter === 'R' ? { status: 'renamed', path, previousPath } : { status: 'added', path })
      continue
    }
    const path = tokens[index] ?? ''
    index += 1
    if (!path) continue
    entries.push({ status: statusOf(letter), path })
  }
  return entries
}

/** Parses `git ls-files -z` output. Nested-repository entries end with a slash and are not file content. */
export function parseNulList(stdout: string): string[] {
  return stdout.split('\0').filter(entry => entry.length > 0)
}

/** Ordering by code point keeps the file list stable across locales and platforms. */
export function compareText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
