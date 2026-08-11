import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createCoachRunner, createSkillsDraftRunner, type CoachRunner } from '../src/main/agents/ipc.js'
import type { HarnessInfo } from '../src/main/agents/detect.js'
import type { HarnessRuntime } from '../src/main/agents/runtime.js'
import type { CoachEvent } from '../src/shared/schemas/agents.js'

/** A fake detect result: one configured claude harness (ADR 0016 shape). */
const harnesses: HarnessInfo[] = [
  {
    name: 'claude',
    kind: 'claude',
    displayName: 'Claude Code',
    bin: 'C:\\bin\\claude-agent-acp.exe',
    models: ['claude-opus-4-8'],
    scrubEnv: ['ANTHROPIC_API_KEY'],
    authStatus: 'configured',
  },
]

const detect = vi.fn(async () => harnesses)

/** A runtime that streams scripted events to completion. */
function scriptedRuntime(events: CoachEvent[]): HarnessRuntime {
  return {
    async *run() {
      for (const event of events) yield event
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
  }
  return { runtime, interrupted: () => interrupted }
}

function makeRunner(runtime: HarnessRuntime, options: { consent?: boolean } = {}): CoachRunner {
  const consent = options.consent ?? true
  return createCoachRunner({ getRuntime: async () => runtime, detect, getConsent: () => consent })
}

/** Yields to the event loop so the fire-and-forget stream pump lands. */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

/** A real on-disk workspace so the runner's workspace gate passes. */
const tempDirs: string[] = []
function realWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'watchtower-ipc-'))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

let workspace = ''
const request = {
  harnessKind: 'claude',
  model: 'claude-opus-4-8',
  workspacePath: '',
  prompt: 'Summarise my spend',
}
beforeEach(() => {
  workspace = realWorkspace()
  request.workspacePath = workspace
})

describe('Coach IPC runner (ticket 21) — ack, stream, cancel over the seam', () => {
  it('lists detected harnesses as picker rows', async () => {
    const runner = makeRunner(scriptedRuntime([]))
    const rows = await runner.harnesses()
    expect(rows).toEqual([
      { kind: 'claude', displayName: 'Claude Code', models: ['claude-opus-4-8'], authStatus: 'configured' },
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

  it('forwards the resume sessionId into the runtime run input', async () => {
    const run = vi.fn(async function* () { /* no-op */ })
    const runtime: HarnessRuntime = { run }
    const runner = makeRunner(runtime)

    await runner.start({ ...request, sessionId: 'sess_prev' }, () => {})

    expect(run).toHaveBeenCalledWith({
      harness: harnesses[0],
      model: 'claude-opus-4-8',
      workspacePath: workspace,
      prompt: 'Summarise my spend',
      sessionId: 'sess_prev',
    })
  })

  it('rejects a non-real workspace at the ack — no run is launched', async () => {
    const run = vi.fn(async function* () { /* no-op */ })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    const result = await runner.start({ ...request, workspacePath: join(workspace, 'does-not-exist') }, () => {})

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/real on-disk/i) })
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects a harness kind that detection did not find', async () => {
    const run = vi.fn(async function* () { /* no-op */ })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    const result = await runner.start({ ...request, harnessKind: 'ghost' }, () => {})

    expect(result).toEqual({ ok: false, error: 'harness not detected: ghost' })
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects a malformed request against the frozen wire schema', async () => {
    const run = vi.fn(async function* () { /* no-op */ })
    const runner = makeRunner({ run } as unknown as HarnessRuntime)

    const result = await runner.start({ harnessKind: 'claude' }, () => {})

    expect(result).toEqual({ ok: false, error: 'invalid coach run request' })
    expect(run).not.toHaveBeenCalled()
  })

  it('refuses an unconsented run — the gate is main-authoritative (ADR 0012 addendum)', async () => {
    const run = vi.fn(async function* () { /* no-op */ })
    const runner = makeRunner({ run } as unknown as HarnessRuntime, { consent: false })

    const result = await runner.start(request, () => {})

    expect(result).toEqual({ ok: false, error: 'consent required' })
    // No SDK load, no spawn: the refusal happens before the runtime is touched.
    expect(run).not.toHaveBeenCalled()
  })

  it('a consented run launches normally', async () => {
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

describe('Skills draft prose runner (ticket 25) — consent-gated harness prose', () => {
  const proseRequest = {
    source: 'bash' as const,
    name: 'git commit',
    frequency: 6,
    spreadSessions: 2,
    spreadProjects: 1,
    costUSD: 3.5,
    turns: 4,
  }

  function makeDraftRunner(runtime: HarnessRuntime, options: { consent?: boolean; proseTimeoutMs?: number } = {}): ReturnType<typeof createSkillsDraftRunner> {
    return createSkillsDraftRunner({
      getRuntime: async () => runtime,
      detect,
      getConsent: () => options.consent ?? true,
      defaultWorkspace: () => realWorkspace(),
      ...(options.proseTimeoutMs !== undefined ? { proseTimeoutMs: options.proseTimeoutMs } : {}),
    })
  }

  it('refuses without consent before any SDK load or spawn', async () => {
    const runner = makeDraftRunner(scriptedRuntime([]), { consent: false })
    expect(await runner.prose(proseRequest)).toEqual({ ok: false, error: 'consent required' })
  })

  it('rejects malformed requests', async () => {
    const runner = makeDraftRunner(scriptedRuntime([]))
    expect(await runner.prose({ source: 'bash' })).toEqual({ ok: false, error: 'invalid prose request' })
  })

  it('joins text deltas into the harness-authored markdown', async () => {
    const runtime = scriptedRuntime([
      { kind: 'status', state: 'starting' },
      { kind: 'text', delta: '# git commit' },
      { kind: 'text', delta: '\n\n## Description\nCommit changes.' },
      { kind: 'status', state: 'done' },
    ])
    const result = await makeDraftRunner(runtime).prose(proseRequest)
    expect(result).toEqual({ ok: true, markdown: '# git commit\n\n## Description\nCommit changes.' })
  })

  it('maps a harness error event to an error result', async () => {
    const runtime = scriptedRuntime([{ kind: 'error', message: 'harness crashed' }])
    expect(await makeDraftRunner(runtime).prose(proseRequest)).toEqual({ ok: false, error: 'harness crashed' })
  })

  it('reports empty output as an error', async () => {
    const runtime = scriptedRuntime([{ kind: 'status', state: 'done' }])
    expect(await makeDraftRunner(runtime).prose(proseRequest)).toEqual({ ok: false, error: 'harness returned no prose' })
  })

  it('times out a hung harness and interrupts the same iterator', async () => {
    const { runtime, interrupted } = streamingRuntime()
    const result = await makeDraftRunner(runtime, { proseTimeoutMs: 30 }).prose(proseRequest)
    expect(result).toEqual({ ok: false, error: 'harness prose timed out' })
    // The timeout's return() reached the generator, so the harness's cleanup
    // (the finally in the seam) ran — no leaked child process.
    await vi.waitFor(() => expect(interrupted()).toBe(true))
  })
})
