import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HarnessInfo } from '../src/main/agents/detect.js'
import type { CoachStreamPart } from '../src/main/agents/events.js'
import { createHarnessRuntime, type HarnessSdk } from '../src/main/agents/runtime.js'
import { harnessSpecs } from '../src/main/agents/harnesses/index.js'

const claudeHarness: HarnessInfo = {
  name: 'claude',
  kind: 'claude',
  displayName: 'Claude Code',
  bin: 'C:\\bin\\claude-agent-acp.exe',
  models: ['claude-opus-4-8'],
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
  streamText: ReturnType<typeof vi.fn>
  createACPProvider: ReturnType<typeof vi.fn>
} {
  const provider = {
    languageModel: vi.fn(() => ({ providerId: 'acp' })),
    tools: { 'acp.acp_provider_agent_dynamic_tool': {} },
    initSession: vi.fn(async () => ({ sessionId: 'sess_9' })),
    getSessionId: vi.fn(() => 'sess_9'),
    cleanup: vi.fn(),
  }
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
    const runtime = createHarnessRuntime(sdk)

    const events = []
    for await (const event of runtime.run({
      harness: claudeHarness,
      model: 'claude-opus-4-8',
      workspacePath: realWorkspace(),
      prompt: 'List the files',
    })) {
      events.push(event)
    }

    expect(events).toEqual([
      { kind: 'status', state: 'starting' },
      { kind: 'session', sessionId: 'sess_9' },
      { kind: 'text', delta: 'Hello' },
      { kind: 'tool', tool: 'Bash' },
      { kind: 'status', state: 'done' },
    ])
    expect(createACPProvider).toHaveBeenCalledOnce()
    expect(provider.initSession).toHaveBeenCalledOnce()
    expect(streamText).toHaveBeenCalledOnce()
    const streamCall = streamText.mock.calls[0]![0]
    expect(streamCall.prompt).toBe('List the files')
    expect(streamCall.tools).toBeDefined()
    expect(provider.languageModel).toHaveBeenCalledWith('claude-opus-4-8')
  })

  it('builds the ACP provider from the harness spec and the real workspace path', async () => {
    const { sdk, createACPProvider } = fakeSdk([])
    const runtime = createHarnessRuntime(sdk)
    const workspace = realWorkspace()

    for await (const _event of runtime.run({ harness: claudeHarness, model: 'm', workspacePath: workspace, prompt: 'p' })) {
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
    const runtime = createHarnessRuntime(sdk)

    for await (const _event of runtime.run({ harness: claudeHarness, model: 'm', workspacePath: realWorkspace(), prompt: 'p' })) {
      // no-op
    }

    const env = createACPProvider.mock.calls[0]![0].env as Record<string, string>
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.PATH).toBe('C:\\bin')
  })

  it('passes the resume session id as existingSessionId on the provider', async () => {
    const { sdk, createACPProvider } = fakeSdk([])
    const runtime = createHarnessRuntime(sdk)

    for await (const _event of runtime.run({
      harness: claudeHarness,
      model: 'm',
      workspacePath: realWorkspace(),
      prompt: 'p',
      sessionId: 'sess_prev',
    })) {
      // no-op
    }

    expect(createACPProvider.mock.calls[0]![0].existingSessionId).toBe('sess_prev')
  })

  it('refuses a workspace path that is not a real on-disk directory', async () => {
    const { sdk, createACPProvider } = fakeSdk([])
    const runtime = createHarnessRuntime(sdk)

    await expect(async () => {
      for await (const _event of runtime.run({ harness: claudeHarness, model: 'm', workspacePath: 'C:\\nonexistent\\path', prompt: 'p' })) {
        // no-op
      }
    }).rejects.toThrow(/real on-disk/i)
    expect(createACPProvider).not.toHaveBeenCalled()
  })

  it('refuses a harness kind that has no ACP adapter in the registry', async () => {
    const { sdk, createACPProvider } = fakeSdk([])
    const runtime = createHarnessRuntime(sdk)

    await expect(async () => {
      for await (const _event of runtime.run({
        harness: { ...claudeHarness, kind: 'zerostack', name: 'zerostack' },
        model: 'm',
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
    const runtime = createHarnessRuntime(sdk)

    const events = []
    for await (const event of runtime.run({ harness: claudeHarness, model: 'm', workspacePath: realWorkspace(), prompt: 'p' })) {
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
    const runtime = createHarnessRuntime(sdk)

    const events = []
    for await (const event of runtime.run({ harness: claudeHarness, model: 'm', workspacePath: realWorkspace(), prompt: 'p' })) {
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
    const runtime = createHarnessRuntime(sdk)

    const gen = runtime.run({ harness: claudeHarness, model: 'm', workspacePath: realWorkspace(), prompt: 'p' })
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
      const runtime = createHarnessRuntime(sdk)
      const harness: HarnessInfo = {
        name: spec.kind,
        kind: spec.kind,
        displayName: spec.displayName,
        bin: `C:\\bin\\${spec.adapter.acpConfig.command}.exe`,
        models: spec.fallbackModels ?? [],
        scrubEnv: spec.scrubEnv,
        authStatus: 'unknown',
      }

      const events: unknown[] = []
      for await (const event of runtime.run({ harness, model: 'm', workspacePath: workspace, prompt: 'p' })) {
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
