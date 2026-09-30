import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HarnessInfo } from '../src/main/agents/detect.js'
import type { CoachStreamPart } from '../src/main/agents/events.js'
import { harnessSpecs } from '../src/main/agents/harnesses/index.js'
import { decodeResumeCursor } from '../src/main/agents/resume-cursor.js'
import {
  acpSpawnCommand,
  createHarnessRuntime,
  type HarnessSdk,
  isAuthFailureMessage,
  killTreeBeforeForceCleanup,
} from '../src/main/agents/runtime.js'

const claudeHarness: HarnessInfo = {
  name: 'claude',
  kind: 'claude',
  displayName: 'Claude Code',
  bin: 'C:\\bin\\claude-agent-acp.exe',
  scrubEnv: ['ANTHROPIC_API_KEY'],
  authStatus: 'unknown',
}

/** A fake SDK whose createACPProvider returns a scripted provider and whose
 *  streamText streams scripted AI SDK parts. */
function fakeSdk(parts: CoachStreamPart[]): {
  sdk: HarnessSdk
  provider: {
    languageModel: ReturnType<typeof vi.fn>
    initSession: ReturnType<typeof vi.fn>
    cleanup: ReturnType<typeof vi.fn>
  }
  /** The initSession handshake payload the fake returns — mirrors the real
   *  NewSessionResponse (models/modes optional, agent-dependent). */
  sessionResponse: { sessionId: string; models?: unknown; modes?: unknown }
  streamText: ReturnType<typeof vi.fn>
  createACPProvider: ReturnType<typeof vi.fn>
} {
  const provider = {
    languageModel: vi.fn(() => ({ providerId: 'acp' })),
    tools: { 'acp.acp_provider_agent_dynamic_tool': {} },
    initSession: vi.fn(async () => sessionResponse),
    getSessionId: vi.fn(() => 'sess_9'),
    cleanup: vi.fn(),
  }
  const sessionResponse: { sessionId: string; models?: unknown; modes?: unknown } = { sessionId: 'sess_9' }
  const streamText = vi.fn(async function* () {
    for (const p of parts) yield p
  })
  const createACPProvider = vi.fn(() => provider)
  return {
    sdk: {
      createACPProvider,
      streamText,
    } as unknown as HarnessSdk,
    provider,
    streamText,
    createACPProvider,
    sessionResponse,
  }
}

const tempDirs: string[] = []
function realWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'watchtower-agents-'))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env.ANTHROPIC_API_KEY
})

describe('createHarnessRuntime — the seam (system boundary mocked at the SDK)', () => {
  it('runs a harness and derives CoachEvents from the streamed AI SDK parts', async () => {
    const { sdk, provider, streamText, createACPProvider } = fakeSdk([
      { type: 'text-delta', text: 'Hello' },
      { type: 'tool-input-start', toolName: 'Bash' },
      { type: 'finish', finishReason: 'stop' },
    ])
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    const events = []
    for await (const event of runtime.run({
      harness: claudeHarness,
      modelId: 'claude-opus-4-8',
      workspacePath: realWorkspace(),
      prompt: 'List the files',
    })) {
      events.push(event)
    }

    expect(events).toEqual([
      { kind: 'status', state: 'starting' },
      { kind: 'session', resumeCursor: expect.any(String) },
      { kind: 'text', delta: 'Hello' },
      { kind: 'tool', tool: 'Bash', state: 'started', id: 'tool-1' },
      { kind: 'status', state: 'done' },
    ])
    expect(createACPProvider).toHaveBeenCalledOnce()
    expect(provider.initSession).toHaveBeenCalledOnce()
    expect(streamText).toHaveBeenCalledOnce()
    const streamCall = streamText.mock.calls[0]![0]
    expect(streamCall.prompt).toBe('List the files')
    expect(streamCall.tools).toBeDefined()
    expect(streamCall.abortSignal?.aborted).toBe(false)
    expect(provider.languageModel).toHaveBeenCalledWith('claude-opus-4-8', undefined)
  })

  it('builds the ACP provider from the harness spec and the real workspace path', async () => {
    const { sdk, createACPProvider } = fakeSdk([])
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })
    const workspace = realWorkspace()

    for await (const _event of runtime.run({
      harness: claudeHarness,
      modelId: 'm',
      workspacePath: workspace,
      prompt: 'p',
    })) {
      // no-op
    }

    const config = createACPProvider.mock.calls[0]![0]
    expect(config.command).toBe('claude-agent-acp')
    expect(config.args).toEqual([])
    expect(config.session.cwd).toBe(workspace)
    expect(config.session.mcpServers).toEqual([])
  })

  it('scrubs the harness API keys from the env passed to the agent process', async () => {
    process.env.ANTHROPIC_API_KEY = 'secret-key'
    process.env.PATH = 'C:\\bin'
    const { sdk, createACPProvider } = fakeSdk([])
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    for await (const _event of runtime.run({
      harness: claudeHarness,
      modelId: 'm',
      workspacePath: realWorkspace(),
      prompt: 'p',
    })) {
      // no-op
    }

    const env = createACPProvider.mock.calls[0]![0].env as Record<string, string>
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.PATH).toBe('C:\\bin')
  })

  it('passes the resume session id as existingSessionId on the provider', async () => {
    const { sdk, createACPProvider } = fakeSdk([])
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    for await (const _event of runtime.run({
      harness: claudeHarness,
      modelId: 'm',
      workspacePath: realWorkspace(),
      prompt: 'p',
      sessionId: 'sess_prev',
    })) {
      // no-op
    }

    expect(createACPProvider.mock.calls[0]![0].existingSessionId).toBe('sess_prev')
  })

  it("rides the agent's handshake models/modes on the session event (progressive selection)", async () => {
    const { sdk, sessionResponse } = fakeSdk([])
    sessionResponse.models = {
      availableModels: [
        { modelId: 'opus', name: 'Claude Opus' },
        { modelId: 'sonnet', name: 'Claude Sonnet' },
      ],
      currentModelId: 'opus',
    }
    sessionResponse.modes = {
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'plan', name: 'Plan' },
      ],
      currentModeId: 'default',
    }
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    const events = []
    for await (const event of runtime.run({
      harness: claudeHarness,
      modelId: 'm',
      workspacePath: realWorkspace(),
      prompt: 'p',
    })) {
      events.push(event)
    }

    expect(events[1]).toEqual({
      kind: 'session',
      resumeCursor: expect.any(String),
      models: {
        availableModels: [
          { modelId: 'opus', name: 'Claude Opus' },
          { modelId: 'sonnet', name: 'Claude Sonnet' },
        ],
        currentModelId: 'opus',
      },
      modes: {
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'plan', name: 'Plan' },
        ],
        currentModeId: 'default',
      },
    })
  })

  it("forwards the user's modelId and modeId to languageModel()", async () => {
    const { sdk, provider } = fakeSdk([])
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    for await (const _event of runtime.run({
      harness: claudeHarness,
      modelId: 'sonnet',
      modeId: 'plan',
      workspacePath: realWorkspace(),
      prompt: 'p',
    })) {
      // no-op
    }

    expect(provider.languageModel).toHaveBeenCalledWith('sonnet', 'plan')
  })

  it('refuses a workspace path that is not a real on-disk directory', async () => {
    const { sdk, createACPProvider } = fakeSdk([])
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    await expect(async () => {
      for await (const _event of runtime.run({
        harness: claudeHarness,
        modelId: 'm',
        workspacePath: 'C:\\nonexistent\\path',
        prompt: 'p',
      })) {
        // no-op
      }
    }).rejects.toThrow(/real on-disk/i)
    expect(createACPProvider).not.toHaveBeenCalled()
  })

  it('refuses a harness kind that has no ACP adapter in the registry', async () => {
    const { sdk, createACPProvider } = fakeSdk([])
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    await expect(async () => {
      for await (const _event of runtime.run({
        harness: { ...claudeHarness, kind: 'zerostack', name: 'zerostack' },
        modelId: 'm',
        workspacePath: realWorkspace(),
        prompt: 'p',
      })) {
        // no-op
      }
    }).rejects.toThrow(/no ACP adapter/i)
    expect(createACPProvider).not.toHaveBeenCalled()
  })

  it('surfaces an initSession failure (unavailable agent) as an error event and cleans up', async () => {
    const { sdk, provider, streamText } = fakeSdk([])
    provider.initSession.mockRejectedValue(new Error('agent binary not found'))
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    const events = []
    for await (const event of runtime.run({
      harness: claudeHarness,
      modelId: 'm',
      workspacePath: realWorkspace(),
      prompt: 'p',
    })) {
      events.push(event)
    }

    expect(events).toEqual([
      { kind: 'status', state: 'starting' },
      { kind: 'error', message: 'agent binary not found' },
    ])
    expect(streamText).not.toHaveBeenCalled()
    expect(provider.cleanup).toHaveBeenCalledOnce()
  })

  it('propagates a stream error part as an error outcome without crashing the loop', async () => {
    const { sdk } = fakeSdk([{ type: 'error', error: new Error('credential wall') }])
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    const events = []
    for await (const event of runtime.run({
      harness: claudeHarness,
      modelId: 'm',
      workspacePath: realWorkspace(),
      prompt: 'p',
    })) {
      events.push(event)
    }
    expect(events).toEqual([
      { kind: 'status', state: 'starting' },
      { kind: 'session', resumeCursor: expect.any(String) },
      { kind: 'error', message: 'credential wall' },
    ])
  })

  it('keeps the harness API keys in the agent env when the passthrough opt-in is set', async () => {
    process.env.ANTHROPIC_API_KEY = 'secret-key'
    const { sdk, createACPProvider } = fakeSdk([])
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    for await (const _event of runtime.run({
      harness: claudeHarness,
      modelId: 'm',
      workspacePath: realWorkspace(),
      prompt: 'p',
      allowApiKeyEnv: true,
    })) {
      // no-op
    }

    const env = createACPProvider.mock.calls[0]![0].env as Record<string, string>
    expect(env.ANTHROPIC_API_KEY).toBe('secret-key')
  })

  it('maps a warm-up authentication wall to the actionable Claude sign-in error', async () => {
    const { sdk, provider, streamText } = fakeSdk([])
    provider.initSession.mockRejectedValue(
      new Error('Internal error: Failed to authenticate: OAuth session expired and could not be refreshed'),
    )
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    const events = []
    for await (const event of runtime.run({
      harness: claudeHarness,
      modelId: 'm',
      workspacePath: realWorkspace(),
      prompt: 'p',
    })) {
      events.push(event)
    }

    expect(events).toEqual([
      { kind: 'status', state: 'starting' },
      { kind: 'error', message: expect.stringContaining('claude auth login') },
    ])
    expect((events[1] as { message: string }).message).toContain('OAuth session expired')
    expect(streamText).not.toHaveBeenCalled()
    expect(provider.cleanup).toHaveBeenCalledOnce()
  })

  it('maps a stream-time authentication wall to the actionable Claude sign-in error', async () => {
    const { sdk } = fakeSdk([
      { type: 'error', error: new Error('Failed to authenticate: OAuth session expired and could not be refreshed') },
    ])
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    const events = []
    for await (const event of runtime.run({
      harness: claudeHarness,
      modelId: 'm',
      workspacePath: realWorkspace(),
      prompt: 'p',
    })) {
      events.push(event)
    }

    expect(events).toEqual([
      { kind: 'status', state: 'starting' },
      { kind: 'session', resumeCursor: expect.any(String) },
      { kind: 'error', message: expect.stringContaining('claude auth login') },
    ])
  })

  it('uses the generic sign-in hint for non-Claude harnesses', async () => {
    const { sdk, provider } = fakeSdk([])
    provider.initSession.mockRejectedValue(new Error('Failed to authenticate'))
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })
    const codexHarness: HarnessInfo = {
      ...claudeHarness,
      name: 'codex',
      kind: 'codex',
      displayName: 'Codex',
      scrubEnv: ['OPENAI_API_KEY'],
    }

    const events = []
    for await (const event of runtime.run({
      harness: codexHarness,
      modelId: 'm',
      workspacePath: realWorkspace(),
      prompt: 'p',
    })) {
      events.push(event)
    }

    expect(events[1]).toEqual({
      kind: 'error',
      message: expect.stringContaining("run 'codex login' in a terminal"),
    })
    expect((events[1] as { message: string }).message).not.toContain('claude auth login')
  })

  it('isAuthFailureMessage matches auth walls only — never plain session/resume expiries', () => {
    expect(
      isAuthFailureMessage('Internal error: Failed to authenticate: OAuth session expired and could not be refreshed'),
    ).toBe(true)
    expect(isAuthFailureMessage('Session expired. Please run /login to sign in again.')).toBe(true)
    expect(isAuthFailureMessage('Not logged in · Please run /login')).toBe(true)
    expect(isAuthFailureMessage('ACPError: authentication_failed')).toBe(true)
    expect(isAuthFailureMessage('agent binary not found')).toBe(false)
    // An ACP resume-handle expiry has its own retry path — mapping it to a
    // sign-in hint would mislead.
    expect(isAuthFailureMessage('ACP session expired, resume with a fresh id')).toBe(false)
  })

  it('cancelling the run interrupts the SAME SDK iterator and cleans up the provider', async () => {
    const { sdk, provider, streamText } = fakeSdk([{ type: 'text-delta', text: 'slow text' }])
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    const gen = runtime.run({ harness: claudeHarness, modelId: 'm', workspacePath: realWorkspace(), prompt: 'p' })
    // starting → session, then the first streamed text delta (streamText now live).
    expect((await gen.next()).value).toEqual({ kind: 'status', state: 'starting' })
    const sessionEvent = (await gen.next()).value
    expect(sessionEvent).toEqual({ kind: 'session', resumeCursor: expect.any(String) })
    expect(decodeResumeCursor((sessionEvent as { resumeCursor: string }).resumeCursor, 'claude')).toBe('sess_9')
    expect((await gen.next()).value).toEqual({ kind: 'text', delta: 'slow text' })
    expect(streamText).toHaveBeenCalledOnce()

    // Consumer cancels the outer generator mid-run.
    await gen.return(undefined)
    const exhausted = await gen.next()
    expect(exhausted.done).toBe(true)
    expect(provider.cleanup).toHaveBeenCalledOnce()
  })

  it('aborts the stream signal when the consumer cancels mid-stream', async () => {
    const { sdk, streamText } = fakeSdk([{ type: 'text-delta', text: 'slow text' }])
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })
    const gen = runtime.run({ harness: claudeHarness, workspacePath: realWorkspace(), prompt: 'p' })

    await gen.next()
    await gen.next()
    await gen.next()
    const signal = streamText.mock.calls[0]![0].abortSignal as AbortSignal
    expect(signal.aborted).toBe(false)

    await gen.return(undefined)

    expect(signal.aborted).toBe(true)
  })

  it('bounds a stalled iterator return during cancellation', async () => {
    const { sdk, provider } = fakeSdk([])
    const iterator = {
      next: vi.fn(async () => ({ done: false as const, value: { type: 'text-delta' as const, text: 'live' } })),
      return: vi.fn(() => new Promise<never>(() => {})),
    }
    sdk.streamText = vi.fn(() => ({ [Symbol.asyncIterator]: () => iterator }))
    const runtime = createHarnessRuntime(sdk, { platform: 'linux', cancelDrainMs: 20 })
    const gen = runtime.run({ harness: claudeHarness, workspacePath: realWorkspace(), prompt: 'p' })

    await gen.next()
    await gen.next()
    await gen.next()
    await expect(gen.return(undefined)).resolves.toMatchObject({ done: true })
    expect(provider.cleanup).toHaveBeenCalledOnce()
  })

  it('stops a pending pull through the independent handle and forces cleanup once', async () => {
    const { sdk, provider } = fakeSdk([])
    const iterator = {
      next: vi
        .fn()
        .mockResolvedValueOnce({ done: false as const, value: { type: 'text-delta' as const, text: 'live' } })
        .mockImplementation(() => new Promise<never>(() => {})),
      return: vi.fn(() => new Promise<never>(() => {})),
    }
    let capturedSignal: AbortSignal | undefined
    const controlledStreamText = vi.fn((options: { abortSignal?: AbortSignal }) => {
      capturedSignal = options.abortSignal
      return { [Symbol.asyncIterator]: () => iterator }
    })
    sdk.streamText = controlledStreamText
    const forceCleanup = vi.fn()
    Object.assign(provider, { cleanup: vi.fn(() => new Promise<never>(() => {})), forceCleanup })
    const runtime = createHarnessRuntime(sdk, { platform: 'linux', cancelDrainMs: 15 })
    const run = runtime.runControlled!({ harness: claudeHarness, workspacePath: realWorkspace(), prompt: 'p' })

    await expect(run.events.next()).resolves.toMatchObject({ value: { kind: 'status', state: 'starting' } })
    await expect(run.events.next()).resolves.toMatchObject({ value: { kind: 'session' } })
    await expect(run.events.next()).resolves.toMatchObject({ value: { kind: 'text', delta: 'live' } })
    const pendingPull = run.events.next()
    const stopping = run.stop()
    expect(run.stop()).toBe(stopping)
    await stopping

    await expect(pendingPull).resolves.toEqual({ value: undefined, done: true })
    expect(capturedSignal?.aborted).toBe(true)
    expect(iterator.return).toHaveBeenCalledOnce()
    expect(provider.cleanup).toHaveBeenCalledOnce()
    expect(forceCleanup).toHaveBeenCalledOnce()
  })

  it('forces cleanup once when a naturally completed stream has stalled provider cleanup', async () => {
    const { sdk, provider } = fakeSdk([{ type: 'finish', finishReason: 'stop' }])
    const forceCleanup = vi.fn()
    Object.assign(provider, { cleanup: vi.fn(() => new Promise<never>(() => {})), forceCleanup })
    const runtime = createHarnessRuntime(sdk, { platform: 'linux', cancelDrainMs: 15 })
    const run = runtime.runControlled!({ harness: claudeHarness, workspacePath: realWorkspace(), prompt: 'p' })

    const events: unknown[] = []
    for await (const event of run.events) events.push(event)

    expect(events.at(-1)).toEqual({ kind: 'status', state: 'done' })
    expect(provider.cleanup).toHaveBeenCalledOnce()
    expect(forceCleanup).toHaveBeenCalledOnce()
  })

  it('does not create a fresh provider when stop races stale-resume cleanup', async () => {
    const { sdk, provider, createACPProvider } = fakeSdk([])
    let markCleanupStarted!: () => void
    const cleanupStarted = new Promise<void>(resolve => {
      markCleanupStarted = resolve
    })
    Object.assign(provider, {
      initSession: vi.fn(async () => {
        throw new Error('stale session')
      }),
      cleanup: vi.fn(() => {
        markCleanupStarted()
        return new Promise<never>(() => {})
      }),
    })
    const forceCleanup = vi.fn()
    Object.assign(provider, { forceCleanup })
    const runtime = createHarnessRuntime(sdk, { platform: 'linux', cancelDrainMs: 15 })
    const run = runtime.runControlled!({
      harness: claudeHarness,
      workspacePath: realWorkspace(),
      prompt: 'p',
      sessionId: 'expired-session',
    })

    await expect(run.events.next()).resolves.toMatchObject({ value: { kind: 'status', state: 'starting' } })
    const recovering = run.events.next()
    await cleanupStarted
    await run.stop()

    await expect(recovering).resolves.toEqual({ value: undefined, done: true })
    expect(createACPProvider).toHaveBeenCalledOnce()
    expect(forceCleanup).toHaveBeenCalledOnce()
  })

  it('kills the Windows agent tree before the provider kills its shim', () => {
    const order: string[] = []
    const model = {
      agentProcess: { pid: 9876 } as { pid?: number } | null,
      forceCleanup(this: { agentProcess: unknown }) {
        order.push('forceCleanup')
        this.agentProcess = null
      },
    }
    killTreeBeforeForceCleanup(model, pid => {
      order.push(`kill:${pid}`)
    })

    model.forceCleanup()
    model.forceCleanup()

    expect(order).toEqual(['kill:9876', 'forceCleanup', 'forceCleanup'])
  })
})

describe('createHarnessRuntime — inspect (the pre-flight handshake probe, map 47 ticket 50)', () => {
  it('stops a stalled inspection handshake and forces provider cleanup', async () => {
    const { sdk, provider } = fakeSdk([])
    Object.assign(provider, {
      initSession: vi.fn(() => new Promise<never>(() => {})),
      cleanup: vi.fn(() => new Promise<never>(() => {})),
    })
    const forceCleanup = vi.fn()
    Object.assign(provider, { forceCleanup })
    const runtime = createHarnessRuntime(sdk, { platform: 'linux', cancelDrainMs: 15 })
    const inspection = runtime.inspectControlled!({ harness: claudeHarness, workspacePath: realWorkspace() })

    await vi.waitFor(() => expect(provider.initSession).toHaveBeenCalledOnce())
    const result = expect(inspection.result).rejects.toThrow('cancelled')
    await inspection.stop()
    await result

    expect(provider.cleanup).toHaveBeenCalledOnce()
    expect(forceCleanup).toHaveBeenCalledOnce()
  })

  it('returns the agent-declared models/modes from initSession without streaming a prompt', async () => {
    const { sdk, provider, sessionResponse, streamText } = fakeSdk([])
    sessionResponse.models = {
      availableModels: [
        { modelId: 'opus', name: 'Claude Opus' },
        { modelId: 'sonnet', name: 'Claude Sonnet' },
      ],
      currentModelId: 'opus',
    }
    sessionResponse.modes = {
      availableModes: [{ id: 'plan', name: 'Plan' }],
      currentModeId: 'plan',
    }
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    const result = await runtime.inspect({ harness: claudeHarness, workspacePath: realWorkspace() })

    expect(result).toEqual({
      models: {
        availableModels: [
          { modelId: 'opus', name: 'Claude Opus' },
          { modelId: 'sonnet', name: 'Claude Sonnet' },
        ],
        currentModelId: 'opus',
      },
      modes: {
        availableModes: [{ id: 'plan', name: 'Plan' }],
        currentModeId: 'plan',
      },
    })
    expect(provider.initSession).toHaveBeenCalledOnce()
    expect(provider.cleanup).toHaveBeenCalledOnce()
    expect(streamText).not.toHaveBeenCalled()
  })

  it('returns no selectable set when the agent declares none', async () => {
    const { sdk } = fakeSdk([])
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    const result = await runtime.inspect({ harness: claudeHarness, workspacePath: realWorkspace() })

    expect(result).toEqual({})
  })

  it('builds the provider from the harness spec — the same spawn path as a run', async () => {
    const { sdk, createACPProvider } = fakeSdk([])
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })
    const workspace = realWorkspace()

    await runtime.inspect({ harness: claudeHarness, workspacePath: workspace })

    const config = createACPProvider.mock.calls[0]![0]
    expect(config.command).toBe('claude-agent-acp')
    expect(config.session.cwd).toBe(workspace)
  })

  it('rejects when initSession fails (unavailable agent) and still cleans up the provider', async () => {
    const { sdk, provider } = fakeSdk([])
    provider.initSession.mockRejectedValue(new Error('agent binary not found'))
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    await expect(runtime.inspect({ harness: claudeHarness, workspacePath: realWorkspace() })).rejects.toThrow(
      'agent binary not found',
    )
    expect(provider.cleanup).toHaveBeenCalledOnce()
  })

  it('refuses a workspace path that is not a real on-disk directory', async () => {
    const { sdk, createACPProvider } = fakeSdk([])
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    await expect(runtime.inspect({ harness: claudeHarness, workspacePath: 'C:\\nonexistent\\path' })).rejects.toThrow(
      /real on-disk/i,
    )
    expect(createACPProvider).not.toHaveBeenCalled()
  })
})

describe('createHarnessRuntime — configOptions selects (opencode / claude-agent-acp live shape)', () => {
  function configOptionsSession() {
    return {
      sessionId: 'sess_9',
      // opencode shape: no legacy models/modes — models AND modes live here.
      // claude-agent-acp shape: same model select (subset) + legacy modes.
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          description: 'AI model to use',
          category: 'model',
          type: 'select',
          currentValue: 'sonnet',
          options: [
            { value: 'default', name: 'Default (recommended)', description: 'Opus 5' },
            { value: 'sonnet', name: 'Sonnet', description: 'Sonnet 5' },
            { value: 'haiku', name: 'Haiku', description: 'Haiku 4.5' },
          ],
        },
        {
          id: 'mode',
          name: 'Session Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'build',
          options: [
            { value: 'build', name: 'build' },
            { value: 'plan', name: 'plan' },
          ],
        },
      ],
    }
  }

  it('maps configOptions model/mode selects to models/modes on inspect without a session id', async () => {
    const { sdk, provider, sessionResponse } = fakeSdk([])
    Object.assign(sessionResponse, configOptionsSession())
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    const result = await runtime.inspect({ harness: claudeHarness, workspacePath: realWorkspace() })

    expect(result).toEqual({
      models: {
        availableModels: [
          { modelId: 'default', name: 'Default (recommended)', description: 'Opus 5' },
          { modelId: 'sonnet', name: 'Sonnet', description: 'Sonnet 5' },
          { modelId: 'haiku', name: 'Haiku', description: 'Haiku 4.5' },
        ],
        currentModelId: 'sonnet',
      },
      modes: {
        availableModes: [
          { id: 'build', name: 'build' },
          { id: 'plan', name: 'plan' },
        ],
        currentModeId: 'build',
      },
    })
    expect(provider.initSession).toHaveBeenCalledOnce()
    expect(provider.cleanup).toHaveBeenCalledOnce()
  })

  it('prefers legacy models/modes when both shapes are present', async () => {
    const { sdk, sessionResponse } = fakeSdk([])
    Object.assign(sessionResponse, {
      ...configOptionsSession(),
      models: { availableModels: [{ modelId: 'opus', name: 'Claude Opus' }], currentModelId: 'opus' },
    })
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    const result = await runtime.inspect({ harness: claudeHarness, workspacePath: realWorkspace() })

    expect(result.models).toEqual({
      availableModels: [{ modelId: 'opus', name: 'Claude Opus' }],
      currentModelId: 'opus',
    })
    // Modes still come from configOptions (no legacy modes in this payload).
    expect(result.modes?.currentModeId).toBe('build')
  })

  it('rides configOptions-derived models/modes on the run session event', async () => {
    const { sdk, sessionResponse } = fakeSdk([])
    Object.assign(sessionResponse, configOptionsSession())
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    const events = []
    for await (const event of runtime.run({ harness: claudeHarness, workspacePath: realWorkspace(), prompt: 'p' })) {
      events.push(event)
    }

    expect(events[1]).toMatchObject({
      kind: 'session',
      resumeCursor: expect.any(String),
      models: { currentModelId: 'sonnet' },
      modes: { currentModeId: 'build' },
    })
    const models = (events[1] as { models?: { availableModels: { modelId: string }[] } }).models
    expect(models?.availableModels.map(m => m.modelId)).toEqual(['default', 'sonnet', 'haiku'])
  })

  it('flattens grouped configOptions values', async () => {
    const { sdk, sessionResponse } = fakeSdk([])
    Object.assign(sessionResponse, {
      sessionId: 'sess_9',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'a-1',
          options: [{ group: 'g-a', name: 'Group A', options: [{ value: 'a-1', name: 'One' }] }],
        },
      ],
    })
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    const result = await runtime.inspect({ harness: claudeHarness, workspacePath: realWorkspace() })

    expect(result.models).toEqual({
      availableModels: [{ modelId: 'a-1', name: 'Group A / One' }],
      currentModelId: 'a-1',
    })
  })

  it('applies model/mode picks via setConfigOption before streaming', async () => {
    const { sdk, provider, sessionResponse } = fakeSdk([])
    Object.assign(sessionResponse, configOptionsSession())
    const setConfigOption = vi.fn(async () => ({}))
    ;(provider as unknown as Record<string, unknown>).setConfigOption = setConfigOption
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    const events = []
    for await (const event of runtime.run({
      harness: claudeHarness,
      modelId: 'haiku',
      modeId: 'plan',
      workspacePath: realWorkspace(),
      prompt: 'p',
    })) {
      events.push(event)
    }

    expect(setConfigOption).toHaveBeenCalledTimes(2)
    expect(setConfigOption).toHaveBeenNthCalledWith(1, { sessionId: 'sess_9', configId: 'model', value: 'haiku' })
    expect(setConfigOption).toHaveBeenNthCalledWith(2, { sessionId: 'sess_9', configId: 'mode', value: 'plan' })
    // The legacy languageModel path is kept for legacy-only agents.
    expect(provider.languageModel).toHaveBeenCalledWith('haiku', 'plan')
    expect(events[0]).toEqual({ kind: 'status', state: 'starting' })
  })

  it('surfaces a setConfigOption failure as an error event instead of running with the wrong model', async () => {
    const { sdk, provider, sessionResponse, streamText } = fakeSdk([{ type: 'text-delta', text: 'hi' }])
    Object.assign(sessionResponse, configOptionsSession())
    ;(provider as unknown as Record<string, unknown>).setConfigOption = vi.fn(async () => {
      throw new Error('Invalid params')
    })
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    const events = []
    for await (const event of runtime.run({
      harness: claudeHarness,
      modelId: 'haiku',
      workspacePath: realWorkspace(),
      prompt: 'p',
    })) {
      events.push(event)
    }

    expect(events).toEqual([
      { kind: 'status', state: 'starting' },
      { kind: 'session', resumeCursor: expect.any(String), models: expect.anything(), modes: expect.anything() },
      { kind: 'error', message: 'Invalid params' },
    ])
    expect(streamText).not.toHaveBeenCalled()
  })

  it('skips setConfigOption when the provider does not expose it (fake/legacy SDK)', async () => {
    const { sdk, provider, sessionResponse } = fakeSdk([])
    Object.assign(sessionResponse, configOptionsSession())
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    const events = []
    for await (const event of runtime.run({
      harness: claudeHarness,
      modelId: 'haiku',
      workspacePath: realWorkspace(),
      prompt: 'p',
    })) {
      events.push(event)
    }

    expect(provider.languageModel).toHaveBeenCalledWith('haiku', undefined)
    expect(events[0]).toEqual({ kind: 'status', state: 'starting' })
  })
})

describe('createHarnessRuntime — stale resume fallback', () => {
  it('uses the normal prompt on a successful resumed run, not freshPrompt', async () => {
    const { sdk, streamText } = fakeSdk([])
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    for await (const _event of runtime.run({
      harness: claudeHarness,
      workspacePath: realWorkspace(),
      prompt: 'normal resumed prompt',
      freshPrompt: 'full briefing prompt',
      sessionId: 'sess_prev',
    })) {
      // no-op
    }

    expect(streamText.mock.calls[0]?.[0].prompt).toBe('normal resumed prompt')
  })

  it('falls back to a FRESH session when a resume fails and uses freshPrompt', async () => {
    const { sdk, provider, createACPProvider } = fakeSdk([])
    provider.initSession.mockRejectedValueOnce(new Error('loadSession failed'))
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })
    const mcpServers = [{ name: 'watchtower-ledger', command: 'node', args: ['ledger-mcp.js'], env: [] }]

    const events = []
    for await (const event of runtime.run({
      harness: claudeHarness,
      modelId: 'm',
      workspacePath: realWorkspace(),
      prompt: 'p',
      sessionId: 'sess_probe',
      freshPrompt: "full briefing\n\nThe user's question:\np",
      mcpServers,
    })) {
      events.push(event)
    }

    // The failed resume restarts the provider WITHOUT the resume handle and
    // the run proceeds on a fresh session.
    expect(events).toEqual([
      { kind: 'status', state: 'starting' },
      { kind: 'notice', message: 'The previous session could not be resumed — continuing in a fresh session.' },
      { kind: 'session', resumeCursor: expect.any(String) },
    ])
    expect(createACPProvider).toHaveBeenCalledTimes(2)
    expect(provider.cleanup).toHaveBeenCalledTimes(2)
    const retryConfig = createACPProvider.mock.calls[1]![0]
    expect(retryConfig.existingSessionId).toBeUndefined()
    // The fresh session must still expose the ledger tools — the retry keeps
    // the run's MCP servers (the data-grounding feature depends on it).
    expect(retryConfig.session.mcpServers).toEqual(mcpServers)
  })

  it('surfaces an error when BOTH the resume and its fresh retry fail', async () => {
    const { sdk, provider, createACPProvider, streamText } = fakeSdk([])
    provider.initSession.mockRejectedValue(new Error('agent down'))
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    const events = []
    for await (const event of runtime.run({
      harness: claudeHarness,
      modelId: 'm',
      workspacePath: realWorkspace(),
      prompt: 'p',
      sessionId: 'sess_probe',
      freshPrompt: 'fresh',
    })) {
      events.push(event)
    }

    expect(events).toEqual([
      { kind: 'status', state: 'starting' },
      { kind: 'error', message: 'agent down' },
    ])
    expect(streamText).not.toHaveBeenCalled()
    expect(createACPProvider).toHaveBeenCalledTimes(2)
    // Both providers are torn down.
    expect(provider.cleanup).toHaveBeenCalledTimes(2)
  })

  it('falls back for every genuine resume rather than losing the turn', async () => {
    const { sdk, provider, streamText } = fakeSdk([])
    provider.initSession.mockRejectedValueOnce(new Error('loadSession failed'))
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    const events = []
    for await (const event of runtime.run({
      harness: claudeHarness,
      modelId: 'm',
      workspacePath: realWorkspace(),
      prompt: 'p',
      sessionId: 'sess_prev',
    })) {
      events.push(event)
    }

    expect(events).toEqual([
      { kind: 'status', state: 'starting' },
      { kind: 'notice', message: 'The previous session could not be resumed — continuing in a fresh session.' },
      { kind: 'session', resumeCursor: expect.any(String) },
    ])
    expect(streamText).toHaveBeenCalledOnce()
  })
})

describe('registry → seam integration — every ACP spec maps to a provider config (ADR 0016)', () => {
  // NOTE: this verifies config mapping + event plumbing per spec with a fake
  // SDK — live runnability of the launch commands is ticket #42's job (real
  // CLIs, packaged app). A spec with a nonexistent binary would still pass
  // here; that is caught only by #42's verification matrix.
  it('builds a provider config from EVERY registered ACP spec, matching its acpConfig', async () => {
    const workspace = realWorkspace()
    // `direct` is still a placeholder — every registered spec must be ACP, or
    // the seam's `no ACP adapter` guard would throw for it unnoticed.
    expect(
      harnessSpecs.every(s => s.adapter.kind === 'acp'),
      'every registered spec is ACP',
    ).toBe(true)

    for (const spec of harnessSpecs) {
      if (spec.adapter.kind !== 'acp') throw new Error(`${spec.kind} has no ACP adapter`)
      const { sdk, createACPProvider } = fakeSdk([])
      const runtime = createHarnessRuntime(sdk, { platform: 'linux' })
      const harness: HarnessInfo = {
        name: spec.kind,
        kind: spec.kind,
        displayName: spec.displayName,
        bin: `C:\\bin\\${spec.adapter.acpConfig.command}.exe`,
        scrubEnv: spec.scrubEnv,
        authStatus: 'unknown',
      }

      const events: unknown[] = []
      for await (const event of runtime.run({ harness, modelId: 'm', workspacePath: workspace, prompt: 'p' })) {
        events.push(event)
      }

      expect(createACPProvider, `${spec.kind}: provider must be constructed`).toHaveBeenCalledOnce()
      const config = createACPProvider.mock.calls[0]![0]
      expect(config.command, `${spec.kind}: spawn command`).toBe(spec.adapter.acpConfig.command)
      expect(config.args, `${spec.kind}: args`).toEqual(spec.adapter.acpConfig.args ?? [])
      expect(config.session.cwd, `${spec.kind}: workspace`).toBe(workspace)
      expect(config.session.mcpServers, `${spec.kind}: mcp servers`).toEqual(spec.adapter.acpConfig.mcpServers ?? [])
      if (spec.adapter.acpConfig.authMethodId) {
        expect(config.authMethodId, `${spec.kind}: authMethodId`).toBe(spec.adapter.acpConfig.authMethodId)
      }
      // Per-spec ADR 0012 check: the spec's scrubEnv keys never reach the agent.
      for (const key of spec.scrubEnv) {
        expect(config.env, `${spec.kind}: ${key} scrubbed`).not.toHaveProperty(key)
      }
      // Events still flow end-to-end for every spec.
      expect(events[0]).toEqual({ kind: 'status', state: 'starting' })
      expect(events[1]).toEqual({ kind: 'session', resumeCursor: expect.any(String) })
    }
  })
})

describe('acpSpawnCommand — Windows shim handling (ticket: coach runs on win32)', () => {
  it('wraps a bare npm-shim command through cmd.exe /c on win32', () => {
    expect(acpSpawnCommand('opencode', ['acp'], 'win32')).toEqual({
      command: 'cmd.exe',
      args: ['/c', 'opencode', 'acp'],
    })
    expect(acpSpawnCommand('claude-agent-acp', [], 'win32')).toEqual({
      command: 'cmd.exe',
      args: ['/c', 'claude-agent-acp'],
    })
  })

  it('passes a native .exe through unchanged on win32', () => {
    expect(acpSpawnCommand('claude-agent-acp.exe', [], 'win32')).toEqual({ command: 'claude-agent-acp.exe', args: [] })
  })

  it('passes the command through unchanged on non-Windows platforms', () => {
    expect(acpSpawnCommand('opencode', ['acp'], 'linux')).toEqual({ command: 'opencode', args: ['acp'] })
    expect(acpSpawnCommand('opencode', ['acp'], 'darwin')).toEqual({ command: 'opencode', args: ['acp'] })
  })
})

describe('createHarnessRuntime — win32 spawn wrapping end-to-end', () => {
  it('builds the provider with the cmd.exe /c wrapper on a win32 platform', async () => {
    const { sdk, createACPProvider } = fakeSdk([])
    const runtime = createHarnessRuntime(sdk, { platform: 'win32' })

    for await (const _event of runtime.run({
      harness: claudeHarness,
      modelId: 'm',
      workspacePath: realWorkspace(),
      prompt: 'p',
    })) {
      // no-op
    }

    const config = createACPProvider.mock.calls[0]![0]
    expect(config.command).toBe('cmd.exe')
    expect(config.args).toEqual(['/c', 'claude-agent-acp'])
    expect(config.session.cwd).toBeDefined()
  })

  it("spawns a BUNDLED harness via the app's own Node (ELECTRON_RUN_AS_NODE), no cmd shim", async () => {
    const { sdk, createACPProvider } = fakeSdk([])
    const runtime = createHarnessRuntime(sdk, { platform: 'win32' })
    const bundledHarness: HarnessInfo = {
      ...claudeHarness,
      name: 'codex',
      kind: 'codex',
      displayName: 'Codex',
      bin: 'C:\\app\\node_modules\\@agentclientprotocol\\codex-acp\\dist\\index.js',
      bundledEntry: 'C:\\app\\node_modules\\@agentclientprotocol\\codex-acp\\dist\\index.js',
    }

    for await (const _event of runtime.run({
      harness: bundledHarness,
      modelId: 'm',
      workspacePath: realWorkspace(),
      prompt: 'p',
    })) {
      // no-op
    }

    const config = createACPProvider.mock.calls[0]![0]
    expect(config.command).toBe(process.execPath)
    expect(config.args).toEqual([bundledHarness.bundledEntry])
    expect(config.env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('still passes spec args after the bundled entry (e.g. gemini --acp)', async () => {
    const { sdk, createACPProvider } = fakeSdk([])
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })
    const bundledHarness: HarnessInfo = {
      ...claudeHarness,
      name: 'gemini',
      kind: 'gemini',
      displayName: 'Gemini CLI',
      bin: '/app/node_modules/acp/bin/gemini.js',
      bundledEntry: '/app/node_modules/acp/bin/gemini.js',
    }
    const spec = harnessSpecs.find(s => s.kind === 'gemini')!
    if (spec.adapter.kind !== 'acp') throw new Error('Gemini has no ACP adapter')

    for await (const _event of runtime.run({
      harness: bundledHarness,
      modelId: 'm',
      workspacePath: realWorkspace(),
      prompt: 'p',
    })) {
      // no-op
    }

    const config = createACPProvider.mock.calls[0]![0]
    expect(config.command).toBe(process.execPath)
    expect(config.args).toEqual([bundledHarness.bundledEntry, ...(spec.adapter.acpConfig.args ?? [])])
  })
})

describe('createHarnessRuntime — codex/pi live handshake shapes (regression)', () => {
  /** Codex live shape: bracketed legacy model ids (`gpt-5.6-luna[high]`) plus
   *  base config values (`gpt-5.6-luna`) — the picker shows the legacy ids,
   *  so only the legacy write accepts them. */
  function codexSession() {
    return {
      sessionId: 'sess_9',
      models: {
        availableModels: [
          { modelId: 'gpt-5.6-luna[high]', name: 'GPT-5.6-Luna (high)' },
          { modelId: 'gpt-5.5[low]', name: 'GPT-5.5 (low)' },
        ],
        currentModelId: 'gpt-5.6-luna[high]',
      },
      modes: {
        availableModes: [
          { id: 'agent', name: 'Agent' },
          { id: 'read-only', name: 'Read-only' },
        ],
        currentModeId: 'agent',
      },
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'agent',
          options: [
            { value: 'agent', name: 'Agent' },
            { value: 'read-only', name: 'Read-only' },
          ],
        },
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'gpt-5.6-luna',
          options: [
            { value: 'gpt-5.6-luna', name: 'GPT-5.6-Luna' },
            { value: 'gpt-5.5', name: 'GPT-5.5' },
          ],
        },
        {
          id: 'reasoning_effort',
          name: 'Reasoning',
          category: 'thought_level',
          type: 'select',
          currentValue: 'high',
          options: [
            { value: 'high', name: 'High' },
            { value: 'low', name: 'Low' },
          ],
        },
      ],
    }
  }

  /** Pi live shape: mirrored model lists (legacy + config, config-only
   *  write) and thinking-level modes with NO `mode` config select. */
  function piSession() {
    return {
      sessionId: 'sess_9',
      models: {
        availableModels: [
          { modelId: 'openrouter/a', name: 'A' },
          { modelId: 'openrouter/b', name: 'B' },
        ],
        currentModelId: 'openrouter/a',
      },
      modes: {
        availableModes: [
          { id: 'low', name: 'Thinking: low' },
          { id: 'medium', name: 'Thinking: medium' },
        ],
        currentModeId: 'medium',
      },
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'openrouter/a',
          options: [
            { value: 'openrouter/a', name: 'A' },
            { value: 'openrouter/b', name: 'B' },
          ],
        },
        {
          id: 'thought_level',
          name: 'Thinking',
          category: 'thought_level',
          type: 'select',
          currentValue: 'medium',
          options: [
            { value: 'low', name: 'Thinking: low' },
            { value: 'medium', name: 'Thinking: medium' },
          ],
        },
      ],
    }
  }

  it('routes a codex bracketed model id as base + effort via setConfigOption, never setModel', async () => {
    const { sdk, provider, sessionResponse, streamText } = fakeSdk([])
    Object.assign(sessionResponse, codexSession())
    const setModel = vi.fn(async () => ({}))
    const setConfigOption = vi.fn(async () => ({}))
    Object.assign(provider, { setModel, setConfigOption })
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    const events = []
    for await (const event of runtime.run({
      harness: claudeHarness,
      modelId: 'gpt-5.5[low]',
      workspacePath: realWorkspace(),
      prompt: 'p',
    })) {
      events.push(event)
    }

    // provider.setModel validates any id against the base-name config values
    // and throws before any legacy RPC — the seam decomposes the bracketed
    // pick into base model + thinking effort instead.
    expect(setConfigOption).toHaveBeenCalledWith({ sessionId: 'sess_9', configId: 'model', value: 'gpt-5.5' })
    expect(setConfigOption).toHaveBeenCalledWith({ sessionId: 'sess_9', configId: 'reasoning_effort', value: 'low' })
    expect(setModel).not.toHaveBeenCalled()
    expect(provider.languageModel).toHaveBeenCalledWith('gpt-5.5', undefined)
    expect(streamText).toHaveBeenCalledOnce()
    expect(events[0]).toEqual({ kind: 'status', state: 'starting' })
  })

  it('skips both writes when the bracketed pick already matches base + effort current', async () => {
    const { sdk, provider, sessionResponse, streamText } = fakeSdk([])
    Object.assign(sessionResponse, codexSession())
    const setModel = vi.fn(async () => ({}))
    const setConfigOption = vi.fn(async () => ({}))
    Object.assign(provider, { setModel, setConfigOption })
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    const events = []
    for await (const event of runtime.run({
      harness: claudeHarness,
      modelId: 'gpt-5.6-luna[high]',
      workspacePath: realWorkspace(),
      prompt: 'p',
    })) {
      events.push(event)
    }

    // Base 'gpt-5.6-luna' is the config current and effort 'high' is the
    // reasoning_effort current — fully idempotent, yet the constructor still
    // takes the base (this is the `[high]`-works case from the live report).
    expect(setConfigOption).not.toHaveBeenCalled()
    expect(setModel).not.toHaveBeenCalled()
    expect(provider.languageModel).toHaveBeenCalledWith('gpt-5.6-luna', undefined)
    expect(streamText).toHaveBeenCalledOnce()
    expect(events).not.toContainEqual(expect.objectContaining({ kind: 'error' }))
  })

  it('applies the base when the bracket suffix matches no advertised effort', async () => {
    const { sdk, provider, sessionResponse, streamText } = fakeSdk([])
    Object.assign(sessionResponse, codexSession())
    const setModel = vi.fn(async () => ({}))
    const setConfigOption = vi.fn(async () => ({}))
    Object.assign(provider, { setModel, setConfigOption })
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    const events = []
    for await (const event of runtime.run({
      harness: claudeHarness,
      modelId: 'gpt-5.5[ultra]',
      workspacePath: realWorkspace(),
      prompt: 'p',
    })) {
      events.push(event)
    }

    // Unknown effort degrades to the base model instead of failing the run.
    expect(setConfigOption).toHaveBeenCalledOnce()
    expect(setConfigOption).toHaveBeenCalledWith({ sessionId: 'sess_9', configId: 'model', value: 'gpt-5.5' })
    expect(setModel).not.toHaveBeenCalled()
    expect(streamText).toHaveBeenCalledOnce()
    expect(events).not.toContainEqual(expect.objectContaining({ kind: 'error' }))
  })

  it('routes a codex mode via legacy setMode, never setConfigOption', async () => {
    const { sdk, provider, sessionResponse, streamText } = fakeSdk([])
    Object.assign(sessionResponse, codexSession())
    const setMode = vi.fn(async () => ({}))
    const setConfigOption = vi.fn(async () => ({}))
    Object.assign(provider, { setMode, setConfigOption })
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    for await (const _event of runtime.run({
      harness: claudeHarness,
      modeId: 'read-only',
      workspacePath: realWorkspace(),
      prompt: 'p',
    })) {
      // no-op
    }

    expect(setMode).toHaveBeenCalledWith('read-only')
    expect(setConfigOption).not.toHaveBeenCalled()
    expect(streamText).toHaveBeenCalledOnce()
  })

  it('routes a pi model via setConfigOption, never legacy setModel', async () => {
    const { sdk, provider, sessionResponse, streamText } = fakeSdk([])
    Object.assign(sessionResponse, piSession())
    const setModel = vi.fn(async () => ({}))
    const setConfigOption = vi.fn(async () => ({}))
    Object.assign(provider, { setModel, setConfigOption })
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    for await (const _event of runtime.run({
      harness: claudeHarness,
      modelId: 'openrouter/b',
      workspacePath: realWorkspace(),
      prompt: 'p',
    })) {
      // no-op
    }

    expect(setConfigOption).toHaveBeenCalledWith({ sessionId: 'sess_9', configId: 'model', value: 'openrouter/b' })
    expect(setModel).not.toHaveBeenCalled()
    expect(streamText).toHaveBeenCalledOnce()
  })

  it('routes a pi thinking mode via legacy setMode, never config `mode`', async () => {
    const { sdk, provider, sessionResponse, streamText } = fakeSdk([])
    Object.assign(sessionResponse, piSession())
    const setMode = vi.fn(async () => ({}))
    const setConfigOption = vi.fn(async () => ({}))
    Object.assign(provider, { setMode, setConfigOption })
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    for await (const _event of runtime.run({
      harness: claudeHarness,
      modeId: 'low',
      workspacePath: realWorkspace(),
      prompt: 'p',
    })) {
      // no-op
    }

    expect(setMode).toHaveBeenCalledWith('low')
    expect(setConfigOption).not.toHaveBeenCalled()
    expect(streamText).toHaveBeenCalledOnce()
  })

  it('skips the write when the pick already equals the live current (idempotent)', async () => {
    const { sdk, provider, sessionResponse, streamText } = fakeSdk([])
    Object.assign(sessionResponse, piSession())
    const setMode = vi.fn(async () => ({}))
    const setConfigOption = vi.fn(async () => ({}))
    Object.assign(provider, { setMode, setConfigOption })
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    for await (const _event of runtime.run({
      harness: claudeHarness,
      modeId: 'medium',
      workspacePath: realWorkspace(),
      prompt: 'p',
    })) {
      // no-op
    }

    expect(setMode).not.toHaveBeenCalled()
    expect(setConfigOption).not.toHaveBeenCalled()
    expect(streamText).toHaveBeenCalledOnce()
  })

  it('falls back to legacy setModel when the resumed-session config write fails (codex)', async () => {
    const { sdk, provider, streamText } = fakeSdk([])
    const setModel = vi.fn(async () => ({}))
    const setConfigOption = vi.fn(async () => {
      throw new Error('Invalid params')
    })
    Object.assign(provider, { setModel, setConfigOption })
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    const events = []
    for await (const event of runtime.run({
      harness: claudeHarness,
      modelId: 'gpt-5.5[low]',
      workspacePath: realWorkspace(),
      prompt: 'p',
      sessionId: 'sess_prev',
    })) {
      events.push(event)
    }

    expect(setConfigOption).toHaveBeenCalledOnce()
    expect(setModel).toHaveBeenCalledWith('gpt-5.5[low]')
    expect(streamText).toHaveBeenCalledOnce()
    expect(events[0]).toEqual({ kind: 'status', state: 'starting' })
  })

  it('falls back to legacy setMode when the resumed-session config write fails (pi thinking)', async () => {
    const { sdk, provider, streamText } = fakeSdk([])
    const setMode = vi.fn(async () => ({}))
    const setConfigOption = vi.fn(async () => {
      throw new Error('Unknown config option: mode')
    })
    Object.assign(provider, { setMode, setConfigOption })
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    for await (const _event of runtime.run({
      harness: claudeHarness,
      modeId: 'low',
      workspacePath: realWorkspace(),
      prompt: 'p',
      sessionId: 'sess_prev',
    })) {
      // no-op
    }

    expect(setConfigOption).toHaveBeenCalled()
    expect(setMode).toHaveBeenCalledWith('low')
    expect(streamText).toHaveBeenCalledOnce()
  })

  it('migrates a stale bracketed codex pick to its advertised base (new base-only catalog)', async () => {
    const { sdk, provider, sessionResponse, streamText } = fakeSdk([])
    Object.assign(sessionResponse, {
      sessionId: 'sess_9',
      models: {
        availableModels: [
          { modelId: 'gpt-5.6-terra', name: 'GPT-5.6-Terra' },
          { modelId: 'gpt-5.6-luna', name: 'GPT-5.6-Luna' },
          { modelId: 'gpt-5.5', name: 'GPT-5.5' },
        ],
        currentModelId: 'gpt-5.6-luna',
      },
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'gpt-5.6-terra',
          options: [
            { value: 'gpt-5.6-terra', name: 'GPT-5.6-Terra' },
            { value: 'gpt-5.6-luna', name: 'GPT-5.6-Luna' },
            { value: 'gpt-5.5', name: 'GPT-5.5' },
          ],
        },
      ],
    })
    const setModel = vi.fn(async () => ({}))
    const setConfigOption = vi.fn(async () => ({}))
    // The live provider validates the constructed model id like the agent
    // does — a stale bracketed id must never reach it after a successful
    // base apply.
    const languageModel = vi.fn((modelId: string) => {
      if (modelId.includes('['))
        throw new Error(`Model "${modelId}" is not available. Available models: gpt-5.6-terra, gpt-5.6-luna, gpt-5.5`)
      return { providerId: 'acp' }
    })
    Object.assign(provider, { setModel, setConfigOption, languageModel })
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    const events = []
    for await (const event of runtime.run({
      harness: claudeHarness,
      modelId: 'gpt-5.6-luna[low]',
      workspacePath: realWorkspace(),
      prompt: 'p',
    })) {
      events.push(event)
    }

    // The stale bracketed id resolves to its advertised base via the config
    // write instead of failing the run.
    expect(setConfigOption).toHaveBeenCalledWith({ sessionId: 'sess_9', configId: 'model', value: 'gpt-5.6-luna' })
    expect(setModel).not.toHaveBeenCalled()
    expect(languageModel).toHaveBeenCalledWith('gpt-5.6-luna', undefined)
    expect(streamText).toHaveBeenCalledOnce()
    expect(events).not.toContainEqual(expect.objectContaining({ kind: 'error' }))
  })

  it('leaves anthropic-style ids untouched end to end (no bracket = no normalization)', async () => {
    const { sdk, provider, sessionResponse, streamText } = fakeSdk([])
    Object.assign(sessionResponse, {
      sessionId: 'sess_9',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'sonnet',
          options: [
            { value: 'opus', name: 'Opus' },
            { value: 'sonnet', name: 'Sonnet' },
          ],
        },
      ],
    })
    const setModel = vi.fn(async () => ({}))
    const setConfigOption = vi.fn(async () => ({}))
    const languageModel = vi.fn(() => ({ providerId: 'acp' }))
    Object.assign(provider, { setModel, setConfigOption, languageModel })
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    const events = []
    for await (const event of runtime.run({
      harness: claudeHarness,
      modelId: 'opus',
      workspacePath: realWorkspace(),
      prompt: 'p',
    })) {
      events.push(event)
    }

    expect(setConfigOption).toHaveBeenCalledWith({ sessionId: 'sess_9', configId: 'model', value: 'opus' })
    expect(setModel).not.toHaveBeenCalled()
    expect(languageModel).toHaveBeenCalledWith('opus', undefined)
    expect(streamText).toHaveBeenCalledOnce()
    expect(events).not.toContainEqual(expect.objectContaining({ kind: 'error' }))
  })

  it('falls back to the bracket base on a resumed session with no catalog (minimal handshake)', async () => {
    const { sdk, provider, streamText } = fakeSdk([])
    const setModel = vi.fn(async (id: string) => {
      if (id === 'gpt-5.6-luna[low]')
        throw new Error(
          'Model "gpt-5.6-luna[low]" is not available. Available models: gpt-5.6-terra, gpt-5.6-luna, gpt-5.5',
        )
      return {}
    })
    const languageModel = vi.fn((modelId: string) => {
      if (modelId.includes('['))
        throw new Error(`Model "${modelId}" is not available. Available models: gpt-5.6-terra, gpt-5.6-luna, gpt-5.5`)
      return { providerId: 'acp' }
    })
    Object.assign(provider, { setModel, languageModel })
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    const events = []
    for await (const event of runtime.run({
      harness: claudeHarness,
      modelId: 'gpt-5.6-luna[low]',
      workspacePath: realWorkspace(),
      prompt: 'p',
      sessionId: 'sess_prev',
    })) {
      events.push(event)
    }

    expect(setModel).toHaveBeenCalledWith('gpt-5.6-luna[low]')
    expect(setModel).toHaveBeenLastCalledWith('gpt-5.6-luna')
    expect(languageModel).toHaveBeenCalledWith('gpt-5.6-luna', undefined)
    expect(streamText).toHaveBeenCalledOnce()
    expect(events).not.toContainEqual(expect.objectContaining({ kind: 'error' }))
  })
})
