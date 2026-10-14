import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import * as Effect from 'effect/Effect'
import * as Stream from 'effect/Stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const processFixture = vi.hoisted(() => ({ spawn: vi.fn() }))

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: processFixture.spawn }
})

import { CommandRunner } from '../src/main/agents/command-runner.js'

describe('CommandRunner fast child startup', () => {
  beforeEach(() => processFixture.spawn.mockReset())

  it('keeps bytes readable when Node resumes stdio before the Effect pump starts', async () => {
    const stdout = new PassThrough()
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr: null,
      stdin: null,
      pid: 12345,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(() => true),
    })
    processFixture.spawn.mockImplementation(() => {
      process.nextTick(() => {
        child.emit('spawn')
        stdout.write('fast-child-output')
        stdout.end()
        // Mirrors Node's post-exit stdio flush before the deferred Effect pump
        // gets a fiber turn to install its readable listener.
        stdout.resume()
        child.exitCode = 0
        child.emit('close', 0, null)
      })
      return child
    })

    const captured = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* CommandRunner
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* runner.start(process.execPath, [])
            const output = yield* Stream.mkString(Stream.decodeText(handle.stdout))
            const exitCode = yield* handle.exitCode
            return { output, exitCode }
          }),
        )
      }).pipe(Effect.provide(CommandRunner.layer)),
    )

    expect(captured).toEqual({ output: 'fast-child-output', exitCode: 0 })
    expect(stdout.listenerCount('readable')).toBe(0)
  })
})
