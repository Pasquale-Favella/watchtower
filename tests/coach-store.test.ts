import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useCoachStore } from '../src/renderer/src/app/stores/coach-store.js'
import { useSettingsStore } from '../src/renderer/src/features/settings/store.js'
import type { CoachEventEnvelope } from '../src/shared/schemas/agents.js'

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
  useCoachStore.setState(useCoachStore.getInitialState(), true)
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
})

describe('useCoachStore — Coach surface state (ticket 21)', () => {
  it('starts unhydrated and idle', () => {
    const s = useCoachStore.getState()
    expect(s.hydrated).toBe(false)
    expect(s.harnesses).toEqual([])
    expect(s.running).toBe(false)
    expect(s.activeRunId).toBeNull()
    expect(s.text).toBe('')
    expect(s.tools).toEqual([])
    expect(s.sessionId).toBeNull()
    expect(s.error).toBeNull()
  })

  it('loadHarnesses hydrates the picker rows from the wire', async () => {
    mockWindow({ getCoachHarnesses: () => Promise.resolve(harnesses) })
    await useCoachStore.getState().loadHarnesses()
    const s = useCoachStore.getState()
    expect(s.hydrated).toBe(true)
    expect(s.harnesses).toEqual(harnesses)
  })

  it('loadHarnesses drops a schema-invalid payload without hydrating', async () => {
    mockWindow({ getCoachHarnesses: () => Promise.resolve([{ kind: 123 }]) })
    await useCoachStore.getState().loadHarnesses()
    const s = useCoachStore.getState()
    expect(s.hydrated).toBe(false)
    expect(s.harnesses).toEqual([])
  })

  it('run resets the stream, acks with a runId, and marks running', async () => {
    mockWindow({ startCoachRun: () => Promise.resolve({ ok: true, runId: 'run-9' }) })
    useSettingsStore.setState({ agentsConsent: true })
    useCoachStore.setState({ text: 'stale', tools: ['Stale'], error: 'boom' })

    await useCoachStore.getState().run({
      harnessKind: 'claude',
      workspacePath: 'C:\\work\\project',
      prompt: 'Summarise my spend',
    })

    const s = useCoachStore.getState()
    expect(s.running).toBe(true)
    expect(s.activeRunId).toBe('run-9')
    expect(s.text).toBe('')
    expect(s.tools).toEqual([])
    expect(s.error).toBeNull()
  })

  it('run forwards the resume sessionId to the wire', async () => {
    const startCoachRun = vi.fn(() => Promise.resolve({ ok: true, runId: 'run-9' }))
    mockWindow({ startCoachRun })
    useSettingsStore.setState({ agentsConsent: true })
    useCoachStore.setState({ sessionId: 'sess_prev' })

    await useCoachStore.getState().run({ harnessKind: 'claude', workspacePath: 'C:\\work', prompt: 'p' })

    expect(startCoachRun).toHaveBeenCalledWith({
      harnessKind: 'claude',
      workspacePath: 'C:\\work',
      prompt: 'p',
      sessionId: 'sess_prev',
    })
  })

  it('run surfaces an ok:false ack as an error and stops running', async () => {
    mockWindow({ startCoachRun: () => Promise.resolve({ ok: false, error: 'harness not detected: ghost' }) })
    useSettingsStore.setState({ agentsConsent: true })
    await useCoachStore.getState().run({ harnessKind: 'ghost', workspacePath: 'C:\\work', prompt: 'p' })
    const s = useCoachStore.getState()
    expect(s.error).toBe('harness not detected: ghost')
    expect(s.running).toBe(false)
  })

  it('run surfaces a malformed ack payload as an error', async () => {
    mockWindow({ startCoachRun: () => Promise.resolve({ ok: 'maybe' }) })
    useSettingsStore.setState({ agentsConsent: true })
    await useCoachStore.getState().run({ harnessKind: 'claude', workspacePath: 'C:\\work', prompt: 'p' })
    const s = useCoachStore.getState()
    expect(s.error).toMatch(/Invalid coach run payload/)
    expect(s.running).toBe(false)
  })

  it('onEvent accumulates text deltas and tool notices in order', () => {
    useCoachStore.getState().onEvent(envelope({ kind: 'text', delta: 'Hel' }))
    useCoachStore.getState().onEvent(envelope({ kind: 'tool', tool: 'Bash' }))
    useCoachStore.getState().onEvent(envelope({ kind: 'text', delta: 'lo' }))
    useCoachStore.getState().onEvent(envelope({ kind: 'tool', tool: 'Edit' }))
    const s = useCoachStore.getState()
    expect(s.text).toBe('Hello')
    expect(s.tools).toEqual(['Bash', 'Edit'])
  })

  it('onEvent marks running on starting and clears it on done', () => {
    useCoachStore.getState().onEvent(envelope({ kind: 'status', state: 'starting' }))
    expect(useCoachStore.getState().running).toBe(true)
    useCoachStore.getState().onEvent(envelope({ kind: 'status', state: 'done' }))
    expect(useCoachStore.getState().running).toBe(false)
  })

  it('onEvent stores the session resume handle', () => {
    useCoachStore.getState().onEvent(envelope({ kind: 'session', sessionId: 'sess_9' }))
    expect(useCoachStore.getState().sessionId).toBe('sess_9')
  })

  it('onEvent surfaces an error and stops running', () => {
    useCoachStore.getState().onEvent(envelope({ kind: 'status', state: 'starting' }))
    useCoachStore.getState().onEvent(envelope({ kind: 'error', message: 'CLI not logged in' }))
    const s = useCoachStore.getState()
    expect(s.error).toBe('CLI not logged in')
    expect(s.running).toBe(false)
  })

  it('cancel sends the active runId and immediately clears the run state', () => {
    const cancelCoachRun = vi.fn()
    mockWindow({ cancelCoachRun })
    useCoachStore.setState({ activeRunId: 'run-1', running: true })
    useCoachStore.getState().cancel()
    // No done event follows a cancel — the store must recover on its own.
    expect(cancelCoachRun).toHaveBeenCalledWith('run-1')
    expect(useCoachStore.getState().running).toBe(false)
    expect(useCoachStore.getState().activeRunId).toBeNull()

    useCoachStore.getState().cancel()
    expect(cancelCoachRun).toHaveBeenCalledTimes(1)
  })

  it('onEvent ignores events from a run other than the active one', () => {
    useCoachStore.setState({ activeRunId: 'run-2' })
    useCoachStore.getState().onEvent({ runId: 'run-1', event: { kind: 'text', delta: 'stale' } })
    expect(useCoachStore.getState().text).toBe('')
    useCoachStore.getState().onEvent({ runId: 'run-2', event: { kind: 'text', delta: 'fresh' } })
    expect(useCoachStore.getState().text).toBe('fresh')
  })

  it('resetSession clears the resume handle and stream buffers', () => {
    useCoachStore.setState({ sessionId: 'sess_9', text: 'old', tools: ['Bash'], error: 'boom' })
    useCoachStore.getState().resetSession()
    const s = useCoachStore.getState()
    expect(s.sessionId).toBeNull()
    expect(s.text).toBe('')
    expect(s.tools).toEqual([])
    expect(s.error).toBeNull()
  })

  it('starts with the consent gate closed (offline/template mode)', () => {
    const s = useCoachStore.getState()
    expect(s.consentRequired).toBe(false)
    expect(s.pendingRun).toBeNull()
    expect(s.consentDeclined).toBe(false)
  })

  it('run holds an unconsented run behind the gate — no wire call', async () => {
    const startCoachRun = vi.fn(() => Promise.resolve({ ok: true, runId: 'run-9' }))
    mockWindow({ startCoachRun })
    useSettingsStore.setState({ agentsConsent: false })

    await useCoachStore.getState().run({ harnessKind: 'claude', workspacePath: 'C:\\work', prompt: 'p' })

    const s = useCoachStore.getState()
    expect(s.consentRequired).toBe(true)
    expect(s.pendingRun).toEqual({ harnessKind: 'claude', workspacePath: 'C:\\work', prompt: 'p' })
    expect(startCoachRun).not.toHaveBeenCalled()
    expect(s.running).toBe(false)
  })

  it('a consented run skips the gate and launches normally', async () => {
    const startCoachRun = vi.fn(() => Promise.resolve({ ok: true, runId: 'run-9' }))
    mockWindow({ startCoachRun })
    useSettingsStore.setState({ agentsConsent: true })

    await useCoachStore.getState().run({ harnessKind: 'claude', workspacePath: 'C:\\work', prompt: 'p' })

    expect(useCoachStore.getState().consentRequired).toBe(false)
    expect(startCoachRun).toHaveBeenCalledOnce()
  })

  it('grantConsent persists the opt-in and replays the held run', async () => {
    const startCoachRun = vi.fn(() => Promise.resolve({ ok: true, runId: 'run-9' }))
    const setAgentsConsent = vi.fn(() => Promise.resolve({ granted: true }))
    mockWindow({ startCoachRun, setAgentsConsent })
    useSettingsStore.setState({ agentsConsent: false })

    await useCoachStore.getState().run({ harnessKind: 'claude', workspacePath: 'C:\\work', prompt: 'p' })
    await useCoachStore.getState().grantConsent()

    expect(setAgentsConsent).toHaveBeenCalledWith(true)
    expect(useSettingsStore.getState().agentsConsent).toBe(true)
    expect(useCoachStore.getState().consentRequired).toBe(false)
    expect(useCoachStore.getState().pendingRun).toBeNull()
    expect(startCoachRun).toHaveBeenCalledOnce()
  })

  it('grantConsent with a failed write keeps the dialog up and never replays the held run', async () => {
    const startCoachRun = vi.fn(() => Promise.resolve({ ok: true, runId: 'run-9' }))
    mockWindow({ startCoachRun, setAgentsConsent: () => Promise.resolve({ granted: 'bogus' }) })
    useSettingsStore.setState({ agentsConsent: false })

    await useCoachStore.getState().run({ harnessKind: 'claude', workspacePath: 'C:\\work', prompt: 'p' })
    await useCoachStore.getState().grantConsent()

    const s = useCoachStore.getState()
    expect(useSettingsStore.getState().agentsConsent).toBe(false)
    expect(s.consentRequired).toBe(true)
    expect(s.pendingRun).toEqual({ harnessKind: 'claude', workspacePath: 'C:\\work', prompt: 'p' })
    expect(startCoachRun).not.toHaveBeenCalled()
  })

  it('a fresh run attempt clears a previous decline so the gate can ask again', async () => {
    mockWindow({ startCoachRun: () => Promise.resolve({ ok: true, runId: 'run-9' }) })
    useSettingsStore.setState({ agentsConsent: false })
    useCoachStore.setState({ consentDeclined: true })

    await useCoachStore.getState().run({ harnessKind: 'claude', workspacePath: 'C:\\work', prompt: 'p' })

    expect(useCoachStore.getState().consentRequired).toBe(true)
    expect(useCoachStore.getState().consentDeclined).toBe(false)
  })

  it('declineConsent refuses the held run and marks the offline/template mode', async () => {
    const startCoachRun = vi.fn(() => Promise.resolve({ ok: true, runId: 'run-9' }))
    mockWindow({ startCoachRun })
    useSettingsStore.setState({ agentsConsent: false })

    await useCoachStore.getState().run({ harnessKind: 'claude', workspacePath: 'C:\\work', prompt: 'p' })
    useCoachStore.getState().declineConsent()

    const s = useCoachStore.getState()
    expect(s.consentRequired).toBe(false)
    expect(s.pendingRun).toBeNull()
    expect(s.consentDeclined).toBe(true)
    expect(startCoachRun).not.toHaveBeenCalled()
  })

  it('resetSession clears a previous decline so the gate can ask again', () => {
    useCoachStore.setState({ consentDeclined: true })
    useCoachStore.getState().resetSession()
    expect(useCoachStore.getState().consentDeclined).toBe(false)
  })
})
