import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createCoachRunner, type CoachRunner } from '../src/main/agents/ipc.js'
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

function makeRunner(runtime: HarnessRuntime): CoachRunner {
  return createCoachRunner({ getRuntime: async () => runtime, detect })
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
