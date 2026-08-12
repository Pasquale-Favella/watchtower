import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CoachEventEnvelope, CoachSessionModels, CoachSessionModes } from '../src/shared/schemas/agents.js'

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
const { selectScope, useScopeStore } = await import('../src/renderer/src/app/stores/scope-store.js')

/** The UI-scope snapshot the store attaches to every run (map 53). */
const expectedScope = (): ReturnType<typeof selectScope> => selectScope(useScopeStore.getState())

/** Stub the preload surface for the fetch wrappers' IPC-call sites. */
function mockWindow(api: unknown): void {
  ;(globalThis as { window?: unknown }).window = { api }
}

const harnesses = [
  { kind: 'claude', displayName: 'Claude Code', authStatus: 'configured' },
  { kind: 'gemini', displayName: 'Gemini CLI', authStatus: 'unknown' },
]

const envelope = (event: CoachEventEnvelope['event']): CoachEventEnvelope => ({ runId: 'run-1', event })

const models: CoachSessionModels = { availableModels: [{ modelId: 'opus', name: 'Claude Opus' }], currentModelId: 'opus' }
const modes: CoachSessionModes = { availableModes: [{ id: 'plan', name: 'Plan' }], currentModeId: 'plan' }

beforeEach(() => {
  useCoachSkillsStore.setState(useCoachSkillsStore.getInitialState(), true)
})

describe('useCoachSkillsStore — unified Coach chat state (ADR 0017)', () => {
  it('starts idle with no harness and an empty thread', () => {
    const s = useCoachSkillsStore.getState()
    expect(s.hydrated).toBe(false)
    expect(s.harnesses).toEqual([])
    expect(s.harnessKind).toBeNull()
    expect(s.messages).toEqual([])
    expect(s.running).toBe(false)
    expect(s.activeRunId).toBeNull()
    expect(s.sessionId).toBeNull()
    expect(s.error).toBeNull()
    expect(s.modelsByKind).toEqual({})
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
    useCoachSkillsStore.setState({ harnessKind: 'claude' })

    await useCoachSkillsStore.getState().sendCoach('Summarise my spend')

    const s = useCoachSkillsStore.getState()
    expect(s.running).toBe(true)
    expect(s.activeRunId).toBe('run-9')
    expect(s.messages).toHaveLength(2)
    expect(s.messages[0]).toMatchObject({ role: 'user', content: 'Summarise my spend', mode: 'coach' })
    expect(s.messages[1]).toMatchObject({ role: 'assistant', content: '', mode: 'coach', streaming: true })
  })

  it('sendCoach forwards the resume sessionId and the UI-scope snapshot', async () => {
    const startCoachRun = vi.fn(() => Promise.resolve({ ok: true, runId: 'run-9' }))
    mockWindow({ startCoachRun })
    useCoachSkillsStore.setState({ harnessKind: 'claude', sessionId: 'sess_prev' })

    await useCoachSkillsStore.getState().sendCoach('p')

    expect(startCoachRun).toHaveBeenCalledWith({
      harnessKind: 'claude',
      mode: 'coach',
      prompt: 'p',
      sessionId: 'sess_prev',
      // Map 53: no workspace path — the harness data context rides the scope.
      scope: expectedScope(),
    })
  })

  it('onEvent stores the agent-declared models/modes and the user\'s pick is sent on the next run', async () => {
    const startCoachRun = vi.fn(() => Promise.resolve({ ok: true, runId: 'run-9' }))
    mockWindow({ startCoachRun })
    useCoachSkillsStore.setState({ harnessKind: 'claude' })

    // A prior run's handshake declared selectable models/modes.
    useCoachSkillsStore.setState({ activeRunId: 'run-1' })
    useCoachSkillsStore.getState().onEvent({
      runId: 'run-1',
      event: {
        kind: 'session',
        sessionId: 'sess_9',
        models: { availableModels: [{ modelId: 'opus', name: 'Claude Opus' }, { modelId: 'sonnet', name: 'Claude Sonnet' }], currentModelId: 'opus' },
        modes: { availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }], currentModeId: 'default' },
      },
    })
    useCoachSkillsStore.getState().setModelId('sonnet')
    useCoachSkillsStore.getState().setModeId('plan')

    await useCoachSkillsStore.getState().sendCoach('p')

    const s = useCoachSkillsStore.getState()
    expect(s.sessionModels?.availableModels).toHaveLength(2)
    expect(s.sessionModes?.availableModes).toHaveLength(2)
    expect(startCoachRun).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'sonnet', modeId: 'plan' }))
  })

  it('does not send modelId/modeId when the agent declared no selectable set', async () => {
    const startCoachRun = vi.fn(() => Promise.resolve({ ok: true, runId: 'run-9' }))
    mockWindow({ startCoachRun })
    useCoachSkillsStore.setState({ harnessKind: 'claude', sessionId: 'sess_prev' })

    await useCoachSkillsStore.getState().sendCoach('p')

    expect(startCoachRun).toHaveBeenCalledWith(expect.not.objectContaining({ modelId: expect.anything(), modeId: expect.anything() }))
  })

  it('setHarness clears the live set for an UNCACHED harness and probes it', () => {
    const inspectCoachHarness = vi.fn(() => Promise.resolve({ ok: false, error: 'agent binary not found' }))
    mockWindow({ inspectCoachHarness })
    useCoachSkillsStore.setState({
      harnessKind: 'claude',
      sessionModels: models,
      sessionModes: modes,
      modelId: 'opus',
      modeId: 'plan',
    })
    // gemini has never been probed — the live set is cleared (a different
    // agent) and the eager warm-start probe fires.
    useCoachSkillsStore.getState().setHarness('gemini')
    const s = useCoachSkillsStore.getState()
    expect(s.harnessKind).toBe('gemini')
    expect(s.sessionModels).toBeNull()
    expect(s.sessionModes).toBeNull()
    expect(s.modelId).toBeNull()
    expect(s.modeId).toBeNull()
    expect(inspectCoachHarness).toHaveBeenCalledWith('gemini')
  })

  it('setHarness restores a CACHED harness instantly — no probe, picks included', () => {
    const inspectCoachHarness = vi.fn(() => Promise.resolve({ ok: true }))
    mockWindow({ inspectCoachHarness })
    useCoachSkillsStore.setState({
      harnessKind: 'claude',
      sessionModels: models,
      sessionModes: modes,
      modelId: 'opus',
      modeId: 'plan',
      modelsByKind: {
        claude: { models, modes, modelId: 'opus', modeId: 'plan' },
        gemini: { models: null, modes: null, modelId: null, modeId: null },
      },
    })

    // gemini was probed empty before — restoring it spawns nothing.
    useCoachSkillsStore.getState().setHarness('gemini')
    expect(useCoachSkillsStore.getState().sessionModels).toBeNull()
    expect(inspectCoachHarness).not.toHaveBeenCalled()

    // Switching back to the cached claude restores set + picks from memory.
    useCoachSkillsStore.getState().setHarness('claude')
    const s = useCoachSkillsStore.getState()
    expect(s.harnessKind).toBe('claude')
    expect(s.sessionModels).toEqual(models)
    expect(s.sessionModes).toEqual(modes)
    expect(s.modelId).toBe('opus')
    expect(s.modeId).toBe('plan')
    expect(inspectCoachHarness).not.toHaveBeenCalled()
  })

  it('setHarness remembers the outgoing harness\'s picks against its cached set', () => {
    const inspectCoachHarness = vi.fn(() => Promise.resolve({ ok: true }))
    mockWindow({ inspectCoachHarness })
    useCoachSkillsStore.setState({
      harnessKind: 'claude',
      sessionModels: models,
      sessionModes: modes,
      modelId: 'opus',
      modelsByKind: {
        claude: { models, modes, modelId: null, modeId: null },
        gemini: { models: null, modes: null, modelId: null, modeId: null },
      },
    })

    // The user changed claude's pick after it was cached — the switch away
    // snapshots the LIVE pick into the cache so a switch-back restores it.
    useCoachSkillsStore.getState().setHarness('gemini')
    expect(useCoachSkillsStore.getState().modelsByKind['claude']?.modelId).toBe('opus')
    expect(useCoachSkillsStore.getState().modelsByKind['claude']?.models).toEqual(models)
  })

  it('sendCoach without a harness fails without launching', async () => {
    const startCoachRun = vi.fn(() => Promise.resolve({ ok: true, runId: 'run-9' }))
    mockWindow({ startCoachRun })
    useCoachSkillsStore.setState({ harnessKind: null })

    await useCoachSkillsStore.getState().sendCoach('p')

    expect(useCoachSkillsStore.getState().error).toBe('select a harness first')
    expect(startCoachRun).not.toHaveBeenCalled()
  })

  it('a failed ack marks the assistant turn errored and stops running', async () => {
    mockWindow({ startCoachRun: () => Promise.resolve({ ok: false, error: 'harness not detected: ghost' }) })
    useCoachSkillsStore.setState({ harnessKind: 'claude' })

    await useCoachSkillsStore.getState().sendCoach('p')

    const s = useCoachSkillsStore.getState()
    expect(s.running).toBe(false)
    expect(s.messages[1]).toMatchObject({ streaming: false, error: 'harness not detected: ghost' })
  })

  it('events arriving before the ack land are buffered and replayed once the run acks', async () => {
    // The main acks, then pumps — a fast failure can emit BEFORE the ack's
    // round-trip reaches the store. Those pre-ack events must not be lost.
    let resolveAck!: (value: { ok: true; runId: string }) => void
    mockWindow({ startCoachRun: () => new Promise(resolve => { resolveAck = resolve }) })
    useCoachSkillsStore.setState({ harnessKind: 'claude' })

    const pending = useCoachSkillsStore.getState().sendCoach('p')
    // The ack is still in flight — an error event arrives first.
    useCoachSkillsStore.getState().onEvent({ runId: 'run-9', event: { kind: 'error', message: 'spawn opencode ENOENT' } })
    expect(useCoachSkillsStore.getState().pendingEvents['run-9']).toHaveLength(1)

    resolveAck({ ok: true, runId: 'run-9' })
    await pending

    const s = useCoachSkillsStore.getState()
    expect(s.running).toBe(false)
    expect(s.activeRunId).toBeNull()
    expect(s.pendingEvents['run-9']).toBeUndefined()
    expect(s.messages[1]).toMatchObject({ streaming: false, error: 'spawn opencode ENOENT' })
  })

  it('onEvent accumulates text deltas, thinking, and tool lifecycle into the streaming turn', () => {
    useCoachSkillsStore.setState({ activeRunId: 'run-1', running: true, messages: [
      { id: 'm0', role: 'user', content: 'p', mode: 'coach', thinking: '', tools: [], streaming: false },
      { id: 'm1', role: 'assistant', content: '', mode: 'coach', thinking: '', tools: [], streaming: true },
    ] })
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'reasoning', delta: 'Let me ' }))
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'text', delta: 'Hel' }))
    // A started tool call with an id, then its completed result.
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'tool', tool: 'Bash', id: 'call-1', state: 'started' }))
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'reasoning', delta: 'think…' }))
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'text', delta: 'lo' }))
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'tool', tool: 'Bash', id: 'call-1', state: 'completed', output: 'total 0' }))
    let assistant = useCoachSkillsStore.getState().messages[1]
    expect(assistant.content).toBe('Hello')
    expect(assistant.thinking).toBe('Let me think…')
    expect(assistant.tools).toEqual([
      { id: 'call-1', tool: 'Bash', state: 'completed', output: 'total 0' },
    ])

    // A second tool call streams after the first finished.
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'tool', tool: 'Edit', id: 'call-2', state: 'started' }))
    assistant = useCoachSkillsStore.getState().messages[1]
    expect(assistant.tools).toHaveLength(2)
    expect(assistant.tools[1]).toEqual({ id: 'call-2', tool: 'Edit', state: 'started' })
  })

  it('onEvent merges a started tool re-announcement by id and keeps a bare notice as started', () => {
    useCoachSkillsStore.setState({ activeRunId: 'run-1', running: true, messages: [
      { id: 'm0', role: 'user', content: 'p', mode: 'coach', thinking: '', tools: [], streaming: false },
      { id: 'm1', role: 'assistant', content: '', mode: 'coach', thinking: '', tools: [], streaming: true },
    ] })
    // The ACP provider opens the call via tool-input-start, then re-announces
    // it via the dynamic tool-call WITH the args preview — same id, merged.
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'tool', tool: 'Bash', id: 'call-1', state: 'started' }))
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'tool', tool: 'Bash', id: 'call-1', state: 'started', input: '{"command":"ls"}' }))
    // A legacy bare notice (no state, older seam) still opens as started.
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'tool', tool: 'Read' }))
    const assistant = useCoachSkillsStore.getState().messages[1]
    expect(assistant.tools).toEqual([
      { id: 'call-1', tool: 'Bash', state: 'started', input: '{"command":"ls"}' },
      { tool: 'Read', state: 'started' },
    ])
  })

  it('onEvent marks an errored tool call (with message) and closes the FIRST started notice when no id is present', () => {
    useCoachSkillsStore.setState({ activeRunId: 'run-1', running: true, messages: [
      { id: 'm0', role: 'user', content: 'p', mode: 'coach', thinking: '', tools: [], streaming: false },
      { id: 'm1', role: 'assistant', content: '', mode: 'coach', thinking: '', tools: [], streaming: true },
    ] })
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'tool', tool: 'WebFetch', state: 'started' }))
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'tool', tool: 'WebFetch', state: 'started' }))
    // In-order streams close the FIRST open call — an interleaved error must
    // not pair with the wrong (later) call.
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'tool', tool: 'WebFetch', state: 'error', error: 'timeout' }))
    const assistant = useCoachSkillsStore.getState().messages[1]
    expect(assistant.tools).toEqual([
      { tool: 'WebFetch', state: 'error', error: 'timeout' },
      { tool: 'WebFetch', state: 'started' },
    ])
  })

  it('onEvent done finalizes the streaming turn', () => {
    useCoachSkillsStore.setState({ activeRunId: 'run-1', running: true, messages: [
      { id: 'm0', role: 'user', content: 'advice please', mode: 'coach', thinking: '', tools: [], streaming: false },
      { id: 'm1', role: 'assistant', content: 'Here is some advice…', mode: 'coach', thinking: '', tools: [], streaming: true },
    ] })
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'status', state: 'done' }))
    const s = useCoachSkillsStore.getState()
    expect(s.running).toBe(false)
    expect(s.activeRunId).toBeNull()
    expect(s.messages[1]).toMatchObject({ streaming: false, content: 'Here is some advice…' })
  })

  it('onEvent stores the session resume handle', () => {
    useCoachSkillsStore.setState({ activeRunId: 'run-1' })
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'session', sessionId: 'sess_9' }))
    expect(useCoachSkillsStore.getState().sessionId).toBe('sess_9')
  })

  it('onEvent surfaces an error and stops running', () => {
    useCoachSkillsStore.setState({ activeRunId: 'run-1', running: true, messages: [
      { id: 'm0', role: 'user', content: 'p', mode: 'coach', thinking: '', tools: [], streaming: false },
      { id: 'm1', role: 'assistant', content: '', mode: 'coach', thinking: '', tools: [], streaming: true },
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
      { id: 'm0', role: 'user', content: 'p', mode: 'coach', thinking: '', tools: [], streaming: false },
      { id: 'm1', role: 'assistant', content: '', mode: 'coach', thinking: '', tools: [], streaming: true },
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

  it('retryAssistant re-runs the last coach turn with the SAME prompt, replacing the old answer in place', async () => {
    const startCoachRun = vi.fn(() => Promise.resolve({ ok: true, runId: 'run-9' }))
    mockWindow({ startCoachRun })
    useCoachSkillsStore.setState({ harnessKind: 'claude', sessionId: 'sess_prev', messages: [
      { id: 'm0', role: 'user', content: 'Summarise my spend', mode: 'coach', thinking: '', tools: [], streaming: false },
      { id: 'm1', role: 'assistant', content: 'old answer', mode: 'coach', thinking: '', tools: [], streaming: false },
    ] })

    await useCoachSkillsStore.getState().retryAssistant('m1')

    const s = useCoachSkillsStore.getState()
    // The user turn stays; the OLD assistant turn is replaced by the fresh one.
    expect(s.messages.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(s.messages[1]).toMatchObject({ role: 'assistant', content: '', streaming: true, mode: 'coach' })
    expect(s.messages[0].id).toBe('m0')
    expect(startCoachRun).toHaveBeenCalledWith(expect.objectContaining({
      harnessKind: 'claude',
      mode: 'coach',
      prompt: 'Summarise my spend',
      scope: expectedScope(),
      sessionId: 'sess_prev',
    }))
    expect(s.running).toBe(true)
    expect(s.activeRunId).toBe('run-9')
  })

  it('retryAssistant refuses a still-streaming assistant turn', async () => {
    const startCoachRun = vi.fn(() => Promise.resolve({ ok: true, runId: 'run-9' }))
    mockWindow({ startCoachRun })
    useCoachSkillsStore.setState({ harnessKind: 'claude', messages: [
      { id: 'm0', role: 'user', content: 'p', mode: 'coach', thinking: '', tools: [], streaming: false },
      { id: 'm1', role: 'assistant', content: 'half…', mode: 'coach', thinking: '', tools: [], streaming: true },
    ] })

    await useCoachSkillsStore.getState().retryAssistant('m1')

    expect(startCoachRun).not.toHaveBeenCalled()
    expect(useCoachSkillsStore.getState().messages).toHaveLength(2)
  })

  it('retryAssistant refuses a NON-last assistant turn, a user turn, and while a run is in flight', async () => {
    const startCoachRun = vi.fn(() => Promise.resolve({ ok: true, runId: 'run-9' }))
    mockWindow({ startCoachRun })
    useCoachSkillsStore.setState({ harnessKind: 'claude', messages: [
      { id: 'm0', role: 'user', content: 'a', mode: 'coach', thinking: '', tools: [], streaming: false },
      { id: 'm1', role: 'assistant', content: 'x', mode: 'coach', thinking: '', tools: [], streaming: false },
      { id: 'm2', role: 'user', content: 'b', mode: 'coach', thinking: '', tools: [], streaming: false },
      { id: 'm3', role: 'assistant', content: 'y', mode: 'coach', thinking: '', tools: [], streaming: false },
    ] })

    // m1 is not the LAST assistant turn — refused.
    await useCoachSkillsStore.getState().retryAssistant('m1')
    // m0 is a user turn — refused.
    await useCoachSkillsStore.getState().retryAssistant('m0')
    expect(startCoachRun).not.toHaveBeenCalled()
    expect(useCoachSkillsStore.getState().messages).toHaveLength(4)

    // The last turn retries fine; then a run in flight blocks a second retry.
    await useCoachSkillsStore.getState().retryAssistant('m3')
    expect(startCoachRun).toHaveBeenCalledTimes(1)
    await useCoachSkillsStore.getState().retryAssistant('m3')
    expect(startCoachRun).toHaveBeenCalledTimes(1)
  })

  it('onEvent ignores events from a run other than the active one', () => {
    useCoachSkillsStore.setState({ activeRunId: 'run-2', messages: [
      { id: 'm0', role: 'user', content: 'p', mode: 'coach', thinking: '', tools: [], streaming: false },
      { id: 'm1', role: 'assistant', content: '', mode: 'coach', thinking: '', tools: [], streaming: true },
    ] })
    useCoachSkillsStore.getState().onEvent({ runId: 'run-1', event: { kind: 'text', delta: 'stale' } })
    expect(useCoachSkillsStore.getState().messages[1].content).toBe('')
    useCoachSkillsStore.getState().onEvent({ runId: 'run-2', event: { kind: 'text', delta: 'fresh' } })
    expect(useCoachSkillsStore.getState().messages[1].content).toBe('fresh')
  })

  it('resetSession clears the thread, resume handle, and error, restores the cached set, and resets the temp workspace', () => {
    const resetCoachWorkspace = vi.fn()
    mockWindow({ resetCoachWorkspace })
    useCoachSkillsStore.setState({
      harnessKind: 'claude',
      sessionId: 'sess_9',
      sessionModels: models,
      sessionModes: modes,
      modelId: 'opus',
      modeId: 'plan',
      modelsByKind: { claude: { models, modes, modelId: 'opus', modeId: 'plan' } },
      messages: [
        { id: 'm0', role: 'user', content: 'p', mode: 'coach', thinking: '', tools: [], streaming: false },
      ],
      error: 'boom',
    })
    useCoachSkillsStore.getState().resetSession()
    const s = useCoachSkillsStore.getState()
    expect(resetCoachWorkspace).toHaveBeenCalledTimes(1)
    expect(s.messages).toEqual([])
    expect(s.sessionId).toBeNull()
    expect(s.error).toBeNull()
    // The thread is conversation state; the harness's declared set is not —
    // restored from the per-kind cache so the pickers never go blank.
    expect(s.sessionModels).toEqual(models)
    expect(s.sessionModes).toEqual(modes)
    expect(s.modelId).toBe('opus')
    expect(s.modeId).toBe('plan')
  })
})

// NOTE: these tests live AFTER the ones above because the shared global
// `window.api` mock is last-write-wins — a probe mock here must not leak into
// the earlier tests' expectations.
describe('useCoachSkillsStore — per-harness model cache (map 47 ticket 50)', () => {
  it('probes the AUTO-SELECTED harness eagerly (hybrid warm start) — first-run sessions stay warm without an open', async () => {
    const inspectCoachHarness = vi.fn(() => Promise.resolve({ ok: true, models, modes }))
    mockWindow({ getCoachHarnesses: () => Promise.resolve(harnesses), inspectCoachHarness })

    await useCoachSkillsStore.getState().loadHarnesses()
    await vi.waitFor(() => expect(useCoachSkillsStore.getState().sessionModels).not.toBeNull())

    const s = useCoachSkillsStore.getState()
    expect(inspectCoachHarness).toHaveBeenCalledWith('claude')
    expect(s.harnessKind).toBe('claude')
    expect(s.sessionModels?.availableModels).toEqual(models.availableModels)
    expect(s.sessionModes?.availableModes).toEqual(modes.availableModes)
    expect(s.modelId).toBe('opus')
  })

  it('setHarness clears the live set AND eagerly probes an UNCACHED harness (models load without an open)', async () => {
    const inspectCoachHarness = vi.fn(() => Promise.resolve({ ok: true, models }))
    mockWindow({ inspectCoachHarness })
    useCoachSkillsStore.setState({
      harnessKind: 'claude',
      sessionModels: models,
      sessionModes: modes,
      modelId: 'opus',
      modeId: 'plan',
    })

    useCoachSkillsStore.getState().setHarness('gemini')

    const s = useCoachSkillsStore.getState()
    expect(s.harnessKind).toBe('gemini')
    expect(s.sessionModels).toBeNull()
    expect(s.sessionModes).toBeNull()
    expect(s.modelId).toBeNull()
    expect(s.modeId).toBeNull()
    // The switch warms the new agent's models immediately — no open needed.
    expect(inspectCoachHarness).toHaveBeenCalledWith('gemini')
    await vi.waitFor(() => expect(useCoachSkillsStore.getState().sessionModels).toEqual(models))
    // The successful probe cached gemini — a later switch-back restores it.
    expect(useCoachSkillsStore.getState().modelsByKind['gemini']?.models).toEqual(models)
    // claude was NEVER probed in this flow (it was seeded directly) — so it
    // is not marked cached, and its next open genuinely probes it.
    expect(useCoachSkillsStore.getState().modelsByKind['claude']).toBeUndefined()
  })

  it('a switch-back to a probed harness restores its set WITHOUT re-probing', async () => {
    const inspectCoachHarness = vi.fn((kind: string) => Promise.resolve({
      ok: true,
      ...(kind === 'claude' ? { models } : {}),
      ...(kind === 'gemini' ? { models: { availableModels: [{ modelId: 'gem-1', name: 'Gemini' }], currentModelId: 'gem-1' } } : {}),
    }))
    mockWindow({ inspectCoachHarness })
    useCoachSkillsStore.setState({ harnessKind: 'claude' })

    // Probe claude, switch away to gemini (probes + caches it), switch back.
    await useCoachSkillsStore.getState().inspectHarness('claude')
    useCoachSkillsStore.getState().setHarness('gemini')
    await vi.waitFor(() => expect(useCoachSkillsStore.getState().sessionModels?.availableModels[0]?.modelId).toBe('gem-1'))
    expect(inspectCoachHarness).toHaveBeenCalledTimes(2)

    useCoachSkillsStore.getState().setHarness('claude')
    const s = useCoachSkillsStore.getState()
    expect(s.harnessKind).toBe('claude')
    expect(s.sessionModels).toEqual(models)
    // No reload for the cached claude set.
    expect(inspectCoachHarness).toHaveBeenCalledTimes(2)
  })

  it('opening the picker probes the harness and loads its declared set (agent default pre-selected)', async () => {
    const inspectCoachHarness = vi.fn(() => Promise.resolve({ ok: true, models, modes }))
    mockWindow({ inspectCoachHarness })
    useCoachSkillsStore.setState({ harnessKind: 'claude' })

    await useCoachSkillsStore.getState().inspectHarness('claude')

    const s = useCoachSkillsStore.getState()
    expect(inspectCoachHarness).toHaveBeenCalledWith('claude')
    expect(s.sessionModels?.availableModels).toEqual(models.availableModels)
    expect(s.sessionModes?.availableModes).toEqual(modes.availableModes)
    expect(s.modelId).toBe('opus')
    expect(s.modeId).toBe('plan')
    // A declared set is NOT cached as empty — only the cache entry marks it.
    expect(s.modelsByKind['claude']?.models).toEqual(models)
  })

  it('a run\'s session event refreshes the per-harness cache for the current harness', async () => {
    mockWindow({ startCoachRun: () => Promise.resolve({ ok: true, runId: 'run-9' }) })
    useCoachSkillsStore.setState({
      harnessKind: 'claude',
      sessionModels: null,
      // A prior probe declared nothing selectable.
      modelsByKind: { claude: { models: null, modes: null, modelId: null, modeId: null } },
      activeRunId: 'run-1',
    })

    // The run's LIVE handshake declares models the probe never did (e.g. the
    // probe ran without the ledger MCP server) — the empty cache entry is
    // overwritten with the real declaration.
    useCoachSkillsStore.getState().onEvent({
      runId: 'run-1',
      event: { kind: 'session', sessionId: 'sess_9', models },
    })

    expect(useCoachSkillsStore.getState().modelsByKind['claude']?.models).toEqual(models)
    expect(useCoachSkillsStore.getState().sessionModels).toEqual(models)
  })

  it('does not re-probe when the current harness set is already loaded (cached)', async () => {
    const inspectCoachHarness = vi.fn(() => Promise.resolve({ ok: true, models }))
    mockWindow({ inspectCoachHarness })
    useCoachSkillsStore.setState({
      harnessKind: 'claude',
      sessionModels: models,
      sessionModes: modes,
      modelId: 'opus',
      modelsByKind: { claude: { models, modes, modelId: 'opus', modeId: 'plan' } },
    })

    await useCoachSkillsStore.getState().inspectHarness('claude')

    expect(inspectCoachHarness).not.toHaveBeenCalled()
    expect(useCoachSkillsStore.getState().sessionModels).toEqual(models)
  })

  it('a probe that answers after a harness switch caches for its kind but never clobbers the live set', async () => {
    let resolveClaude!: (value: { ok: true; models: typeof models }) => void
    const inspectCoachHarness = vi.fn()
    inspectCoachHarness.mockImplementationOnce(() => new Promise(resolve => { resolveClaude = resolve }))
    inspectCoachHarness.mockImplementation(() => Promise.resolve({
      ok: true,
      models: { availableModels: [{ modelId: 'codex-1', name: 'Codex' }], currentModelId: 'codex-1' },
    }))
    mockWindow({ inspectCoachHarness })
    useCoachSkillsStore.setState({ harnessKind: 'claude' })

    useCoachSkillsStore.getState().inspectHarness('claude')
    useCoachSkillsStore.getState().setHarness('codex')
    useCoachSkillsStore.getState().inspectHarness('codex')
    // The claude probe answers AFTER the switch — its set must not clobber
    // the codex one that already landed, but it IS cached for the next
    // switch-back.
    resolveClaude({ ok: true, models })

    await vi.waitFor(() => expect(useCoachSkillsStore.getState().sessionModels?.availableModels[0]?.modelId).toBe('codex-1'))
    expect(useCoachSkillsStore.getState().sessionModels?.availableModels).toEqual([{ modelId: 'codex-1', name: 'Codex' }])
    expect(useCoachSkillsStore.getState().modelsByKind['claude']?.models).toEqual(models)

    // Switching back to claude restores the cached set without a reload.
    useCoachSkillsStore.getState().setHarness('claude')
    expect(useCoachSkillsStore.getState().sessionModels).toEqual(models)
  })

  it('a failed probe leaves the pickers absent, the probe flag cleared, and NOTHING cached — the next open retries', async () => {
    const inspectCoachHarness = vi.fn(() => Promise.resolve({ ok: false, error: 'agent binary not found' }))
    mockWindow({ inspectCoachHarness })
    useCoachSkillsStore.setState({ harnessKind: 'claude' })

    await useCoachSkillsStore.getState().inspectHarness('claude')
    await useCoachSkillsStore.getState().inspectHarness('claude')

    const s = useCoachSkillsStore.getState()
    expect(s.sessionModels).toBeNull()
    expect(s.sessionModes).toBeNull()
    expect(s.modelId).toBeNull()
    expect(s.modeId).toBeNull()
    expect(s.inspectingKind).toBeNull()
    // An unavailable agent is retried on the next open — no cache entry.
    expect(s.modelsByKind).toEqual({})
    expect(inspectCoachHarness).toHaveBeenCalledTimes(2)
  })

  it('caches a SUCCESSFUL empty-declared probe — re-opening never re-spawns the agent', async () => {
    const inspectCoachHarness = vi.fn(() => Promise.resolve({ ok: true })) // agent declares no models
    mockWindow({ inspectCoachHarness })
    useCoachSkillsStore.setState({ harnessKind: 'claude' })

    await useCoachSkillsStore.getState().inspectHarness('claude')
    expect(useCoachSkillsStore.getState().modelsByKind['claude']).toEqual({ models: null, modes: null, modelId: null, modeId: null })
    expect(useCoachSkillsStore.getState().sessionModels).toBeNull()

    await useCoachSkillsStore.getState().inspectHarness('claude')
    expect(inspectCoachHarness).toHaveBeenCalledTimes(1)
  })

  it('keeps the probe cache across harness switches', async () => {
    const inspectCoachHarness = vi.fn(() => Promise.resolve({ ok: true }))
    mockWindow({ inspectCoachHarness })
    useCoachSkillsStore.setState({
      harnessKind: 'claude',
      modelsByKind: { claude: { models: null, modes: null, modelId: null, modeId: null } },
    })

    // The eager probe on switch spawns gemini once (not cached) and caches it.
    useCoachSkillsStore.getState().setHarness('gemini')
    await vi.waitFor(() => expect(useCoachSkillsStore.getState().modelsByKind['gemini']).toBeDefined())
    expect(inspectCoachHarness).toHaveBeenCalledTimes(1)

    // Switching back to the cached harness does NOT re-spawn.
    useCoachSkillsStore.getState().setHarness('claude')
    await vi.waitFor(() => expect(useCoachSkillsStore.getState().harnessKind).toBe('claude'))
    expect(inspectCoachHarness).toHaveBeenCalledTimes(1)
  })

  it('resetSession clears the thread and restores the current harness\'s cached set WITHOUT re-probing', async () => {
    const inspectCoachHarness = vi.fn(() => Promise.resolve({ ok: true, models, modes }))
    mockWindow({ resetCoachWorkspace: vi.fn(), inspectCoachHarness })
    useCoachSkillsStore.setState({
      harnessKind: 'claude',
      sessionModels: models,
      sessionModes: modes,
      modelId: 'opus',
      modeId: 'plan',
      modelsByKind: {
        claude: { models, modes, modelId: 'opus', modeId: 'plan' },
        gemini: { models: null, modes: null, modelId: null, modeId: null },
      },
      messages: [
        { id: 'm0', role: 'user', content: 'p', mode: 'coach', thinking: '', tools: [], streaming: false },
      ],
    })

    useCoachSkillsStore.getState().resetSession()

    const s = useCoachSkillsStore.getState()
    expect(s.messages).toEqual([])
    expect(s.sessionModels).toEqual(models)
    expect(s.sessionModes).toEqual(modes)
    expect(s.modelId).toBe('opus')
    expect(s.modeId).toBe('plan')
    expect(inspectCoachHarness).not.toHaveBeenCalled()
    // The per-kind cache survives the reset untouched.
    expect(s.modelsByKind['gemini']).toEqual({ models: null, modes: null, modelId: null, modeId: null })
  })

  it('skips a redundant probe while one for the same harness is already in flight', async () => {
    let resolveProbe!: (value: { ok: true; models: typeof models }) => void
    const inspectCoachHarness = vi.fn(() => new Promise(resolve => { resolveProbe = resolve }))
    mockWindow({ inspectCoachHarness })
    useCoachSkillsStore.setState({ harnessKind: 'claude' })

    const first = useCoachSkillsStore.getState().inspectHarness('claude')
    // Same harness requested again mid-flight — the in-flight probe's result
    // will apply when it lands, so no second IPC round-trip.
    await useCoachSkillsStore.getState().inspectHarness('claude')
    expect(inspectCoachHarness).toHaveBeenCalledTimes(1)

    resolveProbe({ ok: true, models })
    await first
    expect(useCoachSkillsStore.getState().sessionModels?.availableModels).toEqual(models.availableModels)
    expect(useCoachSkillsStore.getState().inspectingKind).toBeNull()
  })
})
