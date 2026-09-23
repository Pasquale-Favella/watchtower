import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HARNESS_PROBE_TIMEOUT_MS, probeHarness, probeTimeoutFor, type ProbeChild, type ProbeConnection, type ProbeResult, type ProbeSpawn } from '../src/main/agents/probe.js'
import type { HarnessInfo } from '../src/main/agents/detect.js'

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

const initialized = { protocolVersion: 1, agentInfo: { version: '1.2.3' } } as never

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
      kill: () => { child.killed += 1 },
    })

    expect(result).toMatchObject({ status: 'ready', auth: { status: 'unknown' }, version: '1.2.3' })
    expect(calls).toEqual(['initialize'])
    expect(child.killed).toBe(1)
  })

  it('does not treat advertised authMethods as a signed-out signal', async () => {
    const child = new FakeChild()
    const result = await runProbe(codex, {
      spawn: spawnWith(child),
      connectionFactory: () => ({ initialize: async () => ({ ...initialized, authMethods: [{ id: 'login' }] }) as never }),
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
    expect(result).toMatchObject({ status: 'warning', auth: { status: 'unauthenticated' }, message: 'Claude Code is not signed in' })
  })

  it('returns an actionable error containing display name and binary path when initialize throws', async () => {
    const child = new FakeChild()
    const result = await runProbe(codex, {
      spawn: spawnWith(child),
      connectionFactory: () => ({ initialize: async () => { throw new Error('handshake failed') } }),
    })
    expect(result.status).toBe('error')
    expect(result.message).toContain('Codex')
    expect(result.message).toContain(codex.bin)
  })

  it('fails fast when the child emits an asynchronous spawn error', async () => {
    const child = new FakeChild()
    const started = Date.now()
    const resultPromise = runProbe(codex, {
      spawn: spawnWith(child),
      connectionFactory: () => ({ initialize: () => new Promise(() => {}) }),
      timeoutMs: 1000,
    })
    queueMicrotask(() => child.emit('error', new Error('ENOENT')))
    const result = await resultPromise
    expect(result.status).toBe('error')
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('fails fast when the child exits before the handshake', async () => {
    const child = new FakeChild()
    const resultPromise = runProbe(codex, {
      spawn: spawnWith(child),
      connectionFactory: () => ({ initialize: () => new Promise(() => {}) }),
      timeoutMs: 1000,
    })
    queueMicrotask(() => child.emit('exit', 1, null))
    const result = await resultPromise
    expect(result.status).toBe('error')
    expect(result.message).toContain('exited before handshake')
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
    expect(result.message).toContain('0.02s')
    expect(child.killed).toBe(1)
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

  it('gives slow-booting harnesses a longer per-spec deadline', () => {
    expect(probeTimeoutFor('copilot')).toBe(30_000)
    expect(probeTimeoutFor('codex')).toBe(HARNESS_PROBE_TIMEOUT_MS)
  })

  it('uses taskkill tree termination on win32 when a PID is available', async () => {
    const execFile = vi.fn(((_file, _args, _options, callback) => {
      if (typeof callback === 'function') callback(null, '', '')
      return undefined as never
    }) as Parameters<NonNullable<Parameters<typeof probeHarness>[1]>['execFile']>[0])
    const child = new FakeChild()
    await runProbe(codex, {
      platform: 'win32',
      spawn: spawnWith(child),
      connectionFactory: () => ({ initialize: async () => initialized }),
      execFile,
    })
    expect(execFile).toHaveBeenCalledWith('taskkill', ['/pid', '4321', '/T', '/F'], { windowsHide: true }, expect.any(Function))
    expect(child.killed).toBe(0)
  })
})
