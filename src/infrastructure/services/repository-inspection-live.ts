import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'

import { CommandRunner } from '../../core/ports/process.js'
import {
  type CommitInfo,
  type InspectionRange,
  RepositoryInspection,
  RepositoryInspectionError,
} from '../../core/ports/repository-inspection.js'

const GIT_TIMEOUT_MS = 5_000
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024
const SAFE_REF_PATTERN = /^(?!-)[A-Za-z0-9._/-]+$/

function inspectionError(operation: string, message: string): RepositoryInspectionError {
  return new RepositoryInspectionError({ operation, message })
}

function makeLiveInspection(runner: CommandRunner['Service']): RepositoryInspection['Service'] {
  const runGit = Effect.fn('RepositoryInspection.runGit')(function* (
    args: readonly string[],
    cwd: string,
  ): Effect.fn.Return<string, RepositoryInspectionError> {
    const operation = Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* runner
          .start('git', args, { cwd, windowsHide: true })
          .pipe(Effect.mapError(error => inspectionError(args[0] ?? 'git', error.message)))
        const chunks: Uint8Array[] = []
        let outputBytes = 0
        yield* Stream.runForEach(handle.stdout, chunk => {
          outputBytes += chunk.byteLength
          if (outputBytes > MAX_GIT_OUTPUT_BYTES) {
            return Effect.fail(inspectionError(args[0] ?? 'git', 'git output exceeded 1 MiB'))
          }
          chunks.push(chunk)
          return Effect.void
        }).pipe(
          Effect.mapError(error =>
            error instanceof RepositoryInspectionError ? error : inspectionError(args[0] ?? 'git', error.message),
          ),
        )
        const exitCode = yield* handle.exitCode.pipe(
          Effect.mapError(error => inspectionError(args[0] ?? 'git', error.message)),
        )
        if (exitCode !== 0) {
          return yield* Effect.fail(inspectionError(args[0] ?? 'git', `git exited with code ${exitCode}`))
        }
        return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
          .toString('utf8')
          .trim()
      }),
    )
    const outcome = yield* operation.pipe(Effect.timeoutOption(Duration.millis(GIT_TIMEOUT_MS)))
    if (Option.isNone(outcome)) {
      return yield* Effect.fail(inspectionError(args[0] ?? 'git', `git timed out after ${GIT_TIMEOUT_MS}ms`))
    }
    return outcome.value
  })

  const resolveIdentity = Effect.fn('RepositoryInspection.resolveIdentity')(function* (
    directory: string,
  ): Effect.fn.Return<{ readonly key: string; readonly gitDir: string }, RepositoryInspectionError> {
    const output = yield* runGit(['rev-parse', '--is-inside-work-tree', '--git-common-dir'], directory)
    const [insideWorkTree, commonDir] = output.split('\n')
    if (insideWorkTree !== 'true' || !commonDir) {
      return yield* Effect.fail(inspectionError('resolveIdentity', 'directory is not a git work tree'))
    }
    const commonPath = resolve(directory, commonDir)
    let key = commonPath
    try {
      key = realpathSync.native(commonPath)
    } catch {
      // Git may resolve the common directory while filesystem canonicalization races.
    }
    return { key, gitDir: directory }
  })

  const getMainBranch = Effect.fn('RepositoryInspection.getMainBranch')(function* (
    directory: string,
  ): Effect.fn.Return<string, RepositoryInspectionError> {
    const refs = yield* runGit(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'], directory)
    const available = new Set(refs.split('\n').filter(Boolean))
    const remoteHead = yield* runGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], directory).pipe(
      Effect.catchTag('RepositoryInspectionError', () => Effect.succeed('')),
    )
    if (remoteHead.startsWith('refs/remotes/') && SAFE_REF_PATTERN.test(remoteHead) && available.has(remoteHead)) {
      return remoteHead
    }
    for (const ref of [
      'refs/heads/main',
      'refs/heads/master',
      'refs/remotes/origin/main',
      'refs/remotes/origin/master',
    ]) {
      if (available.has(ref)) return ref
    }
    return yield* Effect.fail(inspectionError('main-reference', 'No local main reference is available'))
  })

  const getCommitFacts = Effect.fn('RepositoryInspection.getCommitFacts')(function* (
    directory: string,
    range: InspectionRange,
    mainBranch: string | null,
  ): Effect.fn.Return<readonly CommitInfo[], RepositoryInspectionError> {
    if (mainBranch !== null && !SAFE_REF_PATTERN.test(mainBranch)) {
      return yield* Effect.fail(inspectionError('main-reference', 'Invalid main reference'))
    }
    const log = yield* runGit(
      [
        'log',
        '--all',
        `--since-as-filter=${range.start.toISOString()}`,
        `--until=${range.end.toISOString()}`,
        '--format=%H|%cI',
      ],
      directory,
    )
    if (!log) return []
    const issues: { operation: string; message: string }[] = []
    const until = `--until=${(range.observedAt ?? range.end).toISOString()}`
    const mainOutput =
      mainBranch === null
        ? null
        : yield* runGit(['log', mainBranch, until, '--format=%H'], directory).pipe(
            Effect.catchTag('RepositoryInspectionError', () => {
              issues.push({ operation: 'main-membership', message: 'Main commit membership could not be inspected.' })
              return Effect.succeed(null)
            }),
          )
    const mainCommits = mainOutput === null ? null : new Set(mainOutput.split('\n').filter(Boolean))
    const revertOutput =
      mainBranch === null
        ? null
        : yield* runGit(['log', mainBranch, until, '--grep=^This reverts commit', '--format=%B%x1e'], directory).pipe(
            Effect.catchTag('RepositoryInspectionError', () => {
              issues.push({ operation: 'revert-history', message: 'Main revert history could not be inspected.' })
              return Effect.succeed(null)
            }),
          )
    const revertedShas = new Set<string>()
    for (const match of (revertOutput ?? '').matchAll(/This reverts commit ([0-9a-f]{7,40})/g)) {
      if (match[1]) revertedShas.add(match[1].toLowerCase())
    }
    const facts: CommitInfo[] = []
    for (const line of log.split('\n').filter(Boolean)) {
      const [sha = '', timestamp = ''] = line.split('|')
      const parsedTimestamp = new Date(timestamp)
      if (!/^[0-9a-f]{7,40}$/i.test(sha) || !Number.isFinite(parsedTimestamp.getTime())) {
        return yield* Effect.fail(inspectionError('commit-history', 'Git returned invalid commit evidence'))
      }
      if (
        parsedTimestamp < range.start ||
        parsedTimestamp > range.end ||
        parsedTimestamp > (range.observedAt ?? range.end)
      )
        continue
      const normalizedSha = sha.toLowerCase()
      facts.push({
        sha,
        timestamp: parsedTimestamp,
        inMain: mainCommits?.has(sha) ?? null,
        wasReverted:
          revertOutput === null ? null : [...revertedShas].some(reverted => normalizedSha.startsWith(reverted)),
        ...(issues.length > 0 ? { inspectionIssues: issues } : {}),
      })
    }
    return facts
  })

  return { resolveIdentity, getMainBranch, getCommitFacts }
}

export const RepositoryInspectionLive: Layer.Layer<RepositoryInspection, never, CommandRunner> = Layer.effect(
  RepositoryInspection,
  Effect.map(CommandRunner, makeLiveInspection),
)
