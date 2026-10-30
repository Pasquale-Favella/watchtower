import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as PlatformError from 'effect/PlatformError'
import type * as ChildProcess from 'effect/process/ChildProcess'
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner'
import * as Sink from 'effect/Sink'
import * as Stream from 'effect/Stream'
import { describe, expect, it } from 'vitest'

import {
  claudeNativeAvailability,
  discoverNativeHarnessExecutables,
  type NativeExecutableDiscoveryOptions,
} from '../src/infrastructure/agent-harnesses/native-executables.js'

const executable = 'C:\\tools\\codex.exe'
const bytes = (value: string) => new TextEncoder().encode(value)

function fixture(
  options: {
    stdout?: Stream.Stream<Uint8Array, PlatformError.PlatformError>
    stderr?: Stream.Stream<Uint8Array, PlatformError.PlatformError>
    exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>
    spawnFailure?: boolean
  } = {},
) {
  const commands: ChildProcess.Command[] = []
  let released = 0
  const handle = ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    exitCode: options.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: options.stdout ?? Stream.make(bytes('codex-cli 0.165.0\n')),
    stderr: options.stderr ?? Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  })
  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(command => {
      commands.push(command)
      if (options.spawnFailure)
        return Effect.fail(
          PlatformError.systemError({
            _tag: 'NotFound',
            module: 'ChildProcess',
            method: 'spawn',
            description: 'missing binary',
          }),
        )
      return Effect.acquireRelease(Effect.succeed(handle), () =>
        Effect.sync(() => {
          released += 1
        }),
      )
    }),
  )
  return {
    commands,
    get released() {
      return released
    },
    discover: (overrides: NativeExecutableDiscoveryOptions = {}) =>
      Effect.runPromise(
        discoverNativeHarnessExecutables({
          platform: 'win32',
          commandExists: () => executable,
          resolveNativeExecutable: path => path,
          ...overrides,
        }).pipe(Effect.provide(layer)),
      ),
  }
}

describe('native Harness executable discovery', () => {
  it('admits a native Codex binary only after recording successful version evidence', async () => {
    const test = fixture()
    const result = await test.discover()
    expect(result).toMatchObject([
      {
        instanceId: 'codex:path',
        driverId: 'codex-app-server',
        validatedExecutable: executable,
        version: '0.165.0',
        validation: { kind: 'version', args: ['--version'], stdout: 'codex-cli 0.165.0', exitCode: 0 },
      },
    ])
    expect(test.commands).toMatchObject([
      {
        command: executable,
        args: ['--version'],
        options: {
          shell: false,
          windowsHide: true,
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          additionalFds: {},
        },
      },
    ])
    expect(test.released).toBe(1)
    expect(Object.isFrozen(result[0])).toBe(true)
  })

  it('excludes a timed-out child and closes its scope before returning', async () => {
    const test = fixture({ stdout: Stream.never, exitCode: Effect.never })
    expect(await test.discover({ timeoutMs: 5 })).toEqual([])
    expect(test.released).toBe(1)
  })

  it('bounds acquisition as well as output and exit', async () => {
    const layer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.never),
    )
    expect(
      await Effect.runPromise(
        discoverNativeHarnessExecutables({
          platform: 'win32',
          commandExists: () => executable,
          resolveNativeExecutable: path => path,
          timeoutMs: 5,
        }).pipe(Effect.provide(layer)),
      ),
    ).toEqual([])
  })

  it('excludes a non-zero version exit even when its output looks valid', async () => {
    const test = fixture({ exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)) })
    expect(await test.discover()).toEqual([])
    expect(test.released).toBe(1)
  })

  it.each(['stdout', 'stderr'] as const)('rejects oversized %s without retaining unbounded output', async output => {
    const test = fixture({ [output]: Stream.make(bytes('x'.repeat(4_097))) })
    expect(await test.discover()).toEqual([])
    expect(test.released).toBe(1)
  })

  it('enforces the output cap across stdout and stderr together', async () => {
    const test = fixture({
      stdout: Stream.make(bytes('codex-cli 0.165.0\n')),
      stderr: Stream.make(bytes('x'.repeat(4_080))),
    })
    expect(await test.discover()).toEqual([])
    expect(test.released).toBe(1)
  })

  it.each(['', 'another-tool 1.0.0', 'codex-cli banana', 'codex-cli 0.165.0\nextra'])(
    'rejects unrecognized version evidence: %j',
    async output => {
      expect(await fixture({ stdout: Stream.make(bytes(output)) }).discover()).toEqual([])
    },
  )

  it.each(['codex.exe', '.\\codex.exe', 'C:codex.exe', '\\tools\\codex.exe'])(
    'never resolves a cwd-relative lookup result: %s',
    async path => {
      const test = fixture()
      expect(
        await test.discover({
          commandExists: () => path,
          resolveNativeExecutable: () => {
            throw new Error('must not resolve')
          },
        }),
      ).toEqual([])
      expect(test.commands).toEqual([])
    },
  )

  it.each(['C:\\tools\\codex.cmd', 'C:\\tools\\codex.bat', 'C:\\tools\\codex.ps1', '.\\codex.exe'])(
    'refuses resolved shell shims and relative paths: %s',
    async path => {
      const test = fixture()
      expect(await test.discover({ resolveNativeExecutable: () => path })).toEqual([])
      expect(test.commands).toEqual([])
    },
  )

  it('requires a real native header, not an extensionless shell or npm launcher', async () => {
    const directory = mkdtempSync(join(process.cwd(), '.native-harness-test-'))
    try {
      const shim = join(directory, 'codex.exe')
      writeFileSync(shim, '#!/bin/sh\necho codex-cli 0.165.0\n')
      const test = fixture()
      expect(
        await test.discover({
          platform: process.platform,
          commandExists: () => shim,
          resolveNativeExecutable: undefined,
        }),
      ).toEqual([])
      expect(test.commands).toEqual([])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('accepts a canonical native binary after filesystem validation', async () => {
    const directory = mkdtempSync(join(process.cwd(), '.native-harness-test-'))
    try {
      const binary = join(directory, 'codex.exe')
      writeFileSync(binary, Buffer.from([0x4d, 0x5a, 0x00, 0x00]))
      const result = await fixture().discover({
        platform: process.platform,
        commandExists: () => binary,
        resolveNativeExecutable: undefined,
      })
      expect(result[0]?.validatedExecutable).toBe(binary)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('excludes missing, unresolvable and unspawnable binaries', async () => {
    expect(await fixture().discover({ commandExists: () => null })).toEqual([])
    expect(
      await fixture().discover({
        resolveNativeExecutable: () => {
          throw new Error('removed')
        },
      }),
    ).toEqual([])
    expect(await fixture({ spawnFailure: true }).discover()).toEqual([])
  })

  it('ignores relative PATH directories instead of searching the application working directory', async () => {
    const test = fixture()
    expect(await test.discover({ commandExists: undefined, pathEnv: '.;relative;C:tools;\\tools' })).toEqual([])
    expect(test.commands).toEqual([])
  })

  it('continues past an invalid PATH candidate to the next native installation', async () => {
    const directory = mkdtempSync(join(process.cwd(), '.native-harness-test-'))
    const first = join(directory, 'first')
    const second = join(directory, 'second')
    try {
      mkdirSync(first)
      mkdirSync(second)
      const name = process.platform === 'win32' ? 'codex.exe' : 'codex'
      writeFileSync(join(first, name), '#!/bin/sh\necho codex-cli 0.165.0\n')
      writeFileSync(join(second, name), Buffer.from([0x4d, 0x5a, 0x00, 0x00]))
      const result = await fixture().discover({
        platform: process.platform,
        pathEnv: [first, second].join(delimiter),
        commandExists: undefined,
        resolveNativeExecutable: undefined,
      })
      expect(result[0]?.validatedExecutable).toBe(join(second, name))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each(['linux', 'darwin'] as const)('accepts a validated absolute native Codex candidate on %s', async platform => {
    const result = await fixture().discover({ platform, commandExists: () => '/opt/codex/bin/codex' })
    expect(result[0]?.validatedExecutable).toBe('/opt/codex/bin/codex')
  })

  it('does not discover or fabricate a Claude executable while its bundled SDK distribution is gated', async () => {
    const commands: string[] = []
    expect(
      await fixture().discover({
        commandExists: command => {
          commands.push(command)
          return null
        },
      }),
    ).toEqual([])
    expect(commands).toEqual(['codex'])
    expect(claudeNativeAvailability).toMatchObject({
      driverId: 'claude-agent-sdk',
      availability: 'release-gated',
      distribution: 'bundled-sdk-cli',
      requiresHostExecutable: false,
    })
  })
})
