import { create } from 'zustand'
import { fetchCoachHarnesses, fetchCoachRun } from '@/shared/lib/api'
import type { CoachEventEnvelope, CoachHarnessRow } from '../../../../shared/schemas/agents.js'
import { useSettingsStore } from '@/features/settings/store'

/** Coach surface state (ticket 21): detected harnesses for the picker plus
 *  the active run's stream. The `coach:event` subscription feeds `onEvent`
 *  (ADR 0011); the surface reads the accumulated `text`/`tools`/`sessionId`
 *  instead of the raw stream. Pure at module load — `window` is only touched
 *  inside `cancel`, at call time. */
export interface CoachState {
  hydrated: boolean
  harnesses: CoachHarnessRow[]
  /** A run is in flight (acked, not yet done/errored). */
  running: boolean
  /** The runId of the active run — the cancel + event-routing key. */
  activeRunId: string | null
  /** Accumulated assistant text deltas of the active run. */
  text: string
  /** Tool-call notices of the active run, in order. */
  tools: string[]
  /** Resume handle from the run's session event (per-app-session, #45). */
  sessionId: string | null
  error: string | null
  /** Loads the detected harnesses for the picker (idempotent refresh). */
  loadHarnesses: () => Promise<void>
  /** Starts a harness run. The ack decides running; the streamed events then
   *  accumulate via onEvent. Returns once the ack lands (not the completion).
   *  The consent gate (ticket 22): an unconsented run is held as a pending
   *  run with `consentRequired: true` — the surface shows the dialog, and
   *  grant/decline decide whether it fires. */
  run: (input: { harnessKind: string; workspacePath: string; prompt: string; sessionId?: string }) => Promise<void>
  /** Interrupts the active run (fire-and-forget). Cancel is terminal on the
   *  renderer side: the main stops streaming but no `done` event follows a
   *  cancel, so the store clears its run state immediately. */
  cancel: () => void
  /** Starts a brand-new conversation: clears the resume handle and any
   *  leftover stream buffers (a follow-up turn just omits this). */
  resetSession: () => void
  /** A run was attempted while consent was off — the surface should show the
   *  opt-in dialog. Cleared by grant/decline. */
  consentRequired: boolean
  /** The run held behind the consent gate (replayed on grant). */
  pendingRun: { harnessKind: string; workspacePath: string; prompt: string; sessionId?: string } | null
  /** User chose "Not now" — the last run was refused; the section degrades to
   *  its offline/template mode rather than erroring (ADR 0012 addendum). */
  consentDeclined: boolean
  /** Persists the opt-in and replays the held run. */
  grantConsent: () => Promise<void>
  /** Refuses the held run and marks the offline/template mode. */
  declineConsent: () => void
  /** Applies one runId-enveloped CoachEvent to the accumulated state. */
  onEvent: (envelope: CoachEventEnvelope) => void
}

export const useCoachStore = create<CoachState>()((set, get) => ({
  hydrated: false,
  harnesses: [],
  running: false,
  activeRunId: null,
  text: '',
  tools: [],
  sessionId: null,
  error: null,
  consentRequired: false,
  pendingRun: null,
  consentDeclined: false,
  loadHarnesses: async () => {
    const result = await fetchCoachHarnesses()
    if (!result.ok) return
    set({ harnesses: result.data, hydrated: true })
  },
  run: async (input) => {
    // The consent gate (ticket 22): without the opt-in, the run never leaves
    // the renderer — it is held behind the dialog instead. (The main process
    // ALSO refuses unconsented runs; this is the UX side of the same gate.)
    if (!useSettingsStore.getState().agentsConsent) {
      set({ consentRequired: true, pendingRun: input, consentDeclined: false })
      return
    }
    await startRun(input)
  },
  grantConsent: async () => {
    await useSettingsStore.getState().setAgentsConsent(true)
    // Only persist cleared the gate? The write is main-confirmed; a failed IPC
    // leaves consent false — keep the dialog up and never replay the held run
    // into a refusal the user can't explain.
    if (!useSettingsStore.getState().agentsConsent) {
      return
    }
    const pending = get().pendingRun
    set({ consentRequired: false, pendingRun: null, consentDeclined: false })
    if (pending) await startRun(pending)
  },
  declineConsent: () => {
    set({ consentRequired: false, pendingRun: null, consentDeclined: true })
  },
  cancel: () => {
    const runId = get().activeRunId
    if (runId) window.api.cancelCoachRun(runId)
    // No done event follows a cancel — the main's pump just stops. Recover
    // the UI immediately instead of leaving the spinner spinning forever.
    set({ running: false, activeRunId: null })
  },
  resetSession: () => set({ sessionId: null, text: '', tools: [], error: null, consentDeclined: false }),
  onEvent: (envelope) => {
    // Stale-run guard: an event from a run other than the one in flight (a
    // cancelled or superseded run) must not pollute the active stream.
    const activeRunId = get().activeRunId
    if (activeRunId !== null && envelope.runId !== activeRunId) return
    const event = envelope.event
    switch (event.kind) {
      case 'status':
        set({ running: event.state !== 'done' })
        break
      case 'text':
        set(state => ({ text: state.text + event.delta }))
        break
      case 'tool':
        set(state => ({ tools: [...state.tools, event.tool] }))
        break
      case 'session':
        set({ sessionId: event.sessionId })
        break
      case 'error':
        set({ error: event.message, running: false })
        break
    }
  },
}))

type RunInput = { harnessKind: string; workspacePath: string; prompt: string; sessionId?: string }

/** The consent-checked run path shared by `run()` and `grantConsent()`'s
 *  replay. Assumes consent is granted; never consults the gate itself. */
async function startRun(input: RunInput): Promise<void> {
  const s = useCoachStore.getState()
  setRunPending()
  // Session resume (ADR/45): the stored handle from the last run's session
  // event is forwarded by default — the surface opts into it implicitly on
  // follow-up turns; a brand-new conversation clears it via resetSession.
  const sessionId = input.sessionId ?? s.sessionId
  const result = await fetchCoachRun({
    harnessKind: input.harnessKind,
    workspacePath: input.workspacePath,
    prompt: input.prompt,
    ...(sessionId ? { sessionId } : {}),
  })
  if (!result.ok) {
    setRunFailed(result.error)
    return
  }
  if (!result.data.ok) {
    setRunFailed(result.data.error)
    return
  }
  useCoachStore.setState({ activeRunId: result.data.runId })
}

function setRunPending(): void {
  useCoachStore.setState({ running: true, error: null, text: '', tools: [] })
}

function setRunFailed(error: string): void {
  useCoachStore.setState({ running: false, error })
}
