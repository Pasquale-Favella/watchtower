import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HarnessInfo } from '../src/main/agents/detect.js'
import { createHarnessRuntime, type HarnessSdk } from '../src/main/agents/runtime.js'

const claudeHarness: HarnessInfo = {
  name: 'claude',
  kind: 'claude',
  displayName: 'Claude Code',
  bin: 'C:\\bin\\claude.exe',
  models: ['claude-opus-4-8'],
  scrubEnv: ['ANTHROPIC_API_KEY'],
  authStatus: 'unknown',
}

/** A fake SDK whose chat() streams scripted AG-UI chunks. */
function fakeSdk(chunks: Array<Record<string, unknown>>): HarnessSdk & { chat: ReturnType<typeof vi.fn> } {
  const chat = vi.fn(async function* () {
    for (const c of chunks) yield c
  })
  return {
    chat: chat as unknown as HarnessSdk['chat'],
    defineSandbox: vi.fn(() => ({ id: 'sandbox' })),
    defineWorkspace: vi.fn(d => d),
    localProcessSandbox: vi.fn(() => ({ kind: 'local-process' })),
    withSandbox: vi.fn(() => 'withSandbox-middleware'),
    adapters: {
      claude: vi.fn(() => ({ name: 'claude-code' })),
      opencode: vi.fn(() => ({ name: 'opencode' })),
      codex: vi.fn(() => ({ name: 'codex' })),
    },
  } as unknown as HarnessSdk & { chat: ReturnType<typeof vi.fn> }
}

const tempDirs: string[] = []
function realWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'watchtower-agents-'))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('createHarnessRuntime — the seam (system boundary mocked at the SDK)', () => {
  it('runs a harness and derives CoachEvents from the streamed AG-UI chunks', async () => {
    const sdk = fakeSdk([
      { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'Hello' },
      { type: 'TOOL_CALL_START', toolCallId: 'tc1', toolCallName: 'Bash' },
      { type: 'CUSTOM', name: 'claude-code.session-id', value: 'sess_9' },
      { type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' },
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
      { kind: 'text', delta: 'Hello' },
      { kind: 'tool', tool: 'Bash' },
      { kind: 'session', sessionId: 'sess_9' },
      { kind: 'status', state: 'done' },
    ])
    expect(sdk.chat).toHaveBeenCalledOnce()
    const chatCall = sdk.chat.mock.calls[0]![0]
    expect(chatCall.adapter).toEqual({ name: 'claude-code' })
    expect(chatCall.messages[0]).toMatchObject({ role: 'user', content: 'List the files' })
    expect(chatCall.middleware).toContain('withSandbox-middleware')
  })

  it('projects the REAL on-disk workspace path into the sandbox workspace', async () => {
    const sdk = fakeSdk([])
    const runtime = createHarnessRuntime(sdk)
    const workspace = realWorkspace()

    const events = []
    for await (const event of runtime.run({ harness: claudeHarness, model: 'm', workspacePath: workspace, prompt: 'p' })) {
      events.push(event)
    }
    expect(events).toEqual([])

    expect(sdk.defineWorkspace).toHaveBeenCalledWith({ source: { type: 'local', path: workspace } })
    expect(sdk.localProcessSandbox).toHaveBeenCalledWith({ scrubEnv: ['ANTHROPIC_API_KEY'] })
  })

  it('refuses a workspace path that is not a real on-disk directory', async () => {
    const sdk = fakeSdk([])
    const runtime = createHarnessRuntime(sdk)

    await expect(async () => {
      for await (const _event of runtime.run({ harness: claudeHarness, model: 'm', workspacePath: 'C:\\nonexistent\\path', prompt: 'p' })) {
        // no-op
      }
    }).rejects.toThrow(/real on-disk/i)
    expect(sdk.chat).not.toHaveBeenCalled()
  })

  it('propagates a stream error as an error outcome without crashing the loop', async () => {
    const sdk = fakeSdk([{ type: 'RUN_ERROR', message: 'credential wall' }])
    const runtime = createHarnessRuntime(sdk)

    const events = []
    for await (const event of runtime.run({ harness: claudeHarness, model: 'm', workspacePath: realWorkspace(), prompt: 'p' })) {
      events.push(event)
    }
    expect(events).toEqual([{ kind: 'error', message: 'credential wall' }])
  })

  it('cancelling the run interrupts the SAME SDK iterator that the loop consumes', async () => {
    const sdk = fakeSdk([
      { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'slow text' },
    ])
    const runtime = createHarnessRuntime(sdk)

    const gen = runtime.run({ harness: claudeHarness, model: 'm', workspacePath: realWorkspace(), prompt: 'p' })
    const first = await gen.next()
    expect(first.value).toEqual({ kind: 'status', state: 'starting' })

    // Consumer cancels the outer generator mid-run.
    await gen.return()
    const exhausted = await gen.next()
    expect(exhausted.done).toBe(true)
  })
})
