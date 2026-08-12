import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createCoachRunner, type CoachRunner } from '../src/main/agents/ipc.js'
import type { HarnessInfo } from '../src/main/agents/detect.js'
import type { AcpMcpServer } from '../src/main/agents/harnesses/types.js'
import type { HarnessRuntime } from '../src/main/agents/runtime.js'
import type { CoachEvent } from '../src/shared/schemas/agents.js'
import type { OverviewScope } from '../src/shared/schemas/overview.js'

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

/** A fake ledger MCP config builder: echoes the scope so the test can assert
 *  what the runner baked in (map 53). */
const ledgerMcpServer = vi.fn((scope: OverviewScope): AcpMcpServer => ({
  name: 'watchtower-ledger',
  command: 'node',
  args: ['ledger-mcp.js', '--ledger-mcp'],
  env: [{ name: 'WATCHTOWER_LEDGER_MCP', value: JSON.stringify({ scope }) }],
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
  return createCoachRunner({ getRuntime: async () => runtime, detect, ledgerMcpServer })
}

/** Yields to the event loop so the fire-and-forget stream pump lands. */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

/** Clean up any temp workspace the runner may have left behind. */
afterEach(() => {
  for (const dir of readdirSync(tmpdir())) {
    if (dir.startsWith('watchtower-coach-')) {
      rmSync(join(tmpdir(), dir), { recursive: true, force: true })
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
      { kind: 'claude', displayName: 'Claude Code', authStatus: 'configured' },
    ])
  })

  it('acks immediately with a runId, then streams the run\'s events to emit', async () => {
    const runner = makeRunner(scriptedRuntime([
      { kind: 'status', state: 'starting' },
      { kind: 'session', sessionId: 'sess_1' },
      { kind: 'text', delta: 'Hello' },
      { kind: 'tool', tool: 'Bash' },
      { kind: 'status', state: 'done' },
    ]))
    const events: Array<{ runId: string; event: CoachEvent }> = []

    const result = await runner.start(request, (runId, event) => { events.push({ runId, event }) })

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
    const run = vi.fn(async function* () { /* no-op */ })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    await runner.start(request, () => {})

    const input = run.mock.calls[0]?.[0] as { workspacePath: string }
    expect(input.workspacePath).toMatch(/[\\/]watchtower-coach-[^\\/]+$/)
    expect(input.workspacePath).toContain(tmpdir())
    expect(existsSync(input.workspacePath)).toBe(true)
  })

  it('injects the in-app ledger MCP server into the run, scoped to the request scope', async () => {
    const run = vi.fn(async function* () { /* no-op */ })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    await runner.start({ ...request, scope: { period: '30days', provider: 'claude' } }, () => {})

    expect(ledgerMcpServer).toHaveBeenCalledWith({ period: '30days', provider: 'claude' })
    const input = run.mock.calls[0]?.[0] as { mcpServers: AcpMcpServer[] }
    expect(input.mcpServers).toHaveLength(1)
    expect(input.mcpServers[0]!.name).toBe('watchtower-ledger')
  })

  it('prepends the MCP briefing to the FIRST coach run — naming the tools and the data window', async () => {
    const run = vi.fn(async function* () { /* no-op */ })
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

  it('does NOT restate the briefing on a resumed turn (sessionId present — it is already in context)', async () => {
    const run = vi.fn(async function* () { /* no-op */ })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    await runner.start({ ...request, sessionId: 'sess_prev' }, () => {})

    const input = run.mock.calls[0]?.[0] as { prompt: string }
    expect(input.prompt).toBe('Summarise my spend')
  })

  it('runs with NO data tools and NO briefing when the ledger source returns null (fresh install, no ledger.db yet)', async () => {
    ledgerMcpServer.mockReturnValueOnce(null as unknown as AcpMcpServer)
    const run = vi.fn(async function* () { /* no-op */ })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    await runner.start({ ...request, scope: { period: '30days', provider: 'claude' } }, () => {})

    const input = run.mock.calls[0]?.[0] as { mcpServers: AcpMcpServer[]; prompt: string }
    expect(input.mcpServers).toHaveLength(0)
    // Claiming tools that do not exist would make the agent hallucinate calls.
    expect(input.prompt).toBe('Summarise my spend')
  })

  it('defaults the ledger scope to the widest view when the request carries none', async () => {
    const run = vi.fn(async function* () { /* no-op */ })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    await runner.start(request, () => {})

    expect(ledgerMcpServer).toHaveBeenCalledWith({ period: 'all' })
  })

  it('forwards the resume sessionId AND reuses the same temp workspace for the conversation', async () => {
    const run = vi.fn(async function* () { /* no-op */ })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    await runner.start({ ...request, sessionId: 'sess_prev' }, () => {})
    const firstPath = (run.mock.calls[0]![0] as { workspacePath: string }).workspacePath
    await runner.start({ ...request, sessionId: 'sess_prev' }, () => {})
    const secondPath = (run.mock.calls[1]![0] as { workspacePath: string }).workspacePath

    expect(firstPath).toBe(secondPath)
    expect((run.mock.calls[0]![0] as { sessionId: string }).sessionId).toBe('sess_prev')
  })

  it('a session-less run (build-skill one-shot) REUSES the conversation workspace instead of deleting it', async () => {
    const run = vi.fn(async function* () { /* no-op */ })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    await runner.start(request, () => {})
    const firstPath = (run.mock.calls[0]![0] as { workspacePath: string }).workspacePath
    expect(existsSync(firstPath)).toBe(true)

    // A build-skill run never resumes (no sessionId) — yet it must NOT delete
    // the coach conversation's cwd while a live ACP session may still hold it.
    await runner.start({ ...request, mode: 'build-skill', evidence: {
      source: 'bash',
      name: 'git commit',
      frequency: 6,
      spreadSessions: 2,
      spreadProjects: 1,
      costUSD: 3.5,
      turns: 4,
    } }, () => {})
    const secondPath = (run.mock.calls[1]![0] as { workspacePath: string }).workspacePath

    expect(secondPath).toBe(firstPath)
    expect(existsSync(firstPath)).toBe(true)
  })

  it('reset cancels active runs and deletes the conversation temp workspace', async () => {
    const { runtime, interrupted } = streamingRuntime()
    const runner = makeRunner(runtime)
    const events: CoachEvent[] = []

    const result = await runner.start(request, (_runId, event) => { events.push(event) })
    const runId = (result as { ok: true; runId: string }).runId
    await vi.waitFor(() => expect(events.some(e => e.kind === 'text')).toBe(true))

    const workspaceBefore = readdirSync(tmpdir()).filter(d => d.startsWith('watchtower-coach-'))
    expect(workspaceBefore.length).toBeGreaterThan(0)

    runner.reset()

    await vi.waitFor(() => expect(interrupted()).toBe(true))
    const after = readdirSync(tmpdir()).filter(d => d.startsWith('watchtower-coach-'))
    expect(after).toEqual([])
    void runId
  })

  it('after reset, the next run starts a brand-new conversation workspace', async () => {
    const run = vi.fn(async function* () { /* no-op */ })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    await runner.start(request, () => {})
    const firstPath = (run.mock.calls[0]![0] as { workspacePath: string }).workspacePath

    runner.reset()

    await runner.start(request, () => {})
    const secondPath = (run.mock.calls[1]![0] as { workspacePath: string }).workspacePath

    expect(firstPath).not.toBe(secondPath)
    expect(existsSync(firstPath)).toBe(false)
    expect(existsSync(secondPath)).toBe(true)
  })

  it('rejects a harness kind that detection did not find', async () => {
    const run = vi.fn(async function* () { /* no-op */ })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    const result = await runner.start({ ...request, harnessKind: 'ghost' }, () => {})

    expect(result).toEqual({ ok: false, error: 'harness not detected: ghost' })
    expect(run).not.toHaveBeenCalled()
  })

  it('forwards modelId and modeId into the runtime run input (progressive selection)', async () => {
    const run = vi.fn(async function* () { /* no-op */ })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    await runner.start({ ...request, modelId: 'sonnet', modeId: 'plan' }, () => {})

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'sonnet', modeId: 'plan' }))
  })

  it('omits modelId/modeId from the run input when the request has none', async () => {
    const run = vi.fn(async function* () { /* no-op */ })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    const { modelId, modeId, ...without } = request
    await runner.start(without, () => {})

    expect(run).toHaveBeenCalledWith(expect.not.objectContaining({ modelId: expect.anything(), modeId: expect.anything() }))
  })

  it('rejects a malformed request against the frozen wire schema', async () => {
    const run = vi.fn(async function* () { /* no-op */ })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    const result = await runner.start({ prompt: 'p' }, () => {})

    expect(result).toEqual({ ok: false, error: 'invalid coach run request' })
    expect(run).not.toHaveBeenCalled()
  })

  it('a coach run launches normally and streams its events', async () => {
    const runner = makeRunner(scriptedRuntime([{ kind: 'status', state: 'done' }]))
    const events: CoachEvent[] = []

    const result = await runner.start(request, (_runId, event) => { events.push(event) })

    expect(result).toEqual({ ok: true, runId: expect.any(String) })
    await vi.waitFor(() => expect(events).toEqual([{ kind: 'status', state: 'done' }]))
  })

  it('cancel interrupts the in-flight run so the stream stops', async () => {
    const { runtime, interrupted } = streamingRuntime()
    const runner = makeRunner(runtime)
    const events: CoachEvent[] = []

    const result = await runner.start(request, (_runId, event) => { events.push(event) })
    const runId = (result as { ok: true; runId: string }).runId
    // Wait until the stream is definitely live and streaming chunks.
    await vi.waitFor(() => expect(events.some(e => e.kind === 'text')).toBe(true))

    runner.cancel(runId)
    // Cancel's return() reaches the generator: its finally runs, so the pump
    // stops pulling. Once interrupted, the count must be frozen.
    await vi.waitFor(() => expect(interrupted()).toBe(true))
    const frozen = events.length
    await flush()
    expect(events).toHaveLength(frozen)
  })

  it('cancel on an unknown runId is a silent no-op', async () => {
    const runner = makeRunner(scriptedRuntime([]))
    expect(() => runner.cancel('does-not-exist')).not.toThrow()
  })
})

describe('Coach IPC inspect (map 47 ticket 50) — pre-flight handshake probe for the pickers', () => {
  it('returns the agent-declared models/modes from the runtime probe', async () => {
    const inspect = vi.fn(async () => ({
      models: { availableModels: [{ modelId: 'opus', name: 'Claude Opus' }], currentModelId: 'opus' },
    }))
    const runner = makeRunner({ run: vi.fn(async function* () { /* no-op */ }), inspect } as unknown as HarnessRuntime)

    const result = await runner.inspect('claude')

    expect(result).toEqual({
      ok: true,
      models: { availableModels: [{ modelId: 'opus', name: 'Claude Opus' }], currentModelId: 'opus' },
    })
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ harness: harnesses[0] }))
    expect(inspect.mock.calls[0]?.[0]).toHaveProperty('workspacePath')
  })

  it('probes in the conversation workspace (a real dir under the OS temp dir)', async () => {
    const inspect = vi.fn(async () => ({ models: { availableModels: [], currentModelId: '' } }))
    const runner = makeRunner({ run: vi.fn(async function* () { /* no-op */ }), inspect } as unknown as HarnessRuntime)

    const result = await runner.inspect('claude')

    expect(result.ok).toBe(true)
    const input = inspect.mock.calls[0]?.[0] as { workspacePath: string }
    expect(input.workspacePath).toMatch(/[\\/]watchtower-coach-[^\\/]+$/)
    expect(existsSync(input.workspacePath)).toBe(true)
  })

  it('returns an ok:false arm for a harness the detector did not find', async () => {
    const inspect = vi.fn()
    const runner = makeRunner({ run: vi.fn(async function* () { /* no-op */ }), inspect } as unknown as HarnessRuntime)

    const result = await runner.inspect('ghost')

    expect(result).toEqual({ ok: false, error: 'harness not detected: ghost' })
    expect(inspect).not.toHaveBeenCalled()
  })

  it('wraps a runtime probe failure into the ok:false arm (pickers stay absent, chat unaffected)', async () => {
    const inspect = vi.fn(async () => { throw new Error('agent binary not found') })
    const runner = makeRunner({ run: vi.fn(async function* () { /* no-op */ }), inspect } as unknown as HarnessRuntime)

    const result = await runner.inspect('claude')

    expect(result).toEqual({ ok: false, error: 'agent binary not found' })
  })
})

describe('Coach IPC inspect — probe-warmed session resume (no double cold-start)', () => {
  const runProbe = (inspect: ReturnType<typeof vi.fn>): { run: ReturnType<typeof vi.fn>; runner: CoachRunner } => {
    const run = vi.fn(async function* () { yield { kind: 'status', state: 'done' } })
    return { run, runner: makeRunner({ run, inspect } as unknown as HarnessRuntime) }
  }
  const lastRunInput = (run: ReturnType<typeof vi.fn>, index = 0): { sessionId?: string; prompt: string } => run.mock.calls[index]![0]

  it('the conversation FIRST run resumes the probe-warmed session (existingSessionId)', async () => {
    const { run, runner } = runProbe(vi.fn(async () => ({
      sessionId: 'sess_probe',
      models: { availableModels: [{ modelId: 'opus', name: 'Claude Opus' }], currentModelId: 'opus' },
    })))

    await runner.inspect('claude')
    await runner.start(request, () => {})

    expect(lastRunInput(run).sessionId).toBe('sess_probe')
  })

  it('the resumed probe session still gets the ledger briefing (the probe carried no prompt)', async () => {
    const { run, runner } = runProbe(vi.fn(async () => ({ sessionId: 'sess_probe' })))

    await runner.inspect('claude')
    await runner.start({ ...request, scope: { period: '30days', provider: 'claude' } }, () => {})

    const input = lastRunInput(run)
    expect(input.sessionId).toBe('sess_probe')
    // A resumed session is normally never re-briefed — but this one never saw
    // the ledger briefing (probes send no prompt), so it must be included.
    expect(input.prompt).toContain('watchtower-ledger')
  })

  it('the probe-warmed session is consumed once', async () => {
    const { run, runner } = runProbe(vi.fn(async () => ({ sessionId: 'sess_probe' })))

    await runner.inspect('claude')
    await runner.start(request, () => {})
    await runner.start(request, () => {})

    expect(lastRunInput(run, 0).sessionId).toBe('sess_probe')
    expect(lastRunInput(run, 1).sessionId).toBeUndefined()
  })

  it('does not resume a probe-warmed session for a DIFFERENT harness', async () => {
    const codexHarness: HarnessInfo = {
      name: 'codex', kind: 'codex', displayName: 'Codex',
      bin: 'C:\\bin\\codex.exe', scrubEnv: [], authStatus: 'configured',
    }
    detect.mockImplementation(async () => [harnesses[0]!, codexHarness])
    const { run, runner } = runProbe(vi.fn(async () => ({ sessionId: 'sess_claude' })))

    await runner.inspect('claude')
    await runner.start({ ...request, harnessKind: 'codex' }, () => {})

    expect(lastRunInput(run).sessionId).toBeUndefined()
    detect.mockImplementation(async () => harnesses)
  })

  it('reset clears the probe-warmed session', async () => {
    const { run, runner } = runProbe(vi.fn(async () => ({ sessionId: 'sess_probe' })))

    await runner.inspect('claude')
    runner.reset()
    await runner.start(request, () => {})

    expect(lastRunInput(run).sessionId).toBeUndefined()
  })

  it('a probe that outlives a reset does not leak into the next conversation', async () => {
    let resolveProbe!: (value: { sessionId: string }) => void
    const inspect = vi.fn(() => new Promise(resolve => { resolveProbe = resolve }))
    const { run, runner } = runProbe(inspect)

    const pending = runner.inspect('claude')
    runner.reset() // workspace deleted while the probe is in flight
    await flush() // let the probe reach runtime.inspect before resolving it
    resolveProbe({ sessionId: 'sess_old' })
    await pending

    await runner.start(request, () => {})
    // The stale session belongs to the deleted workspace — never resumed.
    expect(lastRunInput(run).sessionId).toBeUndefined()
  })

  it('flags the probe-warmed resume as EXPENDABLE so the seam can restart fresh on failure', async () => {
    const { run, runner } = runProbe(vi.fn(async () => ({ sessionId: 'sess_probe' })))

    await runner.inspect('claude')
    await runner.start(request, () => {})

    const input = lastRunInput(run) as { sessionId?: string; resumeIsExpendable?: boolean }
    expect(input.sessionId).toBe('sess_probe')
    expect(input.resumeIsExpendable).toBe(true)
  })

  it('does NOT flag genuine conversation resumes as expendable', async () => {
    const run = vi.fn(async function* () { yield { kind: 'status', state: 'done' } })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    await runner.start({ ...request, sessionId: 'sess_prev' }, () => {})

    const input = run.mock.calls[0]![0] as { resumeIsExpendable?: boolean }
    expect(input.resumeIsExpendable).toBe(false)
  })
})

describe('Coach IPC inspect — probe coalescing (one ACP spawn at a time)', () => {
  const manyHarnesses: HarnessInfo[] = ['claude', 'codex', 'gemini'].map(kind => ({
    name: kind, kind, displayName: kind,
    bin: `C:\\bin\\${kind}.exe`, scrubEnv: [], authStatus: 'configured',
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
    const run = vi.fn(async function* () { yield { kind: 'status', state: 'done' } })
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
    const runner = makeRunner({ run: vi.fn(async function* () { /* no-op */ }), inspect } as unknown as HarnessRuntime)

    const [claude, codex] = await Promise.all([runner.inspect('claude'), runner.inspect('codex')])

    expect(maxConcurrent()).toBe(1)
    expect(order).toEqual(['claude', 'codex'])
    // Every caller gets a result for ITS requested kind.
    expect(claude.ok).toBe(true)
    expect(codex.ok).toBe(true)
  })

  it('skips an intermediate harness superseded before its spawn', async () => {
    const { inspect, order, maxConcurrent } = trackedRuntime()
    const runner = makeRunner({ run: vi.fn(async function* () { /* no-op */ }), inspect } as unknown as HarnessRuntime)

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
    const runner = makeRunner({ run: vi.fn(async function* () { /* no-op */ }), inspect } as unknown as HarnessRuntime)

    const [failed, next] = await Promise.all([runner.inspect('claude'), runner.inspect('codex')])

    // The failed probe resolves (never rejects) and the queued one still runs
    // — had the rejection wedged the slot, `next` would hang forever.
    expect(failed).toEqual({ ok: false, error: 'fs boom' })
    expect(next.ok).toBe(true)
    expect(order).toEqual(['codex'])
  })
})

describe('Mode-tagged runs (ADR 0017) — build-skill prose through coach:run', () => {
  const evidence = {
    source: 'bash' as const,
    name: 'git commit',
    frequency: 6,
    spreadSessions: 2,
    spreadProjects: 1,
    costUSD: 3.5,
    turns: 4,
  }

  it('builds the authoring prompt main-side from the NORMALIZED evidence — never renderer text', async () => {
    const run = vi.fn(async function* () {
      yield { kind: 'status', state: 'done' }
    })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    const result = await runner.start({ ...request, mode: 'build-skill', evidence }, () => {})

    expect(result).toEqual({ ok: true, runId: expect.any(String) })
    const input = run.mock.calls[0]?.[0] as { prompt: string }
    // The prompt mentions ONLY normalized facts — never a raw command or
    // transcript, and never the renderer's request body.
    expect(input.prompt).toContain('Pattern: git commit')
    expect(input.prompt).toContain('Frequency: 6 occurrences')
    expect(input.prompt).toContain('Source: bash')
    expect(input.prompt).toContain('SKILL.md')
    // MCP-aware (ADR 0020): the authoring agent is told it can ground the
    // draft in the user's real usage data through the ledger tools.
    expect(input.prompt).toContain('watchtower-ledger')
    expect(input.prompt).toContain('ledger_skills')
    expect(input.prompt).toContain('ledger_calls')
  })

  it('refuses a build-skill run without evidence — before any spawn', async () => {
    const run = vi.fn(async function* () { /* no-op */ })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    const result = await runner.start({ ...request, mode: 'build-skill' }, () => {})

    expect(result).toEqual({ ok: false, error: 'build-skill run requires evidence' })
    expect(run).not.toHaveBeenCalled()
  })

  it('refuses a coach run without a prompt', async () => {
    const run = vi.fn(async function* () { /* no-op */ })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    const result = await runner.start({ ...request, prompt: '   ' }, () => {})

    expect(result).toEqual({ ok: false, error: 'coach run requires a prompt' })
    expect(run).not.toHaveBeenCalled()
  })

  it('streams the build-skill prose through the normal coach:run channel', async () => {
    const runner = makeRunner(scriptedRuntime([
      { kind: 'status', state: 'starting' },
      { kind: 'text', delta: '# git commit' },
      { kind: 'text', delta: '\n\n## Description\nCommit changes.' },
      { kind: 'status', state: 'done' },
    ]))
    const events: CoachEvent[] = []

    const result = await runner.start({ ...request, mode: 'build-skill', evidence }, (_runId, event) => { events.push(event) })

    expect(result).toEqual({ ok: true, runId: expect.any(String) })
    await vi.waitFor(() => expect(events).toHaveLength(4))
    const text = events.filter(e => e.kind === 'text').map(e => (e as { kind: 'text'; delta: string }).delta).join('')
    expect(text).toBe('# git commit\n\n## Description\nCommit changes.')
  })
})

describe('Ledger MCP config (map 53) — the self-serve stdio server the agent spawns', () => {
  beforeEach(() => {
    ledgerMcpServer.mockClear()
  })

  it('is not spawned by the runner for a harness the detector did not find', async () => {
    const run = vi.fn(async function* () { /* no-op */ })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    await runner.start({ ...request, harnessKind: 'ghost' }, () => {})

    expect(ledgerMcpServer).not.toHaveBeenCalled()
  })
})
