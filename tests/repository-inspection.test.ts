import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'
import { afterEach, describe, expect, it } from 'vitest'

import {
  CommandError,
  type CommandHandle,
  CommandRunner,
  type CommandStart,
} from '../src/main/agents/command-runner.js'
import { RepositoryInspection, RepositoryInspectionError } from '../src/main/application/repository-inspection.js'
import { RepositoryInspectionLive } from '../src/main/repository-inspection-live.js'
import { runWithTestClockWindow } from './helpers/run-effect-test.js'

const directories: string[] = []

function runner(respond: (args: readonly string[]) => { stdout: string; exitCode?: number } | 'hang') {
  const calls: { args: readonly string[]; options: Parameters<CommandStart>[2] }[] = []
  let releases = 0
  const start: CommandStart = (command, args, options = {}) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        calls.push({ args, options })
        const result = respond(args)
        const handle: CommandHandle = {
          pid: 17,
          exitCode: result === 'hang' ? Effect.never : Effect.succeed(result.exitCode ?? 0),
          isRunning: Effect.succeed(true),
          stdout: result === 'hang' ? Stream.never : Stream.fromIterable([Buffer.from(result.stdout)]),
          stderr: Stream.empty,
          all: result === 'hang' ? Stream.never : Stream.fromIterable([Buffer.from(result.stdout)]),
          kill: Effect.void,
        }
        return handle
      }),
      () =>
        Effect.sync(() => {
          releases++
        }),
    )
  const layer = CommandRunner.layerWithRunner(
    command => Effect.fail(new CommandError({ reason: 'spawn', message: 'run is unused', command })),
    start,
  )
  return {
    layer,
    calls,
    get releases() {
      return releases
    },
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('RepositoryInspectionLive', () => {
  it('uses canonical common-dir identity and sends process options through CommandRunner', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'watchtower-repo-inspection-'))
    directories.push(directory)
    const fake = runner(args => {
      if (args[0] === 'rev-parse') return { stdout: 'true\n.git' }
      if (args[0] === 'symbolic-ref') return { stdout: 'refs/remotes/origin/feature/main' }
      if (args[0] === 'log') return { stdout: '' }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })
    const live = RepositoryInspectionLive.pipe(Layer.provide(fake.layer))
    const identity = await Effect.runPromise(
      Effect.flatMap(RepositoryInspection, service => service.resolveIdentity(directory)).pipe(Effect.provide(live)),
    )
    const branch = await Effect.runPromise(
      Effect.flatMap(RepositoryInspection, service => service.getMainBranch(directory)).pipe(Effect.provide(live)),
    )
    const facts = await Effect.runPromise(
      Effect.flatMap(RepositoryInspection, service =>
        service.getCommitFacts(directory, { start: new Date(0), end: new Date('2026-10-05T00:00:00Z') }, branch),
      ).pipe(Effect.provide(live)),
    )

    expect(identity.key.toLowerCase()).toBe(join(directory, '.git').toLowerCase())
    expect(branch).toBe('feature/main')
    expect(facts).toEqual([])
    expect(fake.calls.every(call => call.options?.windowsHide === true)).toBe(true)
    expect(fake.calls.map(call => call.args[0])).toEqual(['rev-parse', 'symbolic-ref', 'log'])
    expect(fake.releases).toBe(3)
  })

  it('rejects an option-looking remote HEAD branch and falls back to local branch discovery', async () => {
    const fake = runner(args => {
      if (args[0] === 'symbolic-ref') return { stdout: 'refs/remotes/origin/--all' }
      if (args[0] === 'branch') return { stdout: '* feature\n  main' }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })
    const live = RepositoryInspectionLive.pipe(Layer.provide(fake.layer))
    const branch = await Effect.runPromise(
      Effect.flatMap(RepositoryInspection, service => service.getMainBranch('checkout')).pipe(Effect.provide(live)),
    )

    expect(branch).toBe('main')
    expect(fake.calls.map(call => call.args)).toEqual([
      ['symbolic-ref', 'refs/remotes/origin/HEAD'],
      ['branch', '-a'],
    ])
    expect(fake.releases).toBe(2)
  })

  it('keeps commit facts when main-branch and revert-history inspection fail operationally', async () => {
    const fake = runner(args => {
      if (args[0] !== 'log') throw new Error(`unexpected git args: ${args.join(' ')}`)
      if (args[1] === '--all' && args[2]?.startsWith('--since=')) {
        return { stdout: '0123456789abcdef|2026-10-05T11:00:00.000Z|change' }
      }
      if (args[1] === 'main') return { stdout: '', exitCode: 1 }
      if (args[1] === '--all' && args[2]?.startsWith('--grep=')) return { stdout: '', exitCode: 1 }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })
    const live = RepositoryInspectionLive.pipe(Layer.provide(fake.layer))
    const facts = await Effect.runPromise(
      Effect.flatMap(RepositoryInspection, service =>
        service.getCommitFacts('checkout', { start: new Date(0), end: new Date('2026-10-05T12:00:00.000Z') }, 'main'),
      ).pipe(Effect.provide(live)),
    )

    expect(facts).toEqual([
      {
        sha: '0123456789abcdef',
        timestamp: new Date('2026-10-05T11:00:00.000Z'),
        inMain: false,
        wasReverted: false,
      },
    ])
    expect(fake.calls).toHaveLength(3)
    expect(fake.releases).toBe(3)
  })

  it('does not turn a git runner defect into empty inspection facts', async () => {
    const fake = runner(() => {
      throw new Error('runner defect')
    })
    const live = RepositoryInspectionLive.pipe(Layer.provide(fake.layer))
    const effect = Effect.flatMap(RepositoryInspection, service =>
      service.getCommitFacts('checkout', { start: new Date(0), end: new Date('2026-10-05T12:00:00.000Z') }, 'main'),
    ).pipe(Effect.provide(live))

    await expect(Effect.runPromise(effect)).rejects.toThrow('runner defect')
    expect(fake.releases).toBe(0)
  })

  it('treats a timed-out git process as a typed failure and closes its scope', async () => {
    const fake = runner(() => 'hang')
    const live = RepositoryInspectionLive.pipe(Layer.provide(fake.layer))
    const program = Effect.gen(function* () {
      const service = yield* RepositoryInspection
      return yield* Effect.flip(service.resolveIdentity('missing-directory'))
    }).pipe(Effect.provide(live))
    const result = await Effect.runPromise(
      runWithTestClockWindow(program, Duration.seconds(5)).pipe(Effect.provide(TestClock.layer())),
    )
    expect(result).toBeInstanceOf(RepositoryInspectionError)
    expect(fake.calls).toHaveLength(1)
    expect(fake.releases).toBe(1)
  })

  it('stops a git capture at the existing one mebibyte process-output limit', async () => {
    const oversized = 'x'.repeat(1024 * 1024 + 1)
    const fake = runner(() => ({ stdout: oversized }))
    const live = RepositoryInspectionLive.pipe(Layer.provide(fake.layer))
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* RepositoryInspection
        return yield* Effect.flip(service.resolveIdentity('large-output'))
      }).pipe(Effect.provide(live)),
    )
    expect(result).toBeInstanceOf(RepositoryInspectionError)
    expect(fake.releases).toBe(1)
  })
})
