import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CoachEventEnvelope, CoachSessionModels, CoachSessionModes } from '../src/shared/schemas/agents.js'
import { harnessBadge, statusLabel } from '../src/renderer/src/features/coach-skills/lib.js'

function createMemoryStorage(): Storage {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    clear: () => {
      store.clear()
    },
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key)
    },
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
  }
}

// The settings store persists via `createJSONStorage(() => localStorage)` at
// module load — install the memory storage BEFORE the dynamic import.
const memory = createMemoryStorage()
vi.stubGlobal('localStorage', memory)

const { useCoachSkillsStore } = await import('../src/renderer/src/features/coach-skills/store.js')
const { useSettingsStore } = await import('../src/renderer/src/features/settings/store.js')
const { selectScope, useScopeStore } = await import('../src/renderer/src/app/stores/scope-store.js')

/** The UI-scope snapshot the store attaches to every run (map 53). */
const expectedScope = (): ReturnType<typeof selectScope> => selectScope(useScopeStore.getState())

/** Stub the preload surface for the fetch wrappers' IPC-call sites. */
function mockWindow(api: unknown): void {
  ;(globalThis as { window?: unknown }).window = { api }
}

const harnesses = [
  { instanceId: 'claude', kind: 'claude', displayName: 'Claude Code', status: 'ready', auth: { status: 'configured' } },
  { instanceId: 'gemini', kind: 'gemini', displayName: 'Gemini CLI', status: 'warning', auth: { status: 'unknown' } },
]

const envelope = (event: CoachEventEnvelope['event']): CoachEventEnvelope => ({ runId: 'run-1', event })

const models: CoachSessionModels = {
  availableModels: [{ modelId: 'opus', name: 'Claude Opus' }],
  currentModelId: 'opus',
}
const modes: CoachSessionModes = { availableModes: [{ id: 'plan', name: 'Plan' }], currentModeId: 'plan' }

beforeEach(() => {
  useCoachSkillsStore.setState(useCoachSkillsStore.getInitialState(), true)
})

describe('useCoachSkillsStore — unified Coach chat state (ADR 0017)', () => {
  it('derives honest harness status labels and setup badges without a DOM', () => {
    const warning = {
      instanceId: 'codex',
      kind: 'codex',
      displayName: 'Codex',
      status: 'warning' as const,
      auth: { status: 'unknown' as const },
    }
    const error = { ...warning, status: 'error' as const }
    const pending = { ...warning, status: 'pending' as const }
    expect(statusLabel(warning.status)).toBe('Needs attention')
    expect(harnessBadge(warning)).toBe('Sign-in?')
    expect(harnessBadge(error)).toBe('Unavailable')
    expect(harnessBadge(pending)).toBe('Checking…')
  })
  it('starts idle with no harness and an empty thread', () => {
    const s = useCoachSkillsStore.getState()
    expect(s.hydrated).toBe(false)
    expect(s.harnesses).toEqual([])
    expect(s.harnessKind).toBeNull()
    expect(s.messages).toEqual([])
    expect(s.running).toBe(false)
    expect(s.activeRunId).toBeNull()
    expect(s.resumeCursor).toBeNull()
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

  it('selects ready before warning/pending and never selects an error row', async () => {
    const errorRow = {
      instanceId: 'broken',
      kind: 'broken',
      displayName: 'Broken',
      status: 'error' as const,
      auth: { status: 'unknown' as const },
    }
    const warningRow = {
      instanceId: 'needs-login',
      kind: 'needs-login',
      displayName: 'Needs login',
      status: 'warning' as const,
      auth: { status: 'unauthenticated' as const },
    }
    mockWindow({ getCoachHarnesses: () => Promise.resolve([errorRow, warningRow]) })
    await useCoachSkillsStore.getState().loadHarnesses()
    expect(useCoachSkillsStore.getState().harnessKind).toBe('needs-login')

    useCoachSkillsStore.setState(useCoachSkillsStore.getInitialState(), true)
    useCoachSkillsStore.getState().replaceHarnesses([errorRow])
    expect(useCoachSkillsStore.getState().harnessKind).toBeNull()
  })

  it('moves an auto-pick to a ready instance as probes land, but keeps a user pick', () => {
    const pending = (id: string) => ({
      instanceId: id,
      kind: id,
      displayName: id,
      status: 'pending' as const,
      auth: { status: 'unknown' as const },
    })
    const store = useCoachSkillsStore.getState()
    store.replaceHarnesses([pending('claude'), pending('codex')])
    expect(useCoachSkillsStore.getState().harnessKind).toBe('claude')

    useCoachSkillsStore.getState().replaceHarnesses([
      { ...pending('claude'), status: 'error' },
      { ...pending('codex'), status: 'ready', auth: { status: 'configured' } },
    ])
    expect(useCoachSkillsStore.getState().harnessKind).toBe('codex')

    useCoachSkillsStore.getState().setHarness('claude')
    useCoachSkillsStore.getState().replaceHarnesses([
      { ...pending('claude'), status: 'error' },
      { ...pending('codex'), status: 'ready', auth: { status: 'configured' } },
    ])
    expect(useCoachSkillsStore.getState().harnessKind).toBe('claude')
  })

  it('applies a harnesses-changed snapshot before initial load', () => {
    const changed = {
      instanceId: 'codex',
      kind: 'codex',
      displayName: 'Codex',
      status: 'ready' as const,
      auth: { status: 'configured' as const },
    }
    useCoachSkillsStore.getState().replaceHarnesses([changed])
    expect(useCoachSkillsStore.getState()).toMatchObject({ hydrated: true, harnessKind: 'codex', harnesses: [changed] })
  })

  it('refreshHarnesses applies the refreshed rows through replaceHarnesses', async () => {
    const refreshed = [
      {
        instanceId: 'codex',
        kind: 'codex',
        displayName: 'Codex',
        status: 'ready' as const,
        auth: { status: 'configured' as const },
      },
    ]
    const refreshCoachHarnesses = vi.fn(() => Promise.resolve(refreshed))
    mockWindow({ refreshCoachHarnesses })

    await useCoachSkillsStore.getState().refreshHarnesses()

    expect(refreshCoachHarnesses).toHaveBeenCalledOnce()
    expect(useCoachSkillsStore.getState()).toMatchObject({ hydrated: true, harnesses: refreshed, harnessKind: 'codex' })
  })

  it('sendCoach pushes user + assistant turns and acks the run', async () => {
    mockWindow({ startCoachRun: () => Promise.resolve({ ok: true, runId: 'run-9' }) })
    useCoachSkillsStore.setState({ harnessKind: 'claude' })

    await useCoachSkillsStore.getState().sendCoach('Summarise my spend')

    const s = useCoachSkillsStore.getState()
    expect(s.running).toBe(true)
    expect(s.activeRunId).toBe('run-9')
    expect(s.messages).toHaveLength(2)
    expect(s.messages[0]).toMatchObject({ role: 'user', content: 'Summarise my spend' })
    expect(s.messages[1]).toMatchObject({ role: 'assistant', content: '', streaming: true })
  })

  it('sendCoach forwards the resume sessionId and the UI-scope snapshot', async () => {
    const startCoachRun = vi.fn(() => Promise.resolve({ ok: true, runId: 'run-9' }))
    mockWindow({ startCoachRun })
    useCoachSkillsStore.setState({ harnessKind: 'claude', resumeCursor: 'cursor_prev' })

    await useCoachSkillsStore.getState().sendCoach('p')

    expect(startCoachRun).toHaveBeenCalledWith({
      harnessKind: 'claude',
      prompt: 'p',
      resumeCursor: 'cursor_prev',
      // Map 53: no workspace path — the harness data context rides the scope.
      scope: expectedScope(),
    })
  })

  it("onEvent stores the agent-declared models/modes and the user's pick is sent on the next run", async () => {
    const startCoachRun = vi.fn(() => Promise.resolve({ ok: true, runId: 'run-9' }))
    mockWindow({ startCoachRun })
    useCoachSkillsStore.setState({ harnessKind: 'claude' })

    // A prior run's handshake declared selectable models/modes.
    useCoachSkillsStore.setState({
      activeRunId: 'run-1',
      runMessageIds: { 'run-1': 'm1' },
      messages: [{ id: 'm1', role: 'assistant', content: '', thinking: '', tools: [], notices: [], streaming: true }],
    })
    useCoachSkillsStore.getState().onEvent({
      runId: 'run-1',
      event: {
        kind: 'session',
        resumeCursor: 'cursor_9',
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
    useCoachSkillsStore.setState({ harnessKind: 'claude', resumeCursor: 'cursor_prev' })

    await useCoachSkillsStore.getState().sendCoach('p')

    expect(startCoachRun).toHaveBeenCalledWith(
      expect.not.objectContaining({ modelId: expect.anything(), modeId: expect.anything() }),
    )
  })

  it('sendCoach forwards the API-key passthrough opt-in only when enabled in settings', async () => {
    const startCoachRun = vi.fn(() => Promise.resolve({ ok: true, runId: 'run-9' }))
    mockWindow({ startCoachRun })
    useCoachSkillsStore.setState({ harnessKind: 'claude' })

    await useCoachSkillsStore.getState().sendCoach('p')
    expect(startCoachRun).toHaveBeenCalledWith(expect.not.objectContaining({ allowApiKeyEnv: expect.anything() }))

    // The acked first run is still "in flight" (no completion events in this
    // test) — settle it so the second send is not refused as concurrent.
    useCoachSkillsStore.setState({ running: false, activeRunId: null })
    useSettingsStore.getState().setAllowHarnessApiKeyEnv(true)
    await useCoachSkillsStore.getState().sendCoach('p2')
    expect(startCoachRun).toHaveBeenLastCalledWith(expect.objectContaining({ allowApiKeyEnv: true }))
    useSettingsStore.getState().setAllowHarnessApiKeyEnv(false)
  })

  it('inspectHarness carries the API-key passthrough opt-in from settings', async () => {
    const inspectCoachHarness = vi.fn(() => Promise.resolve({ ok: false, error: 'nope' }))
    mockWindow({ inspectCoachHarness })
    useSettingsStore.getState().setAllowHarnessApiKeyEnv(true)

    await useCoachSkillsStore.getState().inspectHarness('claude')

    expect(inspectCoachHarness).toHaveBeenCalledWith({ kind: 'claude', allowApiKeyEnv: true })
    useSettingsStore.getState().setAllowHarnessApiKeyEnv(false)
  })

  it('setHarness clears the live set for an UNCACHED harness without probing it', () => {
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
    // agent) and the picker will probe it only when opened or hovered.
    useCoachSkillsStore.getState().setHarness('gemini')
    const s = useCoachSkillsStore.getState()
    expect(s.harnessKind).toBe('gemini')
    expect(s.sessionModels).toBeNull()
    expect(s.sessionModes).toBeNull()
    expect(s.modelId).toBeNull()
    expect(s.modeId).toBeNull()
    expect(inspectCoachHarness).not.toHaveBeenCalled()
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

  it("setHarness remembers the outgoing harness's picks against its cached set", () => {
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
    mockWindow({
      startCoachRun: () =>
        new Promise(resolve => {
          resolveAck = resolve
        }),
    })
    useCoachSkillsStore.setState({ harnessKind: 'claude' })

    const pending = useCoachSkillsStore.getState().sendCoach('p')
    // The ack is still in flight — an error event arrives first.
    useCoachSkillsStore
      .getState()
      .onEvent({ runId: 'run-9', event: { kind: 'error', message: 'spawn opencode ENOENT' } })
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
    useCoachSkillsStore.setState({
      activeRunId: 'run-1',
      runMessageIds: { 'run-1': 'm1' },
      running: true,
      messages: [
        { id: 'm0', role: 'user', content: 'p', thinking: '', tools: [], streaming: false },
        { id: 'm1', role: 'assistant', content: '', thinking: '', tools: [], streaming: true },
      ],
    })
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'reasoning', delta: 'Let me ' }))
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'text', delta: 'Hel' }))
    // A started tool call with an id, then its completed result.
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'tool', tool: 'Bash', id: 'call-1', state: 'started' }))
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'reasoning', delta: 'think…' }))
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'text', delta: 'lo' }))
    useCoachSkillsStore
      .getState()
      .onEvent(envelope({ kind: 'tool', tool: 'Bash', id: 'call-1', state: 'completed', output: 'total 0' }))
    let assistant = useCoachSkillsStore.getState().messages[1]
    expect(assistant.content).toBe('Hello')
    expect(assistant.thinking).toBe('Let me think…')
    expect(assistant.tools).toEqual([{ id: 'call-1', tool: 'Bash', state: 'completed', output: 'total 0' }])

    // A second tool call streams after the first finished.
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'tool', tool: 'Edit', id: 'call-2', state: 'started' }))
    assistant = useCoachSkillsStore.getState().messages[1]
    expect(assistant.tools).toHaveLength(2)
    expect(assistant.tools[1]).toEqual({ id: 'call-2', tool: 'Edit', state: 'started' })
  })

  it('onEvent merges a started tool re-announcement by id and keeps a bare notice as started', () => {
    useCoachSkillsStore.setState({
      activeRunId: 'run-1',
      runMessageIds: { 'run-1': 'm1' },
      running: true,
      messages: [
        { id: 'm0', role: 'user', content: 'p', thinking: '', tools: [], streaming: false },
        { id: 'm1', role: 'assistant', content: '', thinking: '', tools: [], streaming: true },
      ],
    })
    // The ACP provider opens the call via tool-input-start, then re-announces
    // it via the dynamic tool-call WITH the args preview — same id, merged.
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'tool', tool: 'Bash', id: 'call-1', state: 'started' }))
    useCoachSkillsStore
      .getState()
      .onEvent(envelope({ kind: 'tool', tool: 'Bash', id: 'call-1', state: 'started', input: '{"command":"ls"}' }))
    // A legacy bare notice (no state, older seam) still opens as started.
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'tool', tool: 'Read' }))
    const assistant = useCoachSkillsStore.getState().messages[1]
    expect(assistant.tools).toEqual([
      { id: 'call-1', tool: 'Bash', state: 'started', input: '{"command":"ls"}' },
      { tool: 'Read', state: 'started' },
    ])
  })

  it('onEvent appends an id-less tool completion because tool merging is strictly id-based', () => {
    useCoachSkillsStore.setState({
      activeRunId: 'run-1',
      runMessageIds: { 'run-1': 'm1' },
      running: true,
      messages: [
        { id: 'm0', role: 'user', content: 'p', thinking: '', tools: [], streaming: false },
        { id: 'm1', role: 'assistant', content: '', thinking: '', tools: [], streaming: true },
      ],
    })
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'tool', tool: 'WebFetch', state: 'started' }))
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'tool', tool: 'WebFetch', state: 'started' }))
    // Without an id, the completion cannot be paired to either started call.
    useCoachSkillsStore
      .getState()
      .onEvent(envelope({ kind: 'tool', tool: 'WebFetch', state: 'error', error: 'timeout' }))
    const assistant = useCoachSkillsStore.getState().messages[1]
    expect(assistant.tools).toEqual([
      { tool: 'WebFetch', state: 'started' },
      { tool: 'WebFetch', state: 'started' },
      { tool: 'WebFetch', state: 'error', error: 'timeout' },
    ])
  })

  it('onEvent appends a notice to the run-owned assistant message', () => {
    useCoachSkillsStore.setState({
      activeRunId: 'run-1',
      runMessageIds: { 'run-1': 'm1' },
      running: true,
      messages: [{ id: 'm1', role: 'assistant', content: '', thinking: '', tools: [], notices: [], streaming: true }],
    })

    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'notice', message: 'continuing in a fresh session' }))

    expect(useCoachSkillsStore.getState().messages[0]?.notices).toEqual(['continuing in a fresh session'])
  })

  it('onEvent done finalizes the streaming turn', () => {
    useCoachSkillsStore.setState({
      activeRunId: 'run-1',
      runMessageIds: { 'run-1': 'm1' },
      running: true,
      messages: [
        { id: 'm0', role: 'user', content: 'advice please', thinking: '', tools: [], streaming: false },
        { id: 'm1', role: 'assistant', content: 'Here is some advice…', thinking: '', tools: [], streaming: true },
      ],
    })
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'status', state: 'done' }))
    const s = useCoachSkillsStore.getState()
    expect(s.running).toBe(false)
    expect(s.activeRunId).toBeNull()
    expect(s.messages[1]).toMatchObject({ streaming: false, content: 'Here is some advice…' })
  })

  it('onEvent stores the session resume handle', () => {
    useCoachSkillsStore.setState({ activeRunId: 'run-1', runMessageIds: { 'run-1': 'm1' } })
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'session', resumeCursor: 'cursor_9' }))
    expect(useCoachSkillsStore.getState().resumeCursor).toBe('cursor_9')
  })

  it('onEvent surfaces an error and stops running', () => {
    useCoachSkillsStore.setState({
      activeRunId: 'run-1',
      runMessageIds: { 'run-1': 'm1' },
      running: true,
      messages: [
        { id: 'm0', role: 'user', content: 'p', thinking: '', tools: [], streaming: false },
        { id: 'm1', role: 'assistant', content: '', thinking: '', tools: [], streaming: true },
      ],
    })
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'error', message: 'CLI not logged in' }))
    const s = useCoachSkillsStore.getState()
    expect(s.running).toBe(false)
    expect(s.messages[1]).toMatchObject({ streaming: false, error: 'CLI not logged in' })
  })

  it('cancel sends the active runId and immediately clears the run state', () => {
    const cancelCoachRun = vi.fn()
    mockWindow({ cancelCoachRun })
    useCoachSkillsStore.setState({
      activeRunId: 'run-1',
      runMessageIds: { 'run-1': 'm1' },
      running: true,
      messages: [
        { id: 'm0', role: 'user', content: 'p', thinking: '', tools: [], streaming: false },
        { id: 'm1', role: 'assistant', content: '', thinking: '', tools: [], streaming: true },
      ],
    })
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
    useCoachSkillsStore.setState({
      harnessKind: 'claude',
      resumeCursor: 'cursor_prev',
      messages: [
        { id: 'm0', role: 'user', content: 'Summarise my spend', thinking: '', tools: [], streaming: false },
        { id: 'm1', role: 'assistant', content: 'old answer', thinking: '', tools: [], streaming: false },
      ],
    })

    await useCoachSkillsStore.getState().retryAssistant('m1')

    const s = useCoachSkillsStore.getState()
    // The user turn stays; the OLD assistant turn is replaced by the fresh one.
    expect(s.messages.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(s.messages[1]).toMatchObject({ role: 'assistant', content: '', streaming: true })
    expect(s.messages[0].id).toBe('m0')
    expect(startCoachRun).toHaveBeenCalledWith(
      expect.objectContaining({
        harnessKind: 'claude',
        prompt: 'Summarise my spend',
        scope: expectedScope(),
        resumeCursor: 'cursor_prev',
      }),
    )
    expect(s.running).toBe(true)
    expect(s.activeRunId).toBe('run-9')
  })

  it('retryAssistant refuses a still-streaming assistant turn', async () => {
    const startCoachRun = vi.fn(() => Promise.resolve({ ok: true, runId: 'run-9' }))
    mockWindow({ startCoachRun })
    useCoachSkillsStore.setState({
      harnessKind: 'claude',
      messages: [
        { id: 'm0', role: 'user', content: 'p', thinking: '', tools: [], streaming: false },
        { id: 'm1', role: 'assistant', content: 'half…', thinking: '', tools: [], streaming: true },
      ],
    })

    await useCoachSkillsStore.getState().retryAssistant('m1')

    expect(startCoachRun).not.toHaveBeenCalled()
    expect(useCoachSkillsStore.getState().messages).toHaveLength(2)
  })

  it('retryAssistant refuses a NON-last assistant turn, a user turn, and while a run is in flight', async () => {
    const startCoachRun = vi.fn(() => Promise.resolve({ ok: true, runId: 'run-9' }))
    mockWindow({ startCoachRun })
    useCoachSkillsStore.setState({
      harnessKind: 'claude',
      messages: [
        { id: 'm0', role: 'user', content: 'a', thinking: '', tools: [], streaming: false },
        { id: 'm1', role: 'assistant', content: 'x', thinking: '', tools: [], streaming: false },
        { id: 'm2', role: 'user', content: 'b', thinking: '', tools: [], streaming: false },
        { id: 'm3', role: 'assistant', content: 'y', thinking: '', tools: [], streaming: false },
      ],
    })

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

  it('onEvent routes each event to its run-owned assistant message', () => {
    useCoachSkillsStore.setState({
      activeRunId: 'run-2',
      runMessageIds: { 'run-1': 'm1', 'run-2': 'm2' },
      messages: [
        { id: 'm1', role: 'assistant', content: '', thinking: '', tools: [], notices: [], streaming: true },
        { id: 'm2', role: 'assistant', content: '', thinking: '', tools: [], notices: [], streaming: true },
      ],
    })
    useCoachSkillsStore.getState().onEvent({ runId: 'run-1', event: { kind: 'text', delta: 'stale' } })
    expect(useCoachSkillsStore.getState().messages[0].content).toBe('stale')
    useCoachSkillsStore.getState().onEvent({ runId: 'run-2', event: { kind: 'text', delta: 'fresh' } })
    expect(useCoachSkillsStore.getState().messages[1].content).toBe('fresh')
  })

  it('late text after cancel lands on the cancelled message and preserves its error', () => {
    mockWindow({ cancelCoachRun: vi.fn() })
    useCoachSkillsStore.setState({
      activeRunId: 'run-1',
      runMessageIds: { 'run-1': 'm1' },
      running: true,
      messages: [{ id: 'm1', role: 'assistant', content: '', thinking: '', tools: [], notices: [], streaming: true }],
    })

    useCoachSkillsStore.getState().cancel()
    useCoachSkillsStore.getState().onEvent({ runId: 'run-1', event: { kind: 'text', delta: 'late' } })

    expect(useCoachSkillsStore.getState().messages[0]).toMatchObject({
      content: 'late',
      streaming: false,
      error: 'cancelled',
    })
  })

  it('resetSession clears the thread, resume handle, and error, restores the cached set, and resets the temp workspace', () => {
    const resetCoachWorkspace = vi.fn()
    mockWindow({ resetCoachWorkspace })
    useCoachSkillsStore.setState({
      harnessKind: 'claude',
      resumeCursor: 'cursor_9',
      sessionModels: models,
      sessionModes: modes,
      modelId: 'opus',
      modeId: 'plan',
      modelsByKind: { claude: { models, modes, modelId: 'opus', modeId: 'plan' } },
      messages: [{ id: 'm0', role: 'user', content: 'p', thinking: '', tools: [], streaming: false }],
      error: 'boom',
    })
    useCoachSkillsStore.getState().resetSession()
    const s = useCoachSkillsStore.getState()
    expect(resetCoachWorkspace).toHaveBeenCalledTimes(1)
    expect(s.messages).toEqual([])
    expect(s.resumeCursor).toBeNull()
    expect(s.error).toBeNull()
    // The thread is conversation state; the harness's declared set is not —
    // restored from the per-kind cache so the pickers never go blank.
    expect(s.sessionModels).toEqual(models)
    expect(s.sessionModes).toEqual(modes)
    expect(s.modelId).toBe('opus')
    expect(s.modeId).toBe('plan')
  })

  it('a harness switch after a conversation is the confirm path: new harness + cleared thread, even mid-run', () => {
    // The switch dialog's confirm handler runs setHarness(next) FIRST (it
    // snapshots the outgoing harness's LIVE picks against its cached set — a
    // reset would clobber them back to cached values first), then
    // resetSession() — the conversation is conversation state, the new
    // harness's cached set is not. No explicit cancel() is needed: the reset
    // stops the run main-side (coach:reset cancels all active runs and awaits
    // their teardown) and clears any residual local run state.
    const cancelCoachRun = vi.fn()
    const resetCoachWorkspace = vi.fn()
    const inspectCoachHarness = vi.fn(() => Promise.resolve({ ok: true }))
    mockWindow({ cancelCoachRun, resetCoachWorkspace, inspectCoachHarness })
    useCoachSkillsStore.setState({
      harnessKind: 'claude',
      resumeCursor: 'cursor_9',
      running: true,
      activeRunId: 'run-1',
      runMessageIds: { 'run-1': 'm1' },
      sessionModels: models,
      sessionModes: modes,
      modelId: 'opus',
      modeId: 'plan',
      modelsByKind: {
        claude: { models, modes, modelId: 'opus', modeId: 'plan' },
        gemini: { models: null, modes: null, modelId: null, modeId: null },
      },
      messages: [{ id: 'm0', role: 'user', content: 'p', thinking: '', tools: [], streaming: false }],
    })

    // The composer's confirmHarnessSwitch sequence, exactly: switch + reset.
    useCoachSkillsStore.getState().setHarness('gemini')
    useCoachSkillsStore.getState().resetSession()

    const s = useCoachSkillsStore.getState()
    expect(s.harnessKind).toBe('gemini')
    expect(s.messages).toEqual([])
    expect(s.resumeCursor).toBeNull()
    // The mid-run switch is terminal WITHOUT a renderer-side cancel(): the
    // reset stops the run main-side (coach:reset) and no stale run state
    // survives locally.
    expect(cancelCoachRun).not.toHaveBeenCalled()
    expect(s.running).toBe(false)
    expect(s.activeRunId).toBeNull()
    expect(resetCoachWorkspace).toHaveBeenCalledTimes(1)
    // The new harness's cached (empty) declaration is restored — no blanks.
    expect(s.sessionModels).toBeNull()
    expect(s.sessionModes).toBeNull()
    expect(s.modelId).toBeNull()
    expect(s.modeId).toBeNull()
  })
})

// NOTE: these tests live AFTER the ones above because the shared global
// `window.api` mock is last-write-wins — a probe mock here must not leak into
// the earlier tests' expectations.
describe('useCoachSkillsStore — per-harness model cache (map 47 ticket 50)', () => {
  it('warm-starts the AUTO-SELECTED harness so models populate without opening the picker', async () => {
    const inspectCoachHarness = vi.fn(() => Promise.resolve({ ok: true, models, modes }))
    mockWindow({ getCoachHarnesses: () => Promise.resolve(harnesses), inspectCoachHarness })

    await useCoachSkillsStore.getState().loadHarnesses()
    expect(useCoachSkillsStore.getState().harnessKind).toBe('claude')
    // Hybrid warm-start (pre-#145): the auto-pick probes immediately.
    expect(inspectCoachHarness).toHaveBeenCalledWith({ kind: 'claude' })
    await vi.waitFor(() => expect(useCoachSkillsStore.getState().sessionModels).toEqual(models))
    const s = useCoachSkillsStore.getState()
    expect(s.sessionModes).toEqual(modes)
    expect(s.modelId).toBe('opus')
  })

  it('loadHarnesses re-selects a VANISHED harness through the switch contract: cached set restored, conversation reset', async () => {
    // The user is mid-conversation on 'codex' — but codex is NOT in the fresh
    // detection payload, so loadHarnesses auto-switches to the first detected
    // harness. That is a SWITCH: it must go through setHarness (restore the
    // target's cached set, never leave the old live set on the picker) and,
    // because a conversation exists, reset it — exactly like the picker's
    // confirmed switch, but without a dialog (the harness vanished).
    const cancelCoachRun = vi.fn()
    const resetCoachWorkspace = vi.fn()
    const inspectCoachHarness = vi.fn(() => Promise.resolve({ ok: true }))
    mockWindow({
      getCoachHarnesses: () => Promise.resolve(harnesses),
      cancelCoachRun,
      resetCoachWorkspace,
      inspectCoachHarness,
    })
    useCoachSkillsStore.setState({
      harnessKind: 'codex',
      resumeCursor: 'cursor_old',
      running: true,
      activeRunId: 'run-1',
      runMessageIds: { 'run-1': 'm1' },
      messages: [{ id: 'm1', role: 'assistant', content: '', thinking: '', tools: [], notices: [], streaming: true }],
      sessionModels: models,
      sessionModes: modes,
      modelId: 'opus',
      modeId: 'plan',
      // claude (the switch target) was probed before — its set must restore.
      modelsByKind: {
        claude: { models, modes, modelId: 'opus', modeId: 'plan' },
      },
      messages: [{ id: 'm0', role: 'user', content: 'p', thinking: '', tools: [], streaming: false }],
    })

    await useCoachSkillsStore.getState().loadHarnesses()

    const s = useCoachSkillsStore.getState()
    expect(s.harnessKind).toBe('claude')
    // The vanished harness's conversation is conversation state — cleared,
    // with the local run state reset and the temp workspace dropped. No
    // renderer-side cancel(): the reset stops the run main-side (coach:reset
    // cancels all active runs and awaits their teardown).
    expect(s.messages).toEqual([])
    expect(s.resumeCursor).toBeNull()
    expect(s.running).toBe(false)
    expect(s.activeRunId).toBeNull()
    expect(cancelCoachRun).not.toHaveBeenCalled()
    expect(resetCoachWorkspace).toHaveBeenCalledTimes(1)
    // The target's CACHED set restores — no probe, no blank picker.
    expect(s.sessionModels).toEqual(models)
    expect(s.sessionModes).toEqual(modes)
    expect(s.modelId).toBe('opus')
    expect(inspectCoachHarness).not.toHaveBeenCalled()
  })

  it('setHarness clears the live set without probing an UNCACHED harness', async () => {
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
    expect(inspectCoachHarness).not.toHaveBeenCalled()
    expect(useCoachSkillsStore.getState().modelsByKind['gemini']).toBeUndefined()
    // claude was NEVER probed in this flow (it was seeded directly) — so it
    // is not marked cached, and its next open genuinely probes it.
    expect(useCoachSkillsStore.getState().modelsByKind['claude']).toBeUndefined()
  })

  it('a switch-back to a probed harness restores its set WITHOUT re-probing', async () => {
    const inspectCoachHarness = vi.fn((request: { kind: string }) =>
      Promise.resolve({
        ok: true,
        ...(request.kind === 'claude' ? { models } : {}),
        ...(request.kind === 'gemini'
          ? { models: { availableModels: [{ modelId: 'gem-1', name: 'Gemini' }], currentModelId: 'gem-1' } }
          : {}),
      }),
    )
    mockWindow({ inspectCoachHarness })
    useCoachSkillsStore.setState({ harnessKind: 'claude' })

    // Probe claude, switch away to gemini, switch back.
    await useCoachSkillsStore.getState().inspectHarness('claude')
    useCoachSkillsStore.getState().setHarness('gemini')
    expect(useCoachSkillsStore.getState().sessionModels).toBeNull()
    expect(inspectCoachHarness).toHaveBeenCalledTimes(1)

    useCoachSkillsStore.getState().setHarness('claude')
    const s = useCoachSkillsStore.getState()
    expect(s.harnessKind).toBe('claude')
    expect(s.sessionModels).toEqual(models)
    // No reload for the cached claude set.
    expect(inspectCoachHarness).toHaveBeenCalledTimes(1)
  })

  it('opening the picker probes the harness and loads its declared set (agent default pre-selected)', async () => {
    const inspectCoachHarness = vi.fn(() => Promise.resolve({ ok: true, models, modes }))
    mockWindow({ inspectCoachHarness })
    useCoachSkillsStore.setState({ harnessKind: 'claude' })

    await useCoachSkillsStore.getState().inspectHarness('claude')

    const s = useCoachSkillsStore.getState()
    expect(inspectCoachHarness).toHaveBeenCalledWith({ kind: 'claude' })
    expect(s.sessionModels?.availableModels).toEqual(models.availableModels)
    expect(s.sessionModes?.availableModes).toEqual(modes.availableModes)
    expect(s.modelId).toBe('opus')
    expect(s.modeId).toBe('plan')
    // A declared set is NOT cached as empty — only the cache entry marks it.
    expect(s.modelsByKind['claude']?.models).toEqual(models)
  })

  it("a run's session event refreshes the per-harness cache for the current harness", async () => {
    mockWindow({ startCoachRun: () => Promise.resolve({ ok: true, runId: 'run-9' }) })
    useCoachSkillsStore.setState({
      harnessKind: 'claude',
      sessionModels: null,
      // A prior probe declared nothing selectable.
      modelsByKind: { claude: { models: null, modes: null, modelId: null, modeId: null } },
      activeRunId: 'run-1',
      runMessageIds: { 'run-1': 'm1' },
      messages: [{ id: 'm1', role: 'assistant', content: '', thinking: '', tools: [], notices: [], streaming: true }],
    })

    // The run's LIVE handshake declares models the probe never did (e.g. the
    // probe ran without the ledger MCP server) — the empty cache entry is
    // overwritten with the real declaration.
    useCoachSkillsStore.getState().onEvent({
      runId: 'run-1',
      event: { kind: 'session', resumeCursor: 'cursor_9', models },
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
    inspectCoachHarness.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveClaude = resolve
        }),
    )
    inspectCoachHarness.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        models: { availableModels: [{ modelId: 'codex-1', name: 'Codex' }], currentModelId: 'codex-1' },
      }),
    )
    mockWindow({ inspectCoachHarness })
    useCoachSkillsStore.setState({ harnessKind: 'claude' })

    useCoachSkillsStore.getState().inspectHarness('claude')
    useCoachSkillsStore.getState().setHarness('codex')
    useCoachSkillsStore.getState().inspectHarness('codex')
    // The claude probe answers AFTER the switch — its set must not clobber
    // the codex one that already landed, but it IS cached for the next
    // switch-back.
    resolveClaude({ ok: true, models })

    await vi.waitFor(() =>
      expect(useCoachSkillsStore.getState().sessionModels?.availableModels[0]?.modelId).toBe('codex-1'),
    )
    expect(useCoachSkillsStore.getState().sessionModels?.availableModels).toEqual([
      { modelId: 'codex-1', name: 'Codex' },
    ])
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
    expect(useCoachSkillsStore.getState().modelsByKind['claude']).toEqual({
      models: null,
      modes: null,
      modelId: null,
      modeId: null,
    })
    expect(useCoachSkillsStore.getState().sessionModels).toBeNull()

    await useCoachSkillsStore.getState().inspectHarness('claude')
    expect(inspectCoachHarness).toHaveBeenCalledTimes(1)
  })

  it('does not probe eagerly across harness switches', async () => {
    const inspectCoachHarness = vi.fn(() => Promise.resolve({ ok: true }))
    mockWindow({ inspectCoachHarness })
    useCoachSkillsStore.setState({
      harnessKind: 'claude',
      modelsByKind: { claude: { models: null, modes: null, modelId: null, modeId: null } },
    })

    useCoachSkillsStore.getState().setHarness('gemini')
    expect(useCoachSkillsStore.getState().modelsByKind['gemini']).toBeUndefined()
    expect(inspectCoachHarness).not.toHaveBeenCalled()

    useCoachSkillsStore.getState().setHarness('claude')
    expect(useCoachSkillsStore.getState().harnessKind).toBe('claude')
    expect(inspectCoachHarness).not.toHaveBeenCalled()
  })

  it("resetSession clears the thread and restores the current harness's cached set WITHOUT re-probing", async () => {
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
      messages: [{ id: 'm0', role: 'user', content: 'p', thinking: '', tools: [], streaming: false }],
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
    const inspectCoachHarness = vi.fn(
      () =>
        new Promise(resolve => {
          resolveProbe = resolve
        }),
    )
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
