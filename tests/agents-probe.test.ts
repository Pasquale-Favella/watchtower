import * as childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'

import type { InitializeResponse } from '@agentclientprotocol/sdk'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HarnessInfo } from '../src/main/agents/detect.js'
import { HARNESS_HANDSHAKE_TIMEOUT_MS, probeTimeoutFor } from '../src/main/agents/harness-timeouts.js'
import {
  type ProbeChild,
  type ProbeConnection,
  probeHarness,
  type ProbeResult,
  type ProbeSpawn,
} from '../src/main/agents/probe.js'

class FakeChild extends EventEmitter implements ProbeChild {
  pid = 4321
  killed = 0
  stdin = new Writable({ write: (_chunk, _encoding, callback) => callback() })
  stdout = Readable.from([])
  stderr = Readable.from([])

  kill(): boolean {
    this.killed += 1
    return true
  }
}

const codex: HarnessInfo = {
  instanceId: 'codex',
  name: 'codex',
  kind: 'codex',
  displayName: 'Codex',
  bin: 'C:\\bin\\codex-acp.exe',
  scrubEnv: [],
}

const claude: HarnessInfo = {
  ...codex,
  instanceId: 'claude',
  name: 'claude',
  kind: 'claude',
  displayName: 'Claude Code',
  bin: 'C:\\bin\\claude-agent-acp.exe',
}

const initialized: InitializeResponse = {
  protocolVersion: 1,
  agentInfo: { name: 'test-agent', version: '1.2.3' },
}

function runProbe(info: HarnessInfo, options: Parameters<typeof probeHarness>[1] = {}): Promise<ProbeResult> {
  return Effect.runPromise(probeHarness(info, options))
}

function spawnWith(child: FakeChild): ProbeSpawn {
  return (() => child) as ProbeSpawn
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('probeHarness', () => {
  it('runs only initialize and reports a handshaking agent as ready with unverified sign-in', async () => {
    const child = new FakeChild()
    const calls: string[] = []
    const connection: ProbeConnection = {
      initialize: vi.fn(async params => {
        calls.push('initialize')
        expect(params.clientInfo.version).toBe('9.9.9')
        return initialized
      }),
    }

    const result = await runProbe(codex, {
      spawn: spawnWith(child),
      connectionFactory: () => connection,
      clientVersion: '9.9.9',
      kill: () => {
        child.killed += 1
      },
    })

    expect(result).toMatchObject({ status: 'ready', auth: { status: 'unknown' }, version: '1.2.3' })
    expect(calls).toEqual(['initialize'])
    expect(child.killed).toBe(1)
  })

  it('does not treat advertised authMethods as a signed-out signal', async () => {
    const child = new FakeChild()
    const result = await runProbe(codex, {
      spawn: spawnWith(child),
      connectionFactory: () => ({
        initialize: async () => ({ ...initialized, authMethods: [{ id: 'login' }] }) as never,
      }),
    })
    expect(result.status).toBe('ready')
    expect(result.auth.status).toBe('unknown')
    expect(result.message).toBeUndefined()
  })

  it('maps Claude auth status unauthenticated to warning, never ready', async () => {
    const child = new FakeChild()
    const result = await runProbe(claude, {
      spawn: spawnWith(child),
      connectionFactory: () => ({ initialize: async () => initialized }),
      claudeAuthProbe: async () => 'unauthenticated',
    })
    expect(result).toMatchObject({
      status: 'warning',
      auth: { status: 'unauthenticated' },
      message: 'Claude Code is not signed in',
    })
  })

  it('maps SDK handshake rejection to bounded guidance without native error text or binary path', async () => {
    const child = new FakeChild()
    const secret = `handshake failed ${codex.bin} stderr bearer_token=secret`
    const result = await runProbe(codex, {
      spawn: spawnWith(child),
      connectionFactory: () => ({
        initialize: async () => {
          throw new Error(secret)
        },
      }),
      kill: target => target.kill(),
    })
    expect(result).toEqual({
      status: 'error',
      auth: { status: 'unknown' },
      message: 'Codex did not complete the ACP handshake. Check the installation and try again.',
    })
    expect(result.message).not.toContain(secret)
    expect(result.message).not.toContain(codex.bin)
    expect(child.killed).toBe(1)
  })

  it('maps spawn and ACP connection failures to finite outcomes', async () => {
    const secret = `native rejection ${codex.bin} stderr api_key=secret`
    const spawnFailure = await runProbe(codex, {
      spawn: (() => {
        throw new Error(secret)
      }) as ProbeSpawn,
    })
    expect(spawnFailure.message).toBe('Codex could not be started. Check that it is installed and available on PATH.')

    const connectionChild = new FakeChild()
    const connectionFailure = await runProbe(codex, {
      spawn: spawnWith(connectionChild),
      connectionFactory: () => {
        throw new Error(secret)
      },
      kill: target => target.kill(),
    })
    expect(connectionFailure.message).toBe(
      'Codex could not connect to its ACP process. Check the installation and try again.',
    )
    expect(`${spawnFailure.message} ${connectionFailure.message}`).not.toContain(codex.bin)
    expect(`${spawnFailure.message} ${connectionFailure.message}`).not.toContain(secret)
    expect(connectionChild.killed).toBe(1)
  })

  it('fails fast when the child emits an asynchronous spawn error', async () => {
    const child = new FakeChild()
    const secret = `spawn failed ${codex.bin} stderr bearer_token=secret`
    const started = Date.now()
    const resultPromise = runProbe(codex, {
      spawn: spawnWith(child),
      connectionFactory: () => ({ initialize: () => new Promise(() => {}) }),
      timeoutMs: 1000,
    })
    queueMicrotask(() => child.emit('error', new Error(secret)))
    const result = await resultPromise
    expect(result.status).toBe('error')
    expect(result.message).toBe('Codex could not be started. Check that it is installed and available on PATH.')
    expect(result.message).not.toContain(secret)
    expect(result.message).not.toContain(codex.bin)
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('fails fast when the child exits before the handshake', async () => {
    const child = new FakeChild()
    const resultPromise = runProbe(codex, {
      spawn: spawnWith(child),
      connectionFactory: () => ({ initialize: () => new Promise(() => {}) }),
      timeoutMs: 1000,
      kill: target => target.kill(),
    })
    queueMicrotask(() => child.emit('exit', 1, null))
    const result = await resultPromise
    expect(result.status).toBe('error')
    expect(result.message).toBe('Codex exited before completing the ACP handshake. Try restarting it.')
    expect(child.killed).toBe(1)
  })

  it('maps a hung handshake to an error by the injected timeout', async () => {
    const child = new FakeChild()
    const result = await runProbe(codex, {
      spawn: spawnWith(child),
      connectionFactory: () => ({ initialize: () => new Promise(() => {}) }),
      timeoutMs: 20,
      platform: 'linux',
    })
    expect(result.status).toBe('error')
    expect(result.message).toBe('Codex did not answer the ACP handshake within 0.02s.')
    expect(child.killed).toBe(1)
  })

  it('maps auth probe rejection to bounded sign-in guidance and preserves the unauthenticated warning', async () => {
    const secret = `ACPError ${claude.bin} authentication_failed token=secret`
    const rejected = await runProbe(claude, {
      spawn: spawnWith(new FakeChild()),
      connectionFactory: () => ({ initialize: async () => initialized }),
      claudeAuthProbe: async () => {
        throw new Error(secret)
      },
    })
    expect(rejected).toEqual({
      status: 'error',
      auth: { status: 'unknown' },
      message: 'Claude Code sign-in could not be verified. Run `claude auth status` and sign in if needed.',
    })
    expect(rejected.message).not.toContain(secret)

    const unauthenticated = await runProbe(claude, {
      spawn: spawnWith(new FakeChild()),
      connectionFactory: () => ({ initialize: async () => initialized }),
      claudeAuthProbe: async () => 'unauthenticated',
    })
    expect(unauthenticated).toMatchObject({
      status: 'warning',
      auth: { status: 'unauthenticated' },
      message: 'Claude Code is not signed in',
    })
  })

  it('swallows stdin EPIPE errors', async () => {
    const child = new FakeChild()
    const resultPromise = runProbe(codex, {
      spawn: spawnWith(child),
      connectionFactory: () => ({ initialize: async () => initialized }),
    })
    child.stdin.emit('error', new Error('EPIPE'))
    await expect(resultPromise).resolves.toMatchObject({ status: 'ready' })
  })

  it('keeps Effect defects and interruption out of ordinary probe error rows', async () => {
    const defectChild = new FakeChild()
    const defect = await Effect.runPromiseExit(
      probeHarness(codex, {
        spawn: spawnWith(defectChild),
        connectionFactory: () => ({ initialize: async () => initialized }),
        kill: () => {
          throw new Error('cleanup defect')
        },
      }),
    )
    expect(Exit.isFailure(defect)).toBe(true)
    if (Exit.isFailure(defect)) expect(Cause.hasDies(defect.cause)).toBe(true)

    const interruptedChild = new FakeChild()
    const fiber = Effect.runFork(
      probeHarness(codex, {
        spawn: spawnWith(interruptedChild),
        connectionFactory: () => ({ initialize: () => new Promise<InitializeResponse>(() => {}) }),
        kill: target => target.kill(),
      }),
    )
    await Effect.runPromise(Fiber.interrupt(fiber))
    const interruption = await Effect.runPromise(Fiber.await(fiber))
    expect(Exit.isFailure(interruption)).toBe(true)
    if (Exit.isFailure(interruption)) expect(Cause.hasInterruptsOnly(interruption.cause)).toBe(true)
    expect(interruptedChild.killed).toBe(1)
  })

  it('gives slow-booting harnesses a longer per-spec deadline', () => {
    expect(probeTimeoutFor('copilot')).toBe(30_000)
    expect(probeTimeoutFor('codex')).toBe(HARNESS_HANDSHAKE_TIMEOUT_MS)
  })

  it('uses taskkill tree termination on win32 when a PID is available', async () => {
    const calls: unknown[][] = []
    const execFile = new Proxy(childProcess.execFile, {
      apply(_target, _thisArg, args) {
        calls.push(args)
        const callback = args[3]
        if (typeof callback === 'function') Reflect.apply(callback, undefined, [null, '', ''])
        return new childProcess.ChildProcess()
      },
    })
    const child = new FakeChild()
    await runProbe(codex, {
      platform: 'win32',
      spawn: spawnWith(child),
      connectionFactory: () => ({ initialize: async () => initialized }),
      execFile,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.slice(0, 3)).toEqual(['taskkill', ['/pid', '4321', '/T', '/F'], { windowsHide: true }])
    expect(calls[0]?.[3]).toEqual(expect.any(Function))
    expect(child.killed).toBe(0)
  })
})
