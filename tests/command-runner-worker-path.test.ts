import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'

import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'

import { executablePathEnv, which } from '../src/infrastructure/agent-harnesses/detect.js'

const GIT_FIXTURE_PREFIX = 'watchtower-worker-git-path-'

function removeGitFixture(directory: string): void {
  const resolvedDirectory = resolve(directory)
  if (dirname(resolvedDirectory) !== resolve(tmpdir()) || !basename(resolvedDirectory).startsWith(GIT_FIXTURE_PREFIX)) {
    throw new Error('Unexpected Git fixture directory')
  }
  rmSync(resolvedDirectory, { recursive: true, force: true })
}

describe('executable PATH environment lookup', () => {
  it.each(['PATH', 'Path', 'path', 'pAtH'])('reads the Windows %s spelling without mutating the environment', key => {
    const environment = { [key]: 'command-directory', HOME: 'home-directory' }
    expect(executablePathEnv(environment, 'win32')).toBe('command-directory')
    expect(environment).toEqual({ [key]: 'command-directory', HOME: 'home-directory' })
  })

  it('preserves an explicitly empty uppercase PATH and handles a missing path', () => {
    expect(executablePathEnv({ PATH: '', Path: 'other-directory' }, 'win32')).toBe('')
    expect(executablePathEnv({}, 'win32')).toBe('')
  })

  it.each(['linux', 'darwin'] as const)('keeps %s environment names case-sensitive', platform => {
    expect(executablePathEnv({ Path: 'ignored-directory' }, platform)).toBe('')
    expect(executablePathEnv({ PATH: 'command-directory', Path: 'ignored-directory' }, platform)).toBe(
      'command-directory',
    )
  })

  it('preserves an explicitly empty path argument instead of inheriting the environment', () => {
    expect(which('git', '', 'win32')).toBeNull()
  })
})

describe('Windows worker command lookup', () => {
  it.skipIf(process.platform !== 'win32')('runs raw Git format arguments with only a mixed-case Path key', async () => {
    const gitExecutable = which('git')
    if (!gitExecutable) throw new Error('The Git integration fixture requires Git on PATH')
    const directory = mkdtempSync(join(tmpdir(), GIT_FIXTURE_PREFIX))
    let worker: Worker | undefined
    try {
      const git = (args: string[]): string =>
        execFileSync(gitExecutable, args, { cwd: directory, encoding: 'utf8', windowsHide: true }).trim()
      git(['init', '-b', 'main'])
      git([
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '--allow-empty',
        '-m',
        'worker-format-fixture',
      ])
      const expectedSha = git(['rev-parse', 'HEAD'])
      const bundled = await build({
        stdin: {
          contents: `
            import * as Effect from 'effect/Effect'
            import * as Stream from 'effect/Stream'
            import { parentPort, workerData } from 'node:worker_threads'
            import { which } from './src/infrastructure/agent-harnesses/detect.ts'
            import { CommandRunner } from './src/core/ports/process.ts'
            import { CommandRunnerLiveLayer } from './src/infrastructure/agent-harnesses/command-runner-live.ts'
            const probe = Effect.scoped(Effect.gen(function* () {
              const runner = yield* CommandRunner
              const handle = yield* runner.start('git', ['log', '-1', '--format=%H|%cI|%s'], { cwd: workerData.directory })
              const stdout = yield* Stream.mkString(Stream.decodeText(handle.stdout))
              const exitCode = yield* handle.exitCode
              return { stdout, exitCode, foundExecutable: which('git')?.endsWith('.exe'), hasUppercasePath: Object.hasOwn(process.env, 'PATH'), hasMixedCasePath: Object.hasOwn(process.env, 'Path') }
            })).pipe(Effect.provide(CommandRunnerLiveLayer))
            Effect.runPromise(probe).then(result => parentPort.postMessage(result), error => { throw error })
          `,
          resolveDir: process.cwd(),
        },
        bundle: true,
        packages: 'external',
        platform: 'node',
        format: 'cjs',
        write: false,
      })
      const code = bundled.outputFiles[0]?.text
      if (!code) throw new Error('The worker probe did not bundle')
      const environment = {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path')),
        Path: executablePathEnv(),
      }
      worker = new Worker(code, { eval: true, env: environment, workerData: { directory } })
      const runningWorker = worker
      const result = await new Promise<{
        stdout: string
        exitCode: number
        foundExecutable: boolean
        hasUppercasePath: boolean
        hasMixedCasePath: boolean
      }>((resolve, reject) => {
        runningWorker.once('message', resolve)
        runningWorker.once('error', reject)
        runningWorker.once('exit', code => {
          reject(new Error(`Git probe worker exited before reporting a result with code ${code}`))
        })
      })
      expect(result).toMatchObject({
        exitCode: 0,
        foundExecutable: true,
        hasUppercasePath: false,
        hasMixedCasePath: true,
      })
      expect(result.stdout.trim().split('|')).toEqual([
        expectedSha,
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        'worker-format-fixture',
      ])
    } finally {
      await worker?.terminate()
      removeGitFixture(directory)
    }
  })
})
