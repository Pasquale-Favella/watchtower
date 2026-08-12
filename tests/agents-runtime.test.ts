import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HarnessInfo } from '../src/main/agents/detect.js'
import type { CoachStreamPart } from '../src/main/agents/events.js'
import { acpSpawnCommand, createHarnessRuntime, type HarnessSdk } from '../src/main/agents/runtime.js'
import { harnessSpecs } from '../src/main/agents/harnesses/index.js'

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
      { kind: 'session', sessionId: 'sess_9' },
      { kind: 'text', delta: 'Hello' },
      { kind: 'tool', tool: 'Bash', state: 'started' },
      { kind: 'status', state: 'done' },
    ])
    expect(createACPProvider).toHaveBeenCalledOnce()
    expect(provider.initSession).toHaveBeenCalledOnce()
    expect(streamText).toHaveBeenCalledOnce()
    const streamCall = streamText.mock.calls[0]![0]
    expect(streamCall.prompt).toBe('List the files')
    expect(streamCall.tools).toBeDefined()
    expect(provider.languageModel).toHaveBeenCalledWith('claude-opus-4-8', undefined)
  })

  it('builds the ACP provider from the harness spec and the real workspace path', async () => {
    const { sdk, createACPProvider } = fakeSdk([])
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })
    const workspace = realWorkspace()

    for await (const _event of runtime.run({ harness: claudeHarness, modelId: 'm', workspacePath: workspace, prompt: 'p' })) {
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

    for await (const _event of runtime.run({ harness: claudeHarness, modelId: 'm', workspacePath: realWorkspace(), prompt: 'p' })) {
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

  it('rides the agent\'s handshake models/modes on the session event (progressive selection)', async () => {
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
    for await (const event of runtime.run({ harness: claudeHarness, modelId: 'm', workspacePath: realWorkspace(), prompt: 'p' })) {
      events.push(event)
    }

    expect(events[1]).toEqual({
      kind: 'session',
      sessionId: 'sess_9',
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

  it('forwards the user\'s modelId and modeId to languageModel()', async () => {
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
      for await (const _event of runtime.run({ harness: claudeHarness, modelId: 'm', workspacePath: 'C:\\nonexistent\\path', prompt: 'p' })) {
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
    for await (const event of runtime.run({ harness: claudeHarness, modelId: 'm', workspacePath: realWorkspace(), prompt: 'p' })) {
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
    for await (const event of runtime.run({ harness: claudeHarness, modelId: 'm', workspacePath: realWorkspace(), prompt: 'p' })) {
      events.push(event)
    }
    expect(events).toEqual([
      { kind: 'status', state: 'starting' },
      { kind: 'session', sessionId: 'sess_9' },
      { kind: 'error', message: 'credential wall' },
    ])
  })

  it('cancelling the run interrupts the SAME SDK iterator and cleans up the provider', async () => {
    const { sdk, provider, streamText } = fakeSdk([
      { type: 'text-delta', text: 'slow text' },
    ])
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    const gen = runtime.run({ harness: claudeHarness, modelId: 'm', workspacePath: realWorkspace(), prompt: 'p' })
    // starting → session, then the first streamed text delta (streamText now live).
    expect((await gen.next()).value).toEqual({ kind: 'status', state: 'starting' })
    expect((await gen.next()).value).toEqual({ kind: 'session', sessionId: 'sess_9' })
    expect((await gen.next()).value).toEqual({ kind: 'text', delta: 'slow text' })
    expect(streamText).toHaveBeenCalledOnce()

    // Consumer cancels the outer generator mid-run.
    await gen.return()
    const exhausted = await gen.next()
    expect(exhausted.done).toBe(true)
    expect(provider.cleanup).toHaveBeenCalledOnce()
  })
})

describe('createHarnessRuntime — inspect (the pre-flight handshake probe, map 47 ticket 50)', () => {
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

    // The probed session id rides the result so the runner can resume this
    // warm session on the conversation's first run (no double cold-start).
    expect(result).toEqual({
      sessionId: 'sess_9',
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

  it('returns the session id but no selectable set when the agent declares none', async () => {
    const { sdk } = fakeSdk([])
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    const result = await runtime.inspect({ harness: claudeHarness, workspacePath: realWorkspace() })

    // The session is still warmed and resumable — only the pickers stay
    // absent (progressive: nothing declared).
    expect(result).toEqual({ sessionId: 'sess_9' })
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

    await expect(runtime.inspect({ harness: claudeHarness, workspacePath: realWorkspace() }))
      .rejects.toThrow('agent binary not found')
    expect(provider.cleanup).toHaveBeenCalledOnce()
  })

  it('refuses a workspace path that is not a real on-disk directory', async () => {
    const { sdk, createACPProvider } = fakeSdk([])
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })

    await expect(runtime.inspect({ harness: claudeHarness, workspacePath: 'C:\\nonexistent\\path' }))
      .rejects.toThrow(/real on-disk/i)
    expect(createACPProvider).not.toHaveBeenCalled()
  })
})

describe('createHarnessRuntime — expendable-resume fallback (probe-warmed first run)', () => {
  it('falls back to a FRESH session when an expendable resume fails — nothing is lost', async () => {
    const { sdk, provider, createACPProvider } = fakeSdk([])
    provider.initSession.mockRejectedValueOnce(new Error('loadSession failed'))
    const runtime = createHarnessRuntime(sdk, { platform: 'linux' })
    const mcpServers = [{ name: 'watchtower-ledger', command: 'node', args: ['ledger-mcp.js'] }]

    const events = []
    for await (const event of runtime.run({
      harness: claudeHarness,
      modelId: 'm',
      workspacePath: realWorkspace(),
      prompt: 'p',
      sessionId: 'sess_probe',
      resumeIsExpendable: true,
      mcpServers,
    })) {
      events.push(event)
    }

    // The failed resume restarts the provider WITHOUT the resume handle and
    // the run proceeds on a fresh session.
    expect(events).toEqual([
      { kind: 'status', state: 'starting' },
      { kind: 'session', sessionId: 'sess_9' },
    ])
    expect(createACPProvider).toHaveBeenCalledTimes(2)
    expect(provider.cleanup).toHaveBeenCalledTimes(2)
    const retryConfig = createACPProvider.mock.calls[1]![0]
    expect(retryConfig.existingSessionId).toBeUndefined()
    // The fresh session must still expose the ledger tools — the retry keeps
    // the run's MCP servers (the data-grounding feature depends on it).
    expect(retryConfig.session.mcpServers).toEqual(mcpServers)
  })

  it('surfaces an error when BOTH the expendable resume and its fresh retry fail', async () => {
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
      resumeIsExpendable: true,
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

  it('does NOT fall back for a genuine (non-expendable) resume — its context must not silently vanish', async () => {
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
      { kind: 'error', message: 'loadSession failed' },
    ])
    expect(streamText).not.toHaveBeenCalled()
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
    expect(harnessSpecs.every(s => s.adapter.kind === 'acp'), 'every registered spec is ACP').toBe(true)

    for (const spec of harnessSpecs) {
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
      expect(events[1]).toEqual({ kind: 'session', sessionId: 'sess_9' })
    }
  })
})

describe('acpSpawnCommand — Windows shim handling (ticket: coach runs on win32)', () => {
  it('wraps a bare npm-shim command through cmd.exe /c on win32', () => {
    expect(acpSpawnCommand('opencode', ['acp'], 'win32')).toEqual({ command: 'cmd.exe', args: ['/c', 'opencode', 'acp'] })
    expect(acpSpawnCommand('claude-agent-acp', [], 'win32')).toEqual({ command: 'cmd.exe', args: ['/c', 'claude-agent-acp'] })
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

    for await (const _event of runtime.run({ harness: claudeHarness, modelId: 'm', workspacePath: realWorkspace(), prompt: 'p' })) {
      // no-op
    }

    const config = createACPProvider.mock.calls[0]![0]
    expect(config.command).toBe('cmd.exe')
    expect(config.args).toEqual(['/c', 'claude-agent-acp'])
    expect(config.session.cwd).toBeDefined()
  })

  it('spawns a BUNDLED harness via the app\'s own Node (ELECTRON_RUN_AS_NODE), no cmd shim', async () => {
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

    for await (const _event of runtime.run({ harness: bundledHarness, modelId: 'm', workspacePath: realWorkspace(), prompt: 'p' })) {
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

    for await (const _event of runtime.run({ harness: bundledHarness, modelId: 'm', workspacePath: realWorkspace(), prompt: 'p' })) {
      // no-op
    }

    const config = createACPProvider.mock.calls[0]![0]
    expect(config.command).toBe(process.execPath)
    expect(config.args).toEqual([bundledHarness.bundledEntry, ...(spec.adapter.acpConfig.args ?? [])])
  })
})
