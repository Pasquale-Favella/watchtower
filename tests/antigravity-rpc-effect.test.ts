import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: string[] }>,
  execTimeouts: [] as number[],
  requests: [] as Array<{
    path: string
    headers: Record<string, string>
    body: string
    timeout: number
    destroy: ReturnType<typeof vi.fn>
  }>,
  hangNextRequest: false,
  holdProbeBody: false,
  hangNextExec: false,
  invalidJsonCountdown: 0,
  processKill: vi.fn(),
  agentOptions: [] as Array<{ rejectUnauthorized: boolean }>,
  oversizedCountdown: 0,
}))

vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (
      command: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      state.calls.push({ command, args })
      state.execTimeouts.push((_options as { timeout: number }).timeout)
      if (state.hangNextExec) {
        state.hangNextExec = false
        const handlers = new Map<string, () => void>()
        const child = {
          once: (event: string, listener: () => void) => {
            handlers.set(event, listener)
            return child
          },
          kill: state.processKill.mockImplementation(() => queueMicrotask(() => handlers.get('close')?.())),
        }
        return child as unknown as ReturnType<typeof actual.execFile>
      }
      const script = args.at(-1) ?? ''
      const candidate =
        'language_server_antigravity --https_server_port 0 --csrf_token effecttoken1234567890 --app_data_dir antigravity-cli'
      let stdout: string
      if (command === 'powershell.exe') {
        stdout = script.includes('Get-CimInstance') ? `${JSON.stringify({ PID: 112, Cmd: candidate })}\n` : '43124\n'
      } else if (args.includes('-eo') && args.includes('pid=,args=')) {
        stdout = `112 ${candidate}\n`
      } else if (args[0] === '-a') {
        stdout =
          'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nlanguage_server 112 user 10u IPv4 0t0 TCP 127.0.0.1:43124 (LISTEN)\n'
      } else {
        stdout = `${candidate}\n`
      }
      callback(null, stdout)
      return {} as ReturnType<typeof actual.execFile>
    },
  }
})

vi.mock('https', async importOriginal => {
  const actual = await importOriginal<typeof import('node:https')>()
  class Emitter {
    private readonly handlers = new Map<string, Array<(value?: Buffer) => void>>()
    destroyed = false

    on(event: string, handler: (value?: Buffer) => void): this {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
      return this
    }

    once(event: string, handler: (value?: Buffer) => void): this {
      const onceHandler = (value?: Buffer): void => {
        this.handlers.set(
          event,
          (this.handlers.get(event) ?? []).filter(item => item !== onceHandler),
        )
        handler(value)
      }
      return this.on(event, onceHandler)
    }

    emit(event: string, value?: Buffer): void {
      for (const handler of this.handlers.get(event) ?? []) handler(value)
    }

    destroy(): void {
      this.destroyed = true
      queueMicrotask(() => this.emit('close'))
    }
  }
  const request = (
    options: { path: string; headers: Record<string, string>; timeout: number },
    onResponse: (response: Emitter & { statusCode: number; resume: () => void }) => void,
  ) => {
    const req = new Emitter() as Emitter & { write: (data: string) => void; end: () => void }
    let body = ''
    const recorded = {
      path: options.path,
      headers: options.headers,
      body: '',
      timeout: options.timeout,
      destroy: vi.fn(),
    }
    req.destroy = recorded.destroy.mockImplementation(() => Emitter.prototype.destroy.call(req))
    state.requests.push(recorded)
    req.write = data => {
      body += data
      recorded.body = body
    }
    req.end = () => {
      if (state.hangNextRequest) {
        state.hangNextRequest = false
        return
      }
      const response = Object.assign(new Emitter(), { statusCode: 200, resume: () => undefined })
      onResponse(response)
      if (state.holdProbeBody && state.requests.length === 1) return
      queueMicrotask(() => {
        const content = options.path.endsWith('GetAvailableModels')
          ? { models: { 'gemini-3-pro': { model: 'gemini-3-pro', displayName: 'Gemini 3 Pro' } } }
          : { generatorMetadata: [] }
        const availableModels = options.path.endsWith('GetAvailableModels')
        const invalidJson = availableModels && --state.invalidJsonCountdown === 0
        const oversized = availableModels && --state.oversizedCountdown === 0
        const payload = oversized
          ? Buffer.alloc(16 * 1024 * 1024 + 1)
          : Buffer.from(invalidJson ? '{' : JSON.stringify(content))
        response.emit('data', payload)
        response.emit('end')
        req.emit('close')
      })
    }
    return req
  }
  function Agent(options: { rejectUnauthorized: boolean }): Record<string, never> {
    state.agentOptions.push(options)
    return {}
  }
  return { ...actual, request, Agent, default: { ...actual, request, Agent } } as unknown as typeof actual
})

import type { SessionSource } from '../src/main/pipeline/providers/types.js'
import { providerParserIterator } from './fixtures/provider-effects.js'

let createAntigravityProvider: typeof import('../src/main/pipeline/providers/antigravity.js').createAntigravityProvider
let extractAntigravityModelMap: typeof import('../src/main/pipeline/providers/antigravity.js').extractAntigravityModelMap

let root = ''
const source = (): SessionSource => ({
  path: join(root, '.gemini', 'antigravity-cli', 'conversations', 'rpc-effect.pb'),
  project: 'antigravity-cli',
  provider: 'antigravity',
})

beforeEach(async () => {
  vi.resetModules()
  root = mkdtempSync(join(tmpdir(), 'watchtower-antigravity-rpc-effect-'))
  const { initAppPaths } = await import('../src/main/env.js')
  initAppPaths({ cacheDir: join(root, 'cache') })
  ;({ createAntigravityProvider, extractAntigravityModelMap } =
    await import('../src/main/pipeline/providers/antigravity.js'))
  const file = source().path
  mkdirSync(join(root, '.gemini', 'antigravity-cli', 'conversations'), { recursive: true })
  writeFileSync(file, new Uint8Array())
  state.calls.length = 0
  state.execTimeouts.length = 0
  state.requests.length = 0
  state.hangNextRequest = false
  state.holdProbeBody = false
  state.hangNextExec = false
  state.invalidJsonCountdown = 0
  state.processKill.mockClear()
  state.agentOptions.length = 0
  state.oversizedCountdown = 0
})

afterEach(() => {
  if (root) {
    const target = resolve(root)
    const prefix = 'watchtower-antigravity-rpc-effect-'
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !basename(target).startsWith(prefix) ||
      basename(target).length <= prefix.length
    ) {
      throw new Error(`Refusing to remove unexpected Antigravity fixture: ${target}`)
    }
    rmSync(target, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

describe('Antigravity RPC Effects', () => {
  it('keeps valid model entries when an unused fallback entry is malformed', () => {
    expect(
      extractAntigravityModelMap({
        models: {
          'gemini-3-pro': { model: 'gemini-3-pro', displayName: 'Gemini 3 Pro' },
          unused: null,
        },
      }),
    ).toEqual({ 'gemini-3-pro': 'gemini-3-pro' })
  })

  it('kills and settles process inspection when the parser signal aborts', async () => {
    const controller = new AbortController()
    const ideSource: SessionSource = {
      ...source(),
      path: join(root, '.gemini', 'antigravity-ide', 'conversations', 'rpc-effect-ide.pb'),
    }
    mkdirSync(join(root, '.gemini', 'antigravity-ide', 'conversations'), { recursive: true })
    writeFileSync(ideSource.path, new Uint8Array())
    state.hangNextExec = true
    const pending = providerParserIterator(
      createAntigravityProvider().createSessionParser(ideSource, new Set(), undefined, { signal: controller.signal }),
    ).next()
    while (state.calls.length === 0) await new Promise(resolve => setTimeout(resolve, 0))
    controller.abort()
    await expect(pending).rejects.toHaveProperty('name', 'ScanAbortedError')
    expect(state.processKill).toHaveBeenCalledTimes(1)
  })

  it('resolves ephemeral ports after process inspection and applies the local RPC protocol', async () => {
    const pending = providerParserIterator(createAntigravityProvider().createSessionParser(source(), new Set())).next()
    await pending

    expect(state.calls.map(call => call.command)).toEqual(
      process.platform === 'win32' ? ['powershell.exe', 'powershell.exe', 'powershell.exe'] : ['ps', 'ps', 'lsof'],
    )
    expect(state.execTimeouts).toEqual(process.platform === 'win32' ? [5000, 5000, 5000] : [3000, 3000, 3000])
    expect(state.requests.map(request => request.path)).toEqual([
      ...(process.platform === 'win32' ? ['/exa.language_server_pb.LanguageServerService/GetAvailableModels'] : []),
      '/exa.language_server_pb.LanguageServerService/GetAvailableModels',
      '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata',
    ])
    expect(state.requests[0]?.headers).toMatchObject({
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      'X-Codeium-Csrf-Token': 'effecttoken1234567890',
    })
    expect(state.agentOptions).toEqual([{ rejectUnauthorized: false }])
    expect(state.requests.map(request => request.timeout)).toEqual(
      process.platform === 'win32' ? [1000, 5000, 5000] : [5000, 5000],
    )
    expect(state.requests[0]?.body).toBe('{}')
    expect(JSON.parse(state.requests.at(-1)?.body ?? '{}')).toEqual({ cascadeId: 'rpc-effect' })
  })

  it.skipIf(process.platform !== 'win32')(
    'accepts probe headers without waiting for or reading the unused response body',
    async () => {
      state.holdProbeBody = true
      await providerParserIterator(createAntigravityProvider().createSessionParser(source(), new Set())).next()
      expect(state.requests).toHaveLength(3)
      expect(state.requests[0]?.destroy).toHaveBeenCalledTimes(1)
    },
  )

  it('destroys and settles an in-flight HTTPS request when the parser signal aborts', async () => {
    const controller = new AbortController()
    state.hangNextRequest = true
    const pending = providerParserIterator(
      createAntigravityProvider().createSessionParser(source(), new Set(), undefined, { signal: controller.signal }),
    ).next()
    while (state.requests.length === 0) await new Promise(resolve => setTimeout(resolve, 0))
    controller.abort()
    await expect(pending).rejects.toHaveProperty('name', 'ScanAbortedError')
    expect(state.requests[0]?.destroy).toHaveBeenCalledTimes(1)
  })

  it('falls back from an invalid model-map RPC response and continues to metadata', async () => {
    state.invalidJsonCountdown = process.platform === 'win32' ? 2 : 1
    await providerParserIterator(createAntigravityProvider().createSessionParser(source(), new Set())).next()
    expect(state.requests.map(request => request.path.endsWith('GetCascadeTrajectoryGeneratorMetadata'))).toEqual(
      process.platform === 'win32' ? [false, false, true] : [false, true],
    )
  })

  it('closes an oversized model-map response and continues with the empty fallback map', async () => {
    state.oversizedCountdown = process.platform === 'win32' ? 2 : 1
    await providerParserIterator(createAntigravityProvider().createSessionParser(source(), new Set())).next()
    expect(state.requests[process.platform === 'win32' ? 1 : 0]?.destroy).toHaveBeenCalledTimes(1)
    expect(state.requests.at(-1)?.path.endsWith('GetCascadeTrajectoryGeneratorMetadata')).toBe(true)
  })
})
