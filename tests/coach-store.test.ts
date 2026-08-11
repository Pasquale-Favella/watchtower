import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CoachEventEnvelope } from '../src/shared/schemas/agents.js'

function createMemoryStorage(): Storage {
  const store = new Map<string, string>()
  return {
    get length() { return store.size },
    clear: () => { store.clear() },
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => { store.delete(key) },
    setItem: (key: string, value: string) => { store.set(key, value) },
  }
}

// The settings store persists via `createJSONStorage(() => localStorage)` at
// module load — install the memory storage BEFORE the dynamic import.
const memory = createMemoryStorage()
vi.stubGlobal('localStorage', memory)

const { useCoachSkillsStore } = await import('../src/renderer/src/features/coach-skills/store.js')

/** Stub the preload surface for the fetch wrappers' IPC-call sites. */
function mockWindow(api: unknown): void {
  ;(globalThis as { window?: unknown }).window = { api }
}

const harnesses = [
  { kind: 'claude', displayName: 'Claude Code', models: ['claude-opus-4-8'], authStatus: 'configured' },
  { kind: 'gemini', displayName: 'Gemini CLI', models: [], authStatus: 'unknown' },
]

const envelope = (event: CoachEventEnvelope['event']): CoachEventEnvelope => ({ runId: 'run-1', event })

beforeEach(() => {
  useCoachSkillsStore.setState(useCoachSkillsStore.getInitialState(), true)
})

describe('useCoachSkillsStore — unified Coach & Skills chat state (ADR 0017)', () => {
  it('starts idle with no harness, no workspace, and an empty thread', () => {
    const s = useCoachSkillsStore.getState()
    expect(s.hydrated).toBe(false)
    expect(s.harnesses).toEqual([])
    expect(s.harnessKind).toBeNull()
    expect(s.workspacePath).toBeNull()
    expect(s.mode).toBe('coach')
    expect(s.messages).toEqual([])
    expect(s.running).toBe(false)
    expect(s.activeRunId).toBeNull()
    expect(s.sessionId).toBeNull()
    expect(s.error).toBeNull()
  })

  it('loadHarnesses hydrates the picker rows and auto-selects the first harness', async () => {
    mockWindow({ getCoachHarnesses: () => Promise.resolve(harnesses) })
    await useCoachSkillsStore.getState().loadHarnesses()
    const s = useCoachSkillsStore.getState()
    expect(s.hydrated).toBe(true)
    expect(s.harnesses).toEqual(harnesses)
    expect(s.harnessKind).toBe('claude')
  })

  it('loadHarnesses drops a schema-invalid payload without hydrating', async () => {
    mockWindow({ getCoachHarnesses: () => Promise.resolve([{ kind: 123 }]) })
    await useCoachSkillsStore.getState().loadHarnesses()
    const s = useCoachSkillsStore.getState()
    expect(s.hydrated).toBe(false)
    expect(s.harnesses).toEqual([])
    expect(s.harnessKind).toBeNull()
  })

  it('sendCoach pushes user + assistant turns and acks the run', async () => {
    mockWindow({ startCoachRun: () => Promise.resolve({ ok: true, runId: 'run-9' }) })
    useCoachSkillsStore.setState({ harnessKind: 'claude', workspacePath: 'C:\\work' })

    await useCoachSkillsStore.getState().sendCoach('Summarise my spend')

    const s = useCoachSkillsStore.getState()
    expect(s.running).toBe(true)
    expect(s.activeRunId).toBe('run-9')
    expect(s.messages).toHaveLength(2)
    expect(s.messages[0]).toMatchObject({ role: 'user', content: 'Summarise my spend', mode: 'coach' })
    expect(s.messages[1]).toMatchObject({ role: 'assistant', content: '', mode: 'coach', streaming: true })
  })

  it('sendCoach forwards the resume sessionId only on coach turns', async () => {
    const startCoachRun = vi.fn(() => Promise.resolve({ ok: true, runId: 'run-9' }))
    mockWindow({ startCoachRun })
    useCoachSkillsStore.setState({ harnessKind: 'claude', workspacePath: 'C:\\work', sessionId: 'sess_prev' })

    await useCoachSkillsStore.getState().sendCoach('p')

    expect(startCoachRun).toHaveBeenCalledWith({
      harnessKind: 'claude',
      workspacePath: 'C:\\work',
      mode: 'coach',
      prompt: 'p',
      sessionId: 'sess_prev',
    })
  })

  it('sendCoach without a harness or workspace fails without launching', async () => {
    const startCoachRun = vi.fn(() => Promise.resolve({ ok: true, runId: 'run-9' }))
    mockWindow({ startCoachRun })
    useCoachSkillsStore.setState({ harnessKind: null, workspacePath: null })

    await useCoachSkillsStore.getState().sendCoach('p')

    expect(useCoachSkillsStore.getState().error).toBe('select a harness and a workspace first')
    expect(startCoachRun).not.toHaveBeenCalled()
  })

  it('sendBuildSkill sends normalized evidence only and never resumes', async () => {
    const startCoachRun = vi.fn(() => Promise.resolve({ ok: true, runId: 'run-9' }))
    mockWindow({ startCoachRun })
    useCoachSkillsStore.setState({ harnessKind: 'claude', workspacePath: 'C:\\work', sessionId: 'sess_prev' })

    await useCoachSkillsStore.getState().sendBuildSkill({
      name: 'data-fetch',
      source: 'skill',
      frequency: 6,
      spreadSessions: 2,
      spreadProjects: 1,
      costUSD: 3.5,
      turns: 4,
      latest: '2026-07-13T12:00:00.000Z',
      sample: 'data-fetch',
      sourceSessions: [{ sessionId: 'sess-a', project: 'demo', date: '2026-07-13', turns: 3, costUSD: 2 }],
    })

    expect(startCoachRun).toHaveBeenCalledWith({
      harnessKind: 'claude',
      workspacePath: 'C:\\work',
      mode: 'build-skill',
      evidence: {
        source: 'skill',
        name: 'data-fetch',
        frequency: 6,
        spreadSessions: 2,
        spreadProjects: 1,
        costUSD: 3.5,
        turns: 4,
      },
      // No sessionId: each build-skill run is a fresh one-shot.
    })
  })

  it('sendBuildSkill seeds the draft card and the done event fills its markdown', async () => {
    mockWindow({ startCoachRun: () => Promise.resolve({ ok: true, runId: 'run-9' }) })
    useCoachSkillsStore.setState({ harnessKind: 'claude', workspacePath: 'C:\\work' })

    await useCoachSkillsStore.getState().sendBuildSkill({
      name: 'data-fetch',
      source: 'skill',
      frequency: 6,
      spreadSessions: 2,
      spreadProjects: 1,
      costUSD: 3.5,
      turns: 4,
      latest: '2026-07-13T12:00:00.000Z',
      sample: 'data-fetch',
      sourceSessions: [{ sessionId: 'sess-a', project: 'demo', date: '2026-07-13', turns: 3, costUSD: 2 }],
    })

    // The assistant turn is born with its draft card's candidate attached.
    let assistant = useCoachSkillsStore.getState().messages[1]
    expect(assistant.draft?.candidate.name).toBe('data-fetch')
    expect(assistant.draft?.markdown).toBe('')

    // Stream a delta, then complete — both from the ACTIVE run (the strict
    // guard drops anything else). The done event fills the card markdown.
    const runId = useCoachSkillsStore.getState().activeRunId!
    const run = (event: CoachEventEnvelope['event']): CoachEventEnvelope => ({ runId, event })
    useCoachSkillsStore.getState().onEvent(run({ kind: 'text', delta: '# data-fetch' }))
    useCoachSkillsStore.getState().onEvent(run({ kind: 'status', state: 'done' }))
    assistant = useCoachSkillsStore.getState().messages[1]
    expect(assistant.streaming).toBe(false)
    expect(assistant.draft?.markdown).toBe('# data-fetch')
  })

  it('a failed ack marks the assistant turn errored and stops running', async () => {
    mockWindow({ startCoachRun: () => Promise.resolve({ ok: false, error: 'harness not detected: ghost' }) })
    useCoachSkillsStore.setState({ harnessKind: 'claude', workspacePath: 'C:\\work' })

    await useCoachSkillsStore.getState().sendCoach('p')

    const s = useCoachSkillsStore.getState()
    expect(s.running).toBe(false)
    expect(s.messages[1]).toMatchObject({ streaming: false, error: 'harness not detected: ghost' })
  })

  it('onEvent accumulates text deltas and tool notices into the streaming turn', () => {
    useCoachSkillsStore.setState({ activeRunId: 'run-1', running: true, messages: [
      { id: 'm0', role: 'user', content: 'p', mode: 'coach', tools: [], streaming: false },
      { id: 'm1', role: 'assistant', content: '', mode: 'coach', tools: [], streaming: true },
    ] })
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'text', delta: 'Hel' }))
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'tool', tool: 'Bash' }))
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'text', delta: 'lo' }))
    const assistant = useCoachSkillsStore.getState().messages[1]
    expect(assistant.content).toBe('Hello')
    expect(assistant.tools).toEqual(['Bash'])
  })

  it('onEvent done finalizes the turn and attaches the draft card for a build-skill run', () => {
    useCoachSkillsStore.setState({ activeRunId: 'run-1', running: true, messages: [
      { id: 'm0', role: 'user', content: 'data-fetch', mode: 'build-skill', tools: [], streaming: false },
      { id: 'm1', role: 'assistant', content: '# data-fetch', mode: 'build-skill', tools: [], streaming: true, draft: { candidate: { name: 'data-fetch' }, markdown: '' } },
    ] })
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'status', state: 'done' }))
    const s = useCoachSkillsStore.getState()
    expect(s.running).toBe(false)
    expect(s.activeRunId).toBeNull()
    const assistant = s.messages[1]
    expect(assistant.streaming).toBe(false)
    expect(assistant.draft?.markdown).toBe('# data-fetch')
  })

  it('onEvent stores the session resume handle', () => {
    useCoachSkillsStore.setState({ activeRunId: 'run-1' })
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'session', sessionId: 'sess_9' }))
    expect(useCoachSkillsStore.getState().sessionId).toBe('sess_9')
  })

  it('onEvent surfaces an error and stops running', () => {
    useCoachSkillsStore.setState({ activeRunId: 'run-1', running: true, messages: [
      { id: 'm0', role: 'user', content: 'p', mode: 'coach', tools: [], streaming: false },
      { id: 'm1', role: 'assistant', content: '', mode: 'coach', tools: [], streaming: true },
    ] })
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'error', message: 'CLI not logged in' }))
    const s = useCoachSkillsStore.getState()
    expect(s.running).toBe(false)
    expect(s.messages[1]).toMatchObject({ streaming: false, error: 'CLI not logged in' })
  })

  it('cancel sends the active runId and immediately clears the run state', () => {
    const cancelCoachRun = vi.fn()
    mockWindow({ cancelCoachRun })
    useCoachSkillsStore.setState({ activeRunId: 'run-1', running: true, messages: [
      { id: 'm0', role: 'user', content: 'p', mode: 'coach', tools: [], streaming: false },
      { id: 'm1', role: 'assistant', content: '', mode: 'coach', tools: [], streaming: true },
    ] })
    useCoachSkillsStore.getState().cancel()
    // No done event follows a cancel — the store must recover on its own.
    expect(cancelCoachRun).toHaveBeenCalledWith('run-1')
    expect(useCoachSkillsStore.getState().running).toBe(false)
    expect(useCoachSkillsStore.getState().activeRunId).toBeNull()
    expect(useCoachSkillsStore.getState().messages[1]).toMatchObject({ streaming: false, error: 'cancelled' })

    useCoachSkillsStore.getState().cancel()
    expect(cancelCoachRun).toHaveBeenCalledTimes(1)
  })

  it('onEvent ignores events from a run other than the active one', () => {
    useCoachSkillsStore.setState({ activeRunId: 'run-2', messages: [
      { id: 'm0', role: 'user', content: 'p', mode: 'coach', tools: [], streaming: false },
      { id: 'm1', role: 'assistant', content: '', mode: 'coach', tools: [], streaming: true },
    ] })
    useCoachSkillsStore.getState().onEvent({ runId: 'run-1', event: { kind: 'text', delta: 'stale' } })
    expect(useCoachSkillsStore.getState().messages[1].content).toBe('')
    useCoachSkillsStore.getState().onEvent({ runId: 'run-2', event: { kind: 'text', delta: 'fresh' } })
    expect(useCoachSkillsStore.getState().messages[1].content).toBe('fresh')
  })

  it('resetSession clears the thread and the resume handle', () => {
    useCoachSkillsStore.setState({ sessionId: 'sess_9', messages: [
      { id: 'm0', role: 'user', content: 'p', mode: 'coach', tools: [], streaming: false },
    ], error: 'boom' })
    useCoachSkillsStore.getState().resetSession()
    const s = useCoachSkillsStore.getState()
    expect(s.messages).toEqual([])
    expect(s.sessionId).toBeNull()
    expect(s.error).toBeNull()
  })
})
