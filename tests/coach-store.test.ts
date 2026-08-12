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

beforeEach(() => {
  useCoachSkillsStore.setState(useCoachSkillsStore.getInitialState(), true)
})

describe('useCoachSkillsStore — unified Coach & Skills chat state (ADR 0017)', () => {
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

  it('setHarness clears the declared set and the user\'s picks (a different agent)', async () => {
    useCoachSkillsStore.setState({
      harnessKind: 'claude',
      sessionModels: { availableModels: [{ modelId: 'opus', name: 'x' }], currentModelId: 'opus' },
      sessionModes: { availableModes: [{ id: 'plan', name: 'Plan' }], currentModeId: 'plan' },
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
  })

  it('sendCoach without a harness fails without launching', async () => {
    const startCoachRun = vi.fn(() => Promise.resolve({ ok: true, runId: 'run-9' }))
    mockWindow({ startCoachRun })
    useCoachSkillsStore.setState({ harnessKind: null })

    await useCoachSkillsStore.getState().sendCoach('p')

    expect(useCoachSkillsStore.getState().error).toBe('select a harness first')
    expect(startCoachRun).not.toHaveBeenCalled()
  })

  it('sendBuildSkill sends normalized evidence only and resumes the conversation', async () => {
    const startCoachRun = vi.fn(() => Promise.resolve({ ok: true, runId: 'run-9' }))
    mockWindow({ startCoachRun })
    useCoachSkillsStore.setState({ harnessKind: 'claude', sessionId: 'sess_prev' })

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
      scope: expectedScope(),
      // Map 58: a build-skill run is part of the ONE conversation — it resumes
      // the session so the user can iterate on the draft.
      sessionId: 'sess_prev',
    })
  })

  it('sendBuildSkill seeds the draft card and the done event fills its markdown', async () => {
    mockWindow({ startCoachRun: () => Promise.resolve({ ok: true, runId: 'run-9' }) })
    useCoachSkillsStore.setState({ harnessKind: 'claude' })

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

  it('onEvent done attaches a draft card to a coach turn whose text is a completed SKILL.md', () => {
    const markdown = [
      '# data-fetch',
      '',
      '## Description',
      'Fetch data.',
      '',
      '## When to use',
      'When you need data.',
      '',
      '## Example',
      '```sh\nfetch --limit 10\n```',
    ].join('\n')
    useCoachSkillsStore.setState({ activeRunId: 'run-1', running: true, messages: [
      { id: 'm0', role: 'user', content: 'craft a skill for data-fetch', mode: 'coach', tools: [], streaming: false },
      { id: 'm1', role: 'assistant', content: markdown, mode: 'coach', tools: [], streaming: true },
    ] })
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'status', state: 'done' }))
    const assistant = useCoachSkillsStore.getState().messages[1]
    expect(assistant.streaming).toBe(false)
    // Candidate-less: the draft card is harness-authored in the conversation.
    expect(assistant.draft).toEqual({ markdown })
  })

  it('onEvent done does NOT attach a draft card to a coach turn that is not a SKILL.md', () => {
    useCoachSkillsStore.setState({ activeRunId: 'run-1', running: true, messages: [
      { id: 'm0', role: 'user', content: 'advice please', mode: 'coach', tools: [], streaming: false },
      { id: 'm1', role: 'assistant', content: 'Here is some advice…', mode: 'coach', tools: [], streaming: true },
    ] })
    useCoachSkillsStore.getState().onEvent(envelope({ kind: 'status', state: 'done' }))
    const assistant = useCoachSkillsStore.getState().messages[1]
    expect(assistant.streaming).toBe(false)
    expect(assistant.draft).toBeUndefined()
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

  it('resetSession clears the thread, resume handle, and declared set, and resets the temp workspace', () => {
    const resetCoachWorkspace = vi.fn()
    mockWindow({ resetCoachWorkspace })
    useCoachSkillsStore.setState({
      sessionId: 'sess_9',
      sessionModels: { availableModels: [{ modelId: 'opus', name: 'x' }], currentModelId: 'opus' },
      sessionModes: { availableModes: [{ id: 'plan', name: 'Plan' }], currentModeId: 'plan' },
      modelId: 'opus',
      modeId: 'plan',
      messages: [
        { id: 'm0', role: 'user', content: 'p', mode: 'coach', tools: [], streaming: false },
      ],
      error: 'boom',
    })
    useCoachSkillsStore.getState().resetSession()
    const s = useCoachSkillsStore.getState()
    expect(resetCoachWorkspace).toHaveBeenCalledTimes(1)
    expect(s.messages).toEqual([])
    expect(s.sessionId).toBeNull()
    expect(s.error).toBeNull()
    expect(s.sessionModels).toBeNull()
    expect(s.sessionModes).toBeNull()
    expect(s.modelId).toBeNull()
    expect(s.modeId).toBeNull()
  })
})

// NOTE: these tests live AFTER the ones above because the shared global
// `window.api` mock is last-write-wins — a probe mock here must not leak into
// the earlier tests' expectations.
describe('useCoachSkillsStore — lazy probe on picker open (map 47 ticket 50)', () => {
  const models = { availableModels: [{ modelId: 'opus', name: 'Claude Opus' }], currentModelId: 'opus' }
  const modes = { availableModes: [{ id: 'plan', name: 'Plan' }], currentModeId: 'plan' }

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

  it('setHarness clears the declared set WITHOUT probing — the next open re-probes lazily', async () => {
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
    // A declared set is NOT cached as empty — only the loaded-guard covers it.
    expect(s.probedEmptyKinds).toEqual([])
  })

  it('a run\'s session event invalidates a stale empty-probe cache for the current harness', async () => {
    mockWindow({ startCoachRun: () => Promise.resolve({ ok: true, runId: 'run-9' }) })
    useCoachSkillsStore.setState({
      harnessKind: 'claude',
      sessionModels: null,
      probedEmptyKinds: ['claude'],
      activeRunId: 'run-1',
    })

    // The run's LIVE handshake declares models the probe never did (e.g. the
    // probe ran without the ledger MCP server) — the empty marker must go.
    useCoachSkillsStore.getState().onEvent({
      runId: 'run-1',
      event: { kind: 'session', sessionId: 'sess_9', models },
    })

    expect(useCoachSkillsStore.getState().probedEmptyKinds).toEqual([])
    expect(useCoachSkillsStore.getState().sessionModels).toEqual(models)
  })

  it('does not re-probe when the current harness set is already loaded', async () => {
    const inspectCoachHarness = vi.fn(() => Promise.resolve({ ok: true, models }))
    mockWindow({ inspectCoachHarness })
    useCoachSkillsStore.setState({ harnessKind: 'claude', sessionModels: models, sessionModes: modes, modelId: 'opus' })

    await useCoachSkillsStore.getState().inspectHarness('claude')

    expect(inspectCoachHarness).not.toHaveBeenCalled()
    expect(useCoachSkillsStore.getState().sessionModels).toEqual(models)
  })

  it('a stale probe (harness switched while in flight) is dropped', async () => {
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
    // the codex one that already landed.
    resolveClaude({ ok: true, models })

    await vi.waitFor(() => expect(useCoachSkillsStore.getState().sessionModels?.availableModels[0]?.modelId).toBe('codex-1'))
    expect(useCoachSkillsStore.getState().sessionModels?.availableModels).toEqual([{ modelId: 'codex-1', name: 'Codex' }])
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
    // An unavailable agent is retried on the next open — no empty cache.
    expect(s.probedEmptyKinds).toEqual([])
    expect(inspectCoachHarness).toHaveBeenCalledTimes(2)
  })

  it('caches a SUCCESSFUL empty-declared probe — re-opening never re-spawns the agent', async () => {
    const inspectCoachHarness = vi.fn(() => Promise.resolve({ ok: true })) // agent declares no models
    mockWindow({ inspectCoachHarness })
    useCoachSkillsStore.setState({ harnessKind: 'claude' })

    await useCoachSkillsStore.getState().inspectHarness('claude')
    expect(useCoachSkillsStore.getState().probedEmptyKinds).toEqual(['claude'])
    expect(useCoachSkillsStore.getState().sessionModels).toBeNull()

    await useCoachSkillsStore.getState().inspectHarness('claude')
    expect(inspectCoachHarness).toHaveBeenCalledTimes(1)
  })

  it('keeps the empty-probe cache across harness switches', async () => {
    const inspectCoachHarness = vi.fn(() => Promise.resolve({ ok: true }))
    mockWindow({ inspectCoachHarness })
    useCoachSkillsStore.setState({ harnessKind: 'claude', probedEmptyKinds: ['claude'] })

    useCoachSkillsStore.getState().setHarness('gemini')
    await useCoachSkillsStore.getState().inspectHarness('gemini') // not cached — probes, also empty
    expect(inspectCoachHarness).toHaveBeenCalledTimes(1)

    useCoachSkillsStore.getState().setHarness('claude')
    await useCoachSkillsStore.getState().inspectHarness('claude') // cached — no spawn
    expect(inspectCoachHarness).toHaveBeenCalledTimes(1)
    expect(useCoachSkillsStore.getState().probedEmptyKinds).toEqual(['claude', 'gemini'])
  })

  it('resetSession clears the thread and declared set WITHOUT re-probing (lazy on next open)', async () => {
    const inspectCoachHarness = vi.fn(() => Promise.resolve({ ok: true, models, modes }))
    mockWindow({ resetCoachWorkspace: vi.fn(), inspectCoachHarness })
    useCoachSkillsStore.setState({
      harnessKind: 'claude',
      sessionModels: models,
      sessionModes: modes,
      modelId: 'opus',
      modeId: 'plan',
      probedEmptyKinds: ['gemini'],
      messages: [
        { id: 'm0', role: 'user', content: 'p', mode: 'coach', tools: [], streaming: false },
      ],
    })

    useCoachSkillsStore.getState().resetSession()

    const s = useCoachSkillsStore.getState()
    expect(s.messages).toEqual([])
    expect(s.sessionModels).toBeNull()
    expect(s.sessionModes).toBeNull()
    expect(s.modelId).toBeNull()
    expect(s.modeId).toBeNull()
    expect(inspectCoachHarness).not.toHaveBeenCalled()
    // The empty-probe cache persists — agent capabilities survive a reset.
    expect(s.probedEmptyKinds).toEqual(['gemini'])
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
