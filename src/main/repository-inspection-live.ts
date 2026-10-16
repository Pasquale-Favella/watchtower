import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'

import { CommandRunner } from './agents/command-runner.js'
import {
  type CommitInfo,
  type InspectionRange,
  RepositoryInspection,
  RepositoryInspectionError,
} from './application/repository-inspection.js'

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
    const remoteHead = yield* runGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], directory).pipe(
      Effect.catchTag('RepositoryInspectionError', () => Effect.succeed('')),
    )
    if (remoteHead) {
      const branch = remoteHead.replace('refs/remotes/origin/', '')
      if (SAFE_REF_PATTERN.test(branch)) return branch
    }

    const branches = yield* runGit(['branch', '-a'], directory)
    if (branches.includes('main')) return 'main'
    if (branches.includes('master')) return 'master'
    return 'main'
  })

  const getCommitFacts = Effect.fn('RepositoryInspection.getCommitFacts')(function* (
    directory: string,
    range: InspectionRange,
    mainBranch: string,
  ): Effect.fn.Return<readonly CommitInfo[], RepositoryInspectionError> {
    const log = yield* runGit(
      [
        'log',
        '--all',
        `--since=${range.start.toISOString()}`,
        `--until=${range.end.toISOString()}`,
        '--format=%H|%aI|%s',
      ],
      directory,
    )
    if (!log) return []

    const mainOutput = yield* runGit(['log', mainBranch, '--format=%H'], directory).pipe(
      Effect.catchTag('RepositoryInspectionError', () => Effect.succeed('')),
    )
    const mainCommits = new Set(mainOutput.split('\n').filter(Boolean))
    const revertOutput = yield* runGit(
      ['log', '--all', '--grep=^This reverts commit', '--format=%B%x1e'],
      directory,
    ).pipe(Effect.catchTag('RepositoryInspectionError', () => Effect.succeed('')))
    const revertedShas = new Set<string>()
    const revertPattern = /This reverts commit ([0-9a-f]{7,40})/g
    for (const match of revertOutput.matchAll(revertPattern)) {
      const sha = match[1]
      if (sha) revertedShas.add(sha.toLowerCase())
    }

    return log
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [sha = '', timestamp = ''] = line.split('|')
        const normalizedSha = sha.toLowerCase()
        return {
          sha,
          timestamp: new Date(timestamp),
          inMain: mainCommits.has(sha),
          wasReverted: revertedShas.has(normalizedSha) || revertedShas.has(normalizedSha.slice(0, 7)),
        }
      })
  })

  return { resolveIdentity, getMainBranch, getCommitFacts }
}

export const RepositoryInspectionLive: Layer.Layer<RepositoryInspection, never, CommandRunner> = Layer.effect(
  RepositoryInspection,
  Effect.map(CommandRunner, makeLiveInspection),
)
