import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createCoachRunner,
  type CoachRunner,
  type HarnessSource,
  type LedgerMcpAttachment,
} from '../src/main/agents/ipc.js'
import { closeOperationalLog, initOperationalLog } from '../src/main/operational-log.js'
import type { HarnessInfo } from '../src/main/agents/detect.js'
import type { AcpMcpServer } from '../src/main/agents/harnesses/types.js'
import type { HarnessRuntime } from '../src/main/agents/runtime.js'
import { encodeResumeCursor } from '../src/main/agents/resume-cursor.js'
import type { CoachEvent } from '../src/shared/schemas/agents.js'

/** A fake detect result: one configured claude harness (ADR 0016 shape). */
const harnesses: HarnessInfo[] = [
  {
    name: 'claude',
    kind: 'claude',
    displayName: 'Claude Code',
    bin: 'C:\\bin\\claude-agent-acp.exe',
    scrubEnv: ['ANTHROPIC_API_KEY'],
    authStatus: 'configured',
  },
]

const detect = vi.fn(async () => harnesses)

/** Uncached harness source over `detect` — tests swap detection per case. */
const harnessSource: HarnessSource = {
  async list() {
    return (await detect()).map(h => ({
      instanceId: h.instanceId ?? h.kind,
      kind: h.kind,
      displayName: h.displayName,
      status: 'ready' as const,
      auth: { status: 'configured' as const },
      binaryPath: h.bin,
    }))
  },
  async refresh() {
    return harnessSource.list()
  },
  async get(instanceId) {
    const info = (await detect()).find(h => (h.instanceId ?? h.kind) === instanceId)
    return info ? { instanceId, info, status: 'ready', auth: { status: 'configured' } } : undefined
  },
}

/** A fake ledger MCP attachment builder: takes the harness registry key (the
 *  composition root picks the transport per harness) and NO scope — the
 *  server serves the full lifetime ledger and the harness filters via the
 *  tools' `scope` argument (map 53). */
const releaseLedgerMcp = vi.fn()
const ledgerMcpServer = vi.fn(async (_harnessKind: string): Promise<LedgerMcpAttachment | null> => ({
  server: {
    name: 'watchtower-ledger',
    command: 'node',
    args: ['ledger-mcp.js', '--ledger-mcp'],
    env: [{ name: 'WATCHTOWER_LEDGER_MCP', value: JSON.stringify({}) }],
  },
  release: releaseLedgerMcp,
}))

/** A runtime that streams scripted events to completion. */
function scriptedRuntime(events: CoachEvent[]): HarnessRuntime {
  return {
    async *run() {
      for (const event of events) yield event
    },
    async inspect() {
      return {}
    },
  }
}

/** A runtime that streams continuously and records whether its generator's
 *  finally ran — i.e. whether cancel's return() actually reached it. */
function streamingRuntime(): { runtime: HarnessRuntime; interrupted: () => boolean } {
  let interrupted = false
  const runtime: HarnessRuntime = {
    async *run() {
      try {
        let i = 0
        yield { kind: 'status', state: 'starting' }
        while (true) {
          await new Promise(resolve => setTimeout(resolve, 1))
          yield { kind: 'text', delta: `chunk-${i++}` }
        }
      } finally {
        interrupted = true
      }
    },
    async inspect() {
      return {}
    },
  }
  return { runtime, interrupted: () => interrupted }
}

function makeRunner(runtime: HarnessRuntime): CoachRunner {
  return createCoachRunner({ getRuntime: async () => runtime, harnesses: harnessSource, ledgerMcpServer })
}

/** Yields to the event loop so the fire-and-forget stream pump lands. */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

/** Clean up any temp workspace the runner may have left behind. */
afterEach(() => {
  for (const dir of readdirSync(tmpdir())) {
    if (dir.startsWith('watchtower-coach-')) {
      // Same tolerance as the runner's own `deleteWorkspace`
      // (`src/main/agents/ipc.ts`): a wedged ACP child can still hold its temp
      // dir, and an unguarded `rmSync` then fails the hook — taking every test
      // in this file red for a scratch directory nobody is asserting on. A
      // leftover under the OS temp root is harmless and cleaned on reboot;
      // 53 failing tests are not.
      try {
        rmSync(join(tmpdir(), dir), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch {
        /* best effort — see the comment above */
      }
    }
  }
})

/** A valid run request — no workspace path anymore (map 53). */
const request = {
  harnessKind: 'claude',
  modelId: 'claude-opus-4-8',
  prompt: 'Summarise my spend',
}

describe('Coach IPC runner (ticket 21, map 53) — ack, stream, cancel over the seam', () => {
  it('lists detected harnesses as picker rows', async () => {
    const runner = makeRunner(scriptedRuntime([]))
    const rows = await runner.harnesses()
    expect(rows).toEqual([
      {
        instanceId: 'claude',
        kind: 'claude',
        displayName: 'Claude Code',
        status: 'ready',
        auth: { status: 'configured' },
        binaryPath: 'C:\\bin\\claude-agent-acp.exe',
      },
    ])
  })

  it('reports the sign-in state a run proved back to the harness source', async () => {
    const reportAuth = vi.fn()
    const source: HarnessSource = { ...harnessSource, reportAuth }
    const run = async (events: CoachEvent[]): Promise<void> => {
      const runner = createCoachRunner({
        getRuntime: async () => scriptedRuntime(events),
        harnesses: source,
        ledgerMcpServer,
      })
      await runner.start(request, () => {})
      await flush()
    }

    await run([{ kind: 'status', state: 'done' }])
    await vi.waitFor(() => expect(reportAuth).toHaveBeenLastCalledWith('claude', 'configured'))

    await run([
      {
        kind: 'error',
        message: 'Claude Code sign-in required (detail: OAuth session expired and could not be refreshed)',
      },
    ])
    await vi.waitFor(() => expect(reportAuth).toHaveBeenLastCalledWith('claude', 'unauthenticated'))

    reportAuth.mockClear()
    await run([{ kind: 'error', message: 'network down' }])
    expect(reportAuth).not.toHaveBeenCalled()
  })

  it("acks immediately with a runId, then streams the run's events to emit", async () => {
    const runner = makeRunner(
      scriptedRuntime([
        { kind: 'status', state: 'starting' },
        { kind: 'session', sessionId: 'sess_1' },
        { kind: 'text', delta: 'Hello' },
        { kind: 'tool', tool: 'Bash' },
        { kind: 'status', state: 'done' },
      ]),
    )
    const events: Array<{ runId: string; event: CoachEvent }> = []

    const result = await runner.start(request, (runId, event) => {
      events.push({ runId, event })
    })

    expect(result).toEqual({ ok: true, runId: expect.any(String) })
    const runId = (result as { ok: true; runId: string }).runId
    await vi.waitFor(() => expect(events).toHaveLength(5))

    expect(events.map(e => e.event)).toEqual([
      { kind: 'status', state: 'starting' },
      { kind: 'session', sessionId: 'sess_1' },
      { kind: 'text', delta: 'Hello' },
      { kind: 'tool', tool: 'Bash' },
      { kind: 'status', state: 'done' },
    ])
    expect(events.every(e => e.runId === runId)).toBe(true)
  })

  it('runs the harness in a real temp workspace under the OS temp dir (map 53)', async () => {
    const run = vi.fn(async function* () {
      /* no-op */
    })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    await runner.start(request, () => {})

    const input = run.mock.calls[0]?.[0] as { workspacePath: string }
    expect(input.workspacePath).toMatch(/[\\/]watchtower-coach-[^\\/]+$/)
    expect(input.workspacePath).toContain(tmpdir())
    expect(existsSync(input.workspacePath)).toBe(true)
  })

  it('injects the in-app ledger MCP server into the run — scope-free, serving the full lifetime ledger', async () => {
    const run = vi.fn(async function* () {
      /* no-op */
    })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    await runner.start({ ...request, scope: { period: '30days', provider: 'claude' } }, () => {})

    expect(ledgerMcpServer).toHaveBeenCalledWith('claude')
    const input = run.mock.calls[0]?.[0] as { mcpServers: AcpMcpServer[] }
    expect(input.mcpServers).toHaveLength(1)
    expect(input.mcpServers[0]!.name).toBe('watchtower-ledger')
  })

  it('prepends the MCP briefing to the FIRST coach run — naming the tools and the suggested window', async () => {
    const run = vi.fn(async function* () {
      /* no-op */
    })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    await runner.start({ ...request, scope: { period: '30days', provider: 'claude' } }, () => {})

    const input = run.mock.calls[0]?.[0] as { prompt: string }
    expect(input.prompt).toContain('watchtower-ledger')
    expect(input.prompt).toContain('ledger_scope')
    expect(input.prompt).toContain('ledger_overview')
    expect(input.prompt).toContain('ledger_sessions')
    expect(input.prompt).toContain('ledger_models')
    expect(input.prompt).toContain('ledger_skills')
    expect(input.prompt).toContain('ledger_calls')
    // The data window caption matches the UI's: period · provider.
    expect(input.prompt).toContain('Last 30 days · claude')
    // The user's own question survives, clearly delimited.
    expect(input.prompt).toContain("The user's question:\nSummarise my spend")
  })

  it('does NOT restate the briefing on a resumed turn with the same scope', async () => {
    const run = vi.fn(async function* () {
      /* no-op */
    })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    const scope = { period: '30days', provider: 'claude' as const }
    await runner.start({ ...request, scope }, () => {})
    await runner.start(
      { ...request, scope, resumeCursor: encodeResumeCursor({ instanceId: 'claude', sessionId: 'sess_prev' }) },
      () => {},
    )

    const input = run.mock.calls[1]?.[0] as { prompt: string }
    expect(input.prompt).toBe('Summarise my spend')
  })

  it('rebriefs a resumed turn when its scope differs from the last briefing', async () => {
    const run = vi.fn(async function* () {
      /* no-op */
    })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    await runner.start({ ...request, scope: { period: '30days', provider: 'claude' } }, () => {})
    await runner.start(
      {
        ...request,
        scope: { period: 'today', provider: 'claude' },
        resumeCursor: encodeResumeCursor({ instanceId: 'claude', sessionId: 'sess_prev' }),
      },
      () => {},
    )

    const input = run.mock.calls[1]?.[0] as { prompt: string }
    expect(input.prompt).toContain('The user has switched their view to Today · claude')
    expect(input.prompt).toContain("The user's question:\nSummarise my spend")
    expect(input.prompt).not.toContain('watchtower-ledger')
  })

  it('emits a notice before a fresh full-briefing run when the resume cursor is invalid', async () => {
    const run = vi.fn(async function* () {
      yield { kind: 'status', state: 'done' }
    })
    const events: CoachEvent[] = []
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    await runner.start({ ...request, resumeCursor: 'not-a-valid-cursor' }, (_runId, event) => {
      events.push(event)
    })
    await vi.waitFor(() => expect(events).toHaveLength(2))

    expect(events[0]).toEqual({
      kind: 'notice',
      message: 'The previous session could not be restored — continuing in a fresh session.',
    })
    expect((run.mock.calls[0]?.[0] as { sessionId?: string; prompt: string }).sessionId).toBeUndefined()
    expect((run.mock.calls[0]?.[0] as { prompt: string }).prompt).toContain('watchtower-ledger')
  })

  it('runs with NO data tools and NO briefing when the ledger source returns null (fresh install, no ledger.db yet)', async () => {
    ledgerMcpServer.mockResolvedValueOnce(null)
    const run = vi.fn(async function* () {
      /* no-op */
    })
    const events: CoachEvent[] = []
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    await runner.start({ ...request, scope: { period: '30days', provider: 'claude' } }, (_runId, event) => {
      events.push(event)
    })
    await vi.waitFor(() => expect(events).toHaveLength(1))

    const input = run.mock.calls[0]?.[0] as { mcpServers: AcpMcpServer[]; prompt: string }
    expect(input.mcpServers).toHaveLength(0)
    // Claiming tools that do not exist would make the agent hallucinate calls.
    expect(input.prompt).toBe('Summarise my spend')
    expect(events[0]).toEqual({
      kind: 'notice',
      message: 'Ledger data is not available yet (no scan found) — answers will not be grounded in your usage data.',
    })
  })

  it('injects the ledger MCP server with NO scope when the request carries none (lifetime serving)', async () => {
    const run = vi.fn(async function* () {
      /* no-op */
    })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    await runner.start(request, () => {})

    expect(ledgerMcpServer).toHaveBeenCalledWith('claude')
  })

  it('releases the ledger attachment when the run stream settles (app-level sidecar release is a no-op)', async () => {
    releaseLedgerMcp.mockClear()
    const runner = makeRunner(scriptedRuntime([{ kind: 'status', state: 'done' }]))

    await runner.start(request, () => {})

    await vi.waitFor(() => expect(releaseLedgerMcp).toHaveBeenCalledTimes(1))
  })

  it('releases the ledger attachment when the run fails to launch (no stream to settle it)', async () => {
    releaseLedgerMcp.mockClear()
    const runner = createCoachRunner({
      getRuntime: async () => {
        throw new Error('no sdk')
      },
      harnesses: harnessSource,
      ledgerMcpServer,
    })

    const result = await runner.start(request, () => {})

    expect(result.ok).toBe(false)
    expect(releaseLedgerMcp).toHaveBeenCalledTimes(1)
  })

  it('degrades to NO data tools and NO briefing when attachment acquisition throws (sidecar failed to boot)', async () => {
    ledgerMcpServer.mockRejectedValueOnce(new Error('spawn failed'))
    const run = vi.fn(async function* () {
      /* no-op */
    })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    await runner.start(request, () => {})

    const input = run.mock.calls[0]?.[0] as { mcpServers: AcpMcpServer[]; prompt: string }
    expect(input.mcpServers).toHaveLength(0)
    expect(input.prompt).toBe('Summarise my spend')
  })

  it('forwards the decoded resume session id AND reuses the same temp workspace', async () => {
    const run = vi.fn(async function* () {
      /* no-op */
    })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    await runner.start(
      { ...request, resumeCursor: encodeResumeCursor({ instanceId: 'claude', sessionId: 'sess_prev' }) },
      () => {},
    )
    const firstPath = (run.mock.calls[0]![0] as { workspacePath: string }).workspacePath
    await runner.start(
      { ...request, resumeCursor: encodeResumeCursor({ instanceId: 'claude', sessionId: 'sess_prev' }) },
      () => {},
    )
    const secondPath = (run.mock.calls[1]![0] as { workspacePath: string }).workspacePath

    expect(firstPath).toBe(secondPath)
    expect((run.mock.calls[0]![0] as { sessionId: string }).sessionId).toBe('sess_prev')
  })

  it('a session-less run REUSES the conversation workspace instead of deleting it', async () => {
    const run = vi.fn(async function* () {
      /* no-op */
    })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    await runner.start(request, () => {})
    const firstPath = (run.mock.calls[0]![0] as { workspacePath: string }).workspacePath
    expect(existsSync(firstPath)).toBe(true)

    // A second session-less run must NOT delete the conversation's cwd while
    // a live ACP session may still hold it.
    await runner.start(request, () => {})
    const secondPath = (run.mock.calls[1]![0] as { workspacePath: string }).workspacePath

    expect(secondPath).toBe(firstPath)
    expect(existsSync(firstPath)).toBe(true)
  })

  it('reset cancels active runs and deletes the conversation temp workspace', async () => {
    // Whatever is already under the temp root belongs to some other process and
    // is none of this test's business. Snapshot it before the run so the
    // post-reset check can scope itself to the dir this run creates.
    const preExisting = new Set(readdirSync(tmpdir()).filter(d => d.startsWith('watchtower-coach-')))
    const { runtime, interrupted } = streamingRuntime()
    const runner = makeRunner(runtime)
    const events: CoachEvent[] = []

    const result = await runner.start(request, (_runId, event) => {
      events.push(event)
    })
    const runId = (result as { ok: true; runId: string }).runId
    await vi.waitFor(() => expect(events.some(e => e.kind === 'text')).toBe(true))

    const workspaceBefore = readdirSync(tmpdir()).filter(d => d.startsWith('watchtower-coach-'))
    expect(workspaceBefore.some(d => !preExisting.has(d))).toBe(true)

    // reset AWAITS the run's teardown (the generator's finally) before
    // deleting the workspace — the delete must never race a live child.
    await runner.reset()

    expect(interrupted()).toBe(true)
    // Scoped to the workspace THIS run created. Asserting the whole temp root
    // came back empty couples this test to every other process on the machine:
    // a single locked `watchtower-coach-*` dir left by an unrelated run took
    // all 53 tests in this file red (2026-09-30). `reset()`'s contract is "it
    // deletes its own workspace", and that is what this checks.
    const survivors = readdirSync(tmpdir()).filter(d => d.startsWith('watchtower-coach-') && !preExisting.has(d))
    expect(survivors).toEqual([])
    void runId
  })

  it('after reset, the next run starts a brand-new conversation workspace', async () => {
    const run = vi.fn(async function* () {
      /* no-op */
    })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    await runner.start(request, () => {})
    const firstPath = (run.mock.calls[0]![0] as { workspacePath: string }).workspacePath

    await runner.reset()

    await runner.start(request, () => {})
    const secondPath = (run.mock.calls[1]![0] as { workspacePath: string }).workspacePath

    expect(firstPath).not.toBe(secondPath)
    expect(existsSync(firstPath)).toBe(false)
    expect(existsSync(secondPath)).toBe(true)
  })

  it('rejects a harness kind that detection did not find', async () => {
    const run = vi.fn(async function* () {
      /* no-op */
    })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    const result = await runner.start({ ...request, harnessKind: 'ghost' }, () => {})

    expect(result).toEqual({ ok: false, error: 'harness not detected: ghost' })
    expect(run).not.toHaveBeenCalled()
  })

  it('forwards modelId and modeId into the runtime run input (progressive selection)', async () => {
    const run = vi.fn(async function* () {
      /* no-op */
    })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    await runner.start({ ...request, modelId: 'sonnet', modeId: 'plan' }, () => {})

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'sonnet', modeId: 'plan' }))
  })

  it('omits modelId/modeId from the run input when the request has none', async () => {
    const run = vi.fn(async function* () {
      /* no-op */
    })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    const { modelId, modeId, ...without } = request
    await runner.start(without, () => {})

    expect(run).toHaveBeenCalledWith(
      expect.not.objectContaining({ modelId: expect.anything(), modeId: expect.anything() }),
    )
  })

  it('forwards the API-key passthrough opt-in into the runtime run input', async () => {
    const run = vi.fn(async function* () {
      /* no-op */
    })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    await runner.start({ ...request, allowApiKeyEnv: true }, () => {})

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ allowApiKeyEnv: true }))
  })

  it('omits allowApiKeyEnv from the run input when the request has none (stored-login default)', async () => {
    const run = vi.fn(async function* () {
      /* no-op */
    })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    await runner.start(request, () => {})

    expect(run).toHaveBeenCalledWith(expect.not.objectContaining({ allowApiKeyEnv: expect.anything() }))
  })

  it('does not resume a probe-warmed session under a different API-key opt-in', async () => {
    const run = vi.fn(async function* () {
      /* no-op */
    })
    const inspect = vi.fn(async () => ({ sessionId: 'sess_warm' }))
    const runner = makeRunner({ run, inspect } as unknown as HarnessRuntime)

    // Probe warms a session WITHOUT the opt-in …
    await runner.inspect('claude')
    // … then the first run opts in: resuming would silently carry the wrong
    // environment, so the run must start fresh.
    await runner.start({ ...request, allowApiKeyEnv: true }, () => {})

    expect(run).toHaveBeenCalledWith(expect.not.objectContaining({ sessionId: expect.anything() }))
  })

  it('does NOT resume a probe-warmed session even when the API-key opt-in matches', async () => {
    const run = vi.fn(async function* () {
      /* no-op */
    })
    const inspect = vi.fn(async () => ({ sessionId: 'sess_warm' }))
    const runner = makeRunner({ run, inspect } as unknown as HarnessRuntime)

    await runner.inspect({ kind: 'claude', allowApiKeyEnv: true })
    await runner.start({ ...request, allowApiKeyEnv: true }, () => {})

    expect(run).toHaveBeenCalledWith(expect.not.objectContaining({ sessionId: expect.anything() }))
  })

  it('rejects a malformed request against the frozen wire schema', async () => {
    const run = vi.fn(async function* () {
      /* no-op */
    })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    const result = await runner.start({ prompt: 'p' }, () => {})

    expect(result).toEqual({ ok: false, error: 'invalid coach run request' })
    expect(run).not.toHaveBeenCalled()
  })

  it('refuses a run without a prompt — before any spawn', async () => {
    const run = vi.fn(async function* () {
      /* no-op */
    })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    const result = await runner.start({ ...request, prompt: '   ' }, () => {})

    expect(result).toEqual({ ok: false, error: 'coach run requires a prompt' })
    expect(run).not.toHaveBeenCalled()
  })

  it('a coach run launches normally and streams its events', async () => {
    const runner = makeRunner(scriptedRuntime([{ kind: 'status', state: 'done' }]))
    const events: CoachEvent[] = []

    const result = await runner.start(request, (_runId, event) => {
      events.push(event)
    })

    expect(result).toEqual({ ok: true, runId: expect.any(String) })
    await vi.waitFor(() => expect(events).toEqual([{ kind: 'status', state: 'done' }]))
  })

  it('cancel interrupts the in-flight run so the stream stops', async () => {
    const { runtime, interrupted } = streamingRuntime()
    const runner = makeRunner(runtime)
    const events: CoachEvent[] = []

    const result = await runner.start(request, (_runId, event) => {
      events.push(event)
    })
    const runId = (result as { ok: true; runId: string }).runId
    // Wait until the stream is definitely live and streaming chunks.
    await vi.waitFor(() => expect(events.some(e => e.kind === 'text')).toBe(true))

    await runner.cancel(runId)
    // Cancel's return() reached the generator: its finally ran, so the pump
    // stops pulling. Once interrupted, the count must be frozen.
    expect(interrupted()).toBe(true)
    const frozen = events.length
    await flush()
    expect(events).toHaveLength(frozen)
  })

  it('coalesces rapid cancellation requests for the same run', async () => {
    const { runtime } = streamingRuntime()
    const runner = makeRunner(runtime)
    const result = await runner.start(request, () => {})
    const runId = (result as { ok: true; runId: string }).runId

    const first = runner.cancel(runId)
    const second = runner.cancel(runId)

    expect(second).toBe(first)
    await Promise.all([first, second])
  })

  it('cancel on an unknown runId is a silent no-op', async () => {
    const runner = makeRunner(scriptedRuntime([]))
    await expect(runner.cancel('does-not-exist')).resolves.toBeUndefined()
  })
})

describe('Coach IPC inspect (map 47 ticket 50) — pre-flight handshake probe for the pickers', () => {
  it('returns the agent-declared models/modes from the runtime probe', async () => {
    const inspect = vi.fn(async () => ({
      models: { availableModels: [{ modelId: 'opus', name: 'Claude Opus' }], currentModelId: 'opus' },
    }))
    const runner = makeRunner({
      run: vi.fn(async function* () {
        /* no-op */
      }),
      inspect,
    } as unknown as HarnessRuntime)

    const result = await runner.inspect('claude')

    expect(result).toEqual({
      ok: true,
      models: { availableModels: [{ modelId: 'opus', name: 'Claude Opus' }], currentModelId: 'opus' },
    })
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ harness: harnesses[0] }))
    expect(inspect.mock.calls[0]?.[0]).toHaveProperty('workspacePath')
  })

  it('accepts the object inspect request and forwards the env flag to the probe', async () => {
    const inspect = vi.fn(async () => ({}))
    const runner = makeRunner({
      run: vi.fn(async function* () {
        /* no-op */
      }),
      inspect,
    } as unknown as HarnessRuntime)

    const result = await runner.inspect({ kind: 'claude', allowApiKeyEnv: true })

    expect(result).toEqual({ ok: true })
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ allowApiKeyEnv: true }))
  })

  it('rejects a malformed inspect request without spawning', async () => {
    const inspect = vi.fn()
    const runner = makeRunner({
      run: vi.fn(async function* () {
        /* no-op */
      }),
      inspect,
    } as unknown as HarnessRuntime)

    const result = await runner.inspect({ kind: '' })

    expect(result).toEqual({ ok: false, error: 'invalid coach inspect request' })
    expect(inspect).not.toHaveBeenCalled()
  })

  it('probes in the conversation workspace (a real dir under the OS temp dir)', async () => {
    const inspect = vi.fn(async () => ({ models: { availableModels: [], currentModelId: '' } }))
    const runner = makeRunner({
      run: vi.fn(async function* () {
        /* no-op */
      }),
      inspect,
    } as unknown as HarnessRuntime)

    const result = await runner.inspect('claude')

    expect(result.ok).toBe(true)
    const input = inspect.mock.calls[0]?.[0] as { workspacePath: string }
    expect(input.workspacePath).toMatch(/[\\/]watchtower-coach-[^\\/]+$/)
    expect(existsSync(input.workspacePath)).toBe(true)
  })

  it('returns an ok:false arm for a harness the detector did not find', async () => {
    const inspect = vi.fn()
    const runner = makeRunner({
      run: vi.fn(async function* () {
        /* no-op */
      }),
      inspect,
    } as unknown as HarnessRuntime)

    const result = await runner.inspect('ghost')

    expect(result).toEqual({ ok: false, error: 'harness not detected: ghost' })
    expect(inspect).not.toHaveBeenCalled()
  })

  it('wraps a runtime probe failure into the ok:false arm (pickers stay absent, chat unaffected)', async () => {
    const inspect = vi.fn(async () => {
      throw new Error('agent binary not found')
    })
    const runner = makeRunner({
      run: vi.fn(async function* () {
        /* no-op */
      }),
      inspect,
    } as unknown as HarnessRuntime)

    const result = await runner.inspect('claude')

    expect(result).toEqual({ ok: false, error: 'agent binary not found' })
  })
})

describe('Coach IPC inspect — probes never create reusable sessions', () => {
  const runProbe = (inspect: ReturnType<typeof vi.fn>): { run: ReturnType<typeof vi.fn>; runner: CoachRunner } => {
    const run = vi.fn(async function* () {
      yield { kind: 'status', state: 'done' }
    })
    return { run, runner: makeRunner({ run, inspect } as unknown as HarnessRuntime) }
  }
  const lastRunInput = (run: ReturnType<typeof vi.fn>, index = 0): { sessionId?: string; prompt: string } =>
    run.mock.calls[index]![0]

  it('the conversation FIRST run starts without a probe session', async () => {
    const { run, runner } = runProbe(
      vi.fn(async () => ({
        sessionId: 'sess_probe',
        models: { availableModels: [{ modelId: 'opus', name: 'Claude Opus' }], currentModelId: 'opus' },
      })),
    )

    await runner.inspect('claude')
    await runner.start(request, () => {})

    expect(lastRunInput(run).sessionId).toBeUndefined()
  })

  it('the first run still gets the ledger briefing after inspect', async () => {
    const { run, runner } = runProbe(vi.fn(async () => ({ sessionId: 'sess_probe' })))

    await runner.inspect('claude')
    await runner.start({ ...request, scope: { period: '30days', provider: 'claude' } }, () => {})

    const input = lastRunInput(run)
    expect(input.prompt).toContain('watchtower-ledger')
  })

  it('successive session-less runs remain session-less', async () => {
    const { run, runner } = runProbe(vi.fn(async () => ({ sessionId: 'sess_probe' })))

    await runner.inspect('claude')
    await runner.start(request, () => {})
    await runner.start(request, () => {})

    expect(lastRunInput(run, 0).sessionId).toBeUndefined()
    expect(lastRunInput(run, 1).sessionId).toBeUndefined()
  })

  it('does not resume a probe-warmed session for a DIFFERENT harness', async () => {
    const codexHarness: HarnessInfo = {
      name: 'codex',
      kind: 'codex',
      displayName: 'Codex',
      bin: 'C:\\bin\\codex.exe',
      scrubEnv: [],
      authStatus: 'configured',
    }
    detect.mockImplementation(async () => [harnesses[0]!, codexHarness])
    const { run, runner } = runProbe(vi.fn(async () => ({ sessionId: 'sess_claude' })))

    await runner.inspect('claude')
    await runner.start({ ...request, harnessKind: 'codex' }, () => {})

    expect(lastRunInput(run).sessionId).toBeUndefined()
    detect.mockImplementation(async () => harnesses)
  })

  it('reset keeps probes from affecting the next conversation', async () => {
    const { run, runner } = runProbe(vi.fn(async () => ({ sessionId: 'sess_probe' })))

    await runner.inspect('claude')
    await runner.reset()
    await runner.start(request, () => {})

    expect(lastRunInput(run).sessionId).toBeUndefined()
  })

  it('a probe that outlives a reset does not affect the next conversation', async () => {
    let resolveProbe!: (value: { sessionId: string }) => void
    const inspect = vi.fn(
      () =>
        new Promise(resolve => {
          resolveProbe = resolve
        }),
    )
    const { run, runner } = runProbe(inspect)

    const pending = runner.inspect('claude')
    void runner.reset() // workspace deleted while the probe is in flight
    await flush() // let the probe reach runtime.inspect before resolving it
    resolveProbe({ sessionId: 'sess_old' })
    await pending

    await runner.start(request, () => {})
    // The stale session belongs to the deleted workspace — never resumed.
    expect(lastRunInput(run).sessionId).toBeUndefined()
  })

  it('always passes freshPrompt for resume recovery', async () => {
    const { run, runner } = runProbe(vi.fn(async () => ({ sessionId: 'sess_probe' })))

    await runner.inspect('claude')
    await runner.start(request, () => {})

    const input = lastRunInput(run) as { sessionId?: string; freshPrompt: string }
    expect(input.sessionId).toBeUndefined()
    expect(input.freshPrompt).toContain('watchtower-ledger')
  })

  it('reset clears the briefed scope before the next resumed run', async () => {
    const run = vi.fn(async function* () {
      /* no-op */
    })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)
    const scope = { period: '30days', provider: 'claude' as const }

    await runner.start({ ...request, scope }, () => {})
    await runner.reset()
    await runner.start(
      {
        ...request,
        scope,
        resumeCursor: encodeResumeCursor({ instanceId: 'claude', sessionId: 'sess_prev' }),
      },
      () => {},
    )

    const input = run.mock.calls[1]?.[0] as { prompt: string }
    expect(input.prompt).toContain('The user has switched their view to Last 30 days · claude')
    expect(input.prompt).toContain("The user's question:\nSummarise my spend")
  })

  it('forwards a genuine resume cursor as a session id without expendable plumbing', async () => {
    const run = vi.fn(async function* () {
      yield { kind: 'status', state: 'done' }
    })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    await runner.start(
      { ...request, resumeCursor: encodeResumeCursor({ instanceId: 'claude', sessionId: 'sess_prev' }) },
      () => {},
    )

    const input = run.mock.calls[0]![0] as { sessionId?: string; resumeIsExpendable?: boolean }
    expect(input.sessionId).toBe('sess_prev')
    expect(input.resumeIsExpendable).toBeUndefined()
  })
})

describe('Coach IPC inspect — probe coalescing (one ACP spawn at a time)', () => {
  const manyHarnesses: HarnessInfo[] = ['claude', 'codex', 'gemini'].map(kind => ({
    name: kind,
    kind,
    displayName: kind,
    bin: `C:\\bin\\${kind}.exe`,
    scrubEnv: [],
    authStatus: 'configured',
  }))

  const trackedRuntime = (): {
    run: ReturnType<typeof vi.fn>
    inspect: ReturnType<typeof vi.fn>
    order: string[]
    maxConcurrent: () => number
  } => {
    let concurrent = 0
    let max = 0
    const order: string[] = []
    const inspect = vi.fn(async ({ harness }: { harness: HarnessInfo }) => {
      concurrent++
      max = Math.max(max, concurrent)
      order.push(harness.kind)
      await new Promise(resolve => setTimeout(resolve, 5))
      concurrent--
      return { sessionId: `sess_${harness.kind}` }
    })
    const run = vi.fn(async function* () {
      yield { kind: 'status', state: 'done' }
    })
    return { run, inspect, order, maxConcurrent: () => max }
  }

  beforeEach(() => {
    detect.mockImplementation(async () => manyHarnesses)
  })
  afterEach(() => {
    detect.mockImplementation(async () => harnesses)
  })

  it('rapid inspect calls run SEQUENTIALLY — never two ACP spawns at once', async () => {
    const { inspect, order, maxConcurrent } = trackedRuntime()
    const runner = makeRunner({
      run: vi.fn(async function* () {
        /* no-op */
      }),
      inspect,
    } as unknown as HarnessRuntime)

    const [claude, codex] = await Promise.all([runner.inspect('claude'), runner.inspect('codex')])

    expect(maxConcurrent()).toBe(1)
    expect(order).toEqual(['claude', 'codex'])
    // Every caller gets a result for ITS requested kind.
    expect(claude.ok).toBe(true)
    expect(codex.ok).toBe(true)
  })

  it('skips an intermediate harness superseded before its spawn', async () => {
    const { inspect, order, maxConcurrent } = trackedRuntime()
    const runner = makeRunner({
      run: vi.fn(async function* () {
        /* no-op */
      }),
      inspect,
    } as unknown as HarnessRuntime)

    const [claude, codex, gemini] = await Promise.all([
      runner.inspect('claude'),
      runner.inspect('codex'),
      runner.inspect('gemini'),
    ])

    expect(maxConcurrent()).toBe(1)
    // codex was queued, then superseded by gemini before its spawn — skipped.
    expect(order).toEqual(['claude', 'gemini'])
    expect(claude.ok).toBe(true)
    expect(codex).toEqual({ ok: false, error: 'superseded' })
    expect(gemini.ok).toBe(true)
  })

  it('a detect failure settles as ok:false and FREES the probe slot (the chain cannot wedge)', async () => {
    detect.mockRejectedValueOnce(new Error('fs boom'))
    const { inspect, order } = trackedRuntime()
    const runner = makeRunner({
      run: vi.fn(async function* () {
        /* no-op */
      }),
      inspect,
    } as unknown as HarnessRuntime)

    const [failed, next] = await Promise.all([runner.inspect('claude'), runner.inspect('codex')])

    // The failed probe resolves (never rejects) and the queued one still runs
    // — had the rejection wedged the slot, `next` would hang forever.
    expect(failed).toEqual({ ok: false, error: 'fs boom' })
    expect(next.ok).toBe(true)
    expect(order).toEqual(['codex'])
  })
})

describe('Ledger MCP config (map 53) — the self-serve stdio server the agent spawns', () => {
  beforeEach(() => {
    ledgerMcpServer.mockClear()
  })

  it('is not spawned by the runner for a harness the detector did not find', async () => {
    const run = vi.fn(async function* () {
      /* no-op */
    })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    await runner.start({ ...request, harnessKind: 'ghost' }, () => {})

    expect(ledgerMcpServer).not.toHaveBeenCalled()
  })
})

describe('Harness lifecycle records (#130) — kind only, never prompts', () => {
  let base = ''

  function tempLogDir(): string {
    base = mkdtempSync(join(tmpdir(), 'watchtower-harness-log-'))
    return join(base, 'logs')
  }

  function readRecords(): Array<Record<string, unknown>> {
    const lines: string[] = []
    for (const file of readdirSync(join(base, 'logs')).filter(f => f.startsWith('operational'))) {
      const text = readFileSync(join(base, 'logs', file), 'utf8')
      lines.push(...text.split('\n').filter(l => l.trim().length > 0))
    }
    return lines.map(line => JSON.parse(line) as Record<string, unknown>)
  }

  beforeEach(async () => {
    await initOperationalLog({ logDir: tempLogDir(), isPackaged: true })
  })

  afterEach(() => {
    try {
      closeOperationalLog()
    } catch {
      /* not initialised */
    }
    if (base) rmSync(base, { recursive: true, force: true })
    base = ''
  })

  it('records harness start and finish by kind, never the prompt', async () => {
    const runner = makeRunner(
      scriptedRuntime([
        { kind: 'status', state: 'starting' },
        { kind: 'status', state: 'done' },
      ]),
    )
    const result = await runner.start(request, () => {})
    expect(result).toEqual({ ok: true, runId: expect.any(String) })
    await vi.waitFor(() => {
      expect(readRecords().filter(r => r['event'] === 'harness.finish')).toHaveLength(1)
    })
    const records = readRecords()
    expect(records.filter(r => r['event'] === 'harness.start')).toHaveLength(1)
    expect(records.find(r => r['event'] === 'harness.start')).toMatchObject({ kind: 'claude' })
    expect(JSON.stringify(records)).not.toContain('Summarise my spend')
  })

  it('records harness errors with kind and code only', async () => {
    const failing: HarnessRuntime = {
      async *run(): AsyncGenerator<CoachEvent> {
        yield { kind: 'status', state: 'starting' }
        throw new Error('boom')
      },
      async inspect() {
        return {}
      },
    }
    const runner = makeRunner(failing)
    const events: CoachEvent[] = []
    const result = await runner.start(request, (_runId, event) => {
      events.push(event)
    })
    expect(result).toEqual({ ok: true, runId: expect.any(String) })
    await vi.waitFor(() => {
      expect(readRecords().filter(r => r['event'] === 'harness.error')).toHaveLength(1)
    })
    expect(events).toContainEqual({ kind: 'error', message: 'boom' })
    const record = readRecords().find(r => r['event'] === 'harness.error')!
    expect(record['kind']).toBe('claude')
    expect(record['code']).toBe('failed')
    expect(JSON.stringify(record)).not.toContain('boom')
  })

  it('records harness cancel instead of finish when the user stops the run', async () => {
    const { runtime } = streamingRuntime()
    const runner = makeRunner(runtime)
    const result = await runner.start(request, () => {})
    const runId = (result as { ok: true; runId: string }).runId
    await flush()
    await runner.cancel(runId)
    await vi.waitFor(() => {
      expect(readRecords().filter(r => r['event'] === 'harness.cancel')).toHaveLength(1)
    })
    expect(readRecords().filter(r => r['event'] === 'harness.finish')).toHaveLength(0)
  })
})
