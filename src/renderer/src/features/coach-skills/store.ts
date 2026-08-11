import { create } from 'zustand'
import {
  fetchCoachHarnesses,
  fetchCoachRun,
  fetchDismissSkill,
  fetchPickCoachWorkspace,
  fetchSaveSkill,
  fetchSkills,
} from '@/shared/lib/api'
import { scopedDataSlice, type ScopedDataSlice } from '../../app/stores/data-store'
import { subscribeToRefresh } from '../../app/stores/scan-store'
import { useSettingsStore } from '@/features/settings/store'
import type { CoachEventEnvelope, CoachHarnessRow, CoachMode } from '../../../../shared/schemas/agents.js'
import type { SkillCandidate, SkillsPayload, SkillsSource } from '../../../../shared/schemas/skills.js'

/** One message in the unified Coach & Skills thread (ADR 0017). User turns
 *  carry the prompt/evidence tag; assistant turns accumulate streamed text
 *  and tool notices live via `onEvent`, and a completed build-skill turn
 *  carries its draft card (candidate + harness markdown). */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  /** User prompt — or, for a build-skill turn, the candidate name. */
  content: string
  /** Mode tag the turn ran under (ADR 0017). */
  mode: CoachMode
  /** Assistant tool-call notices, in order. */
  tools: string[]
  /** Build-skill completion: the detected candidate + the harness-authored
   *  markdown. Set once the run's `done` event lands (never mid-stream). */
  draft?: { candidate: SkillCandidate; markdown: string }
  /** Assistant turn failed (ack error, stream error, or cancelled). */
  error?: string
  /** Whether the turn is still streaming. */
  streaming: boolean
}

/** The unified Coach & Skills state (ADR 0017): the message-model chat
 *  surface. Runs are mode-tagged — `coach` streams the user's prompt; a
 *  `build-skill` run carries a detected candidate and the MAIN process builds
 *  the authoring prompt from its normalized evidence. Session resume flows
 *  only on coach turns (each build-skill run is a fresh one-shot). */
export interface CoachSkillsState {
  /** Harnesses detected on the host, for the picker. */
  hydrated: boolean
  harnesses: CoachHarnessRow[]
  /** The selected harness registry key (null until the user picks one). */
  harnessKind: string | null
  /** The user-selected run workspace (OS directory picker). */
  workspacePath: string | null
  /** The mode tag for the NEXT run. */
  mode: CoachMode
  /** The conversation thread. */
  messages: ChatMessage[]
  /** A run is in flight (acked, not yet done/errored). */
  running: boolean
  /** The active run's id — the cancel + event-routing key. */
  activeRunId: string | null
  /** Resume handle from the last coach run's session event. */
  sessionId: string | null
  error: string | null
  /** The scoped detection payload — the build-skill candidate pool. */
  detection: ScopedDataSlice<SkillsPayload>
  /** Loads the detected harnesses for the picker (idempotent refresh). */
  loadHarnesses: () => Promise<void>
  /** Persists the picker choice. */
  setHarness: (kind: string) => void
  /** Opens the OS directory picker for the run workspace. */
  pickWorkspace: () => Promise<void>
  /** Sets the mode tag for the next run. */
  setMode: (mode: CoachMode) => void
  /** Starts a coach run with a free-form prompt (session-resuming). */
  sendCoach: (prompt: string) => Promise<void>
  /** Starts a build-skill run for a detected candidate (one-shot, evidence
   *  only — the prompt is built main-side). */
  sendBuildSkill: (candidate: SkillCandidate) => Promise<void>
  /** Interrupts the active run (fire-and-forget; cancel is terminal). */
  cancel: () => void
  /** Starts a brand-new conversation: clears messages + the resume handle. */
  resetSession: () => void
  /** Applies one runId-enveloped CoachEvent to the active turn. */
  onEvent: (envelope: CoachEventEnvelope) => void
  /** Not-a-skill signal: dismiss a pattern so the detector filters it out. */
  dismiss: (source: SkillsSource, name: string, reason: string) => Promise<void>
}

let messageSeq = 0
function nextMessageId(): string {
  messageSeq += 1
  return `m${messageSeq}`
}

/** A ready-to-spread empty assistant turn for the thread. A build-skill turn
 *  is born with its draft card's candidate already attached, so the `done`
 *  event can fill in the harness markdown (ADR 0017). */
function emptyAssistant(mode: CoachMode, candidate?: SkillCandidate): ChatMessage {
  return {
    id: nextMessageId(),
    role: 'assistant',
    content: '',
    mode,
    tools: [],
    streaming: true,
    ...(candidate ? { draft: { candidate, markdown: '' } } : {}),
  }
}

export const useCoachSkillsStore = create<CoachSkillsState>()((set, get) => ({
  hydrated: false,
  harnesses: [],
  harnessKind: null,
  workspacePath: null,
  mode: 'coach',
  messages: [],
  running: false,
  activeRunId: null,
  sessionId: null,
  error: null,
  detection: scopedDataSlice<SkillsPayload>(
    scope => fetchSkills(scope, {
      frequency: useSettingsStore.getState().skillsFrequency,
      spread: useSettingsStore.getState().skillsSpread,
    }),
    patch => set(state => ({ detection: { ...state.detection, ...patch } })),
    () => get().detection,
  ),
  loadHarnesses: async () => {
    const result = await fetchCoachHarnesses()
    if (!result.ok) return
    const harnesses = result.data
    set({ harnesses, hydrated: true })
    // Auto-select the first configured harness — the picker still lets the
    // user change it, but the first run should never sit behind a "pick a
    // harness" wall.
    const current = get().harnessKind
    if (!current || !harnesses.some(h => h.kind === current)) {
      set({ harnessKind: harnesses[0]?.kind ?? null })
    }
  },
  setHarness: (harnessKind) => set({ harnessKind }),
  pickWorkspace: async () => {
    const result = await fetchPickCoachWorkspace()
    if (result.ok && result.data.ok) set({ workspacePath: result.data.path })
  },
  setMode: (mode) => set({ mode }),
  sendCoach: async (prompt) => {
    const s = get()
    if (s.running) return
    const trimmed = prompt.trim()
    if (!trimmed) return
    await startRun({
      mode: 'coach',
      userContent: trimmed,
      prompt: trimmed,
      resume: true,
    })
  },
  sendBuildSkill: async (candidate) => {
    const s = get()
    if (s.running) return
    await startRun({
      mode: 'build-skill',
      userContent: candidate.name,
      candidate,
      evidence: {
        source: candidate.source,
        name: candidate.name,
        frequency: candidate.frequency,
        spreadSessions: candidate.spreadSessions,
        spreadProjects: candidate.spreadProjects,
        costUSD: candidate.costUSD,
        turns: candidate.turns,
      },
      // Each build-skill run is a fresh one-shot — never resumes.
      resume: false,
    })
  },
  cancel: () => {
    const runId = get().activeRunId
    if (runId) window.api.cancelCoachRun(runId)
    // No done event follows a cancel — the main's pump just stops. Mark the
    // streaming turn as errored/cancelled so the thread never hangs.
    set(state => ({
      running: false,
      activeRunId: null,
      messages: state.messages.map(message =>
        message.streaming ? { ...message, streaming: false, error: 'cancelled' } : message),
    }))
  },
  resetSession: () => set({ messages: [], sessionId: null, error: null }),
  onEvent: (envelope) => {
    // Stale-run guard: only the ACTIVE run's events may touch the thread.
    // While a run is pending (ack in flight, activeRunId null) events are
    // dropped entirely — a straggler from a cancelled run arriving in that
    // window must not pollute the next turn, and the fresh run's own events
    // cannot arrive before its ack sets the active id (the main pumps only
    // after the ack).
    const activeRunId = get().activeRunId
    if (activeRunId === null || envelope.runId !== activeRunId) return
    const event = envelope.event
    switch (event.kind) {
      case 'status':
        if (event.state === 'done') {
          // Finalize the active turn: attach the draft card for a build-skill
          // run (the accumulated text IS the harness markdown).
          set(state => {
            const messages = state.messages.map(message => {
              if (!message.streaming) return message
              if (message.mode === 'build-skill' && message.draft) {
                return { ...message, streaming: false, draft: { ...message.draft, markdown: message.content } }
              }
              return { ...message, streaming: false }
            })
            return { running: false, activeRunId: null, messages }
          })
        } else {
          // 'starting' | 'running' — the run is in flight.
          set({ running: true })
        }
        break
      case 'text':
        set(state => ({
          messages: state.messages.map(message =>
            message.streaming ? { ...message, content: message.content + event.delta } : message),
        }))
        break
      case 'tool':
        set(state => ({
          messages: state.messages.map(message =>
            message.streaming ? { ...message, tools: [...message.tools, event.tool] } : message),
        }))
        break
      case 'session':
        set({ sessionId: event.sessionId })
        break
      case 'error':
        set(state => ({
          running: false,
          activeRunId: null,
          messages: state.messages.map(message =>
            message.streaming ? { ...message, streaming: false, error: event.message } : message),
        }))
        break
    }
  },
  dismiss: async (source, name, reason) => {
    const result = await fetchDismissSkill({ source, name, reason })
    if (result.ok && result.data.ok) {
      void get().detection.reload()
    }
  },
}))

/** The one run path shared by sendCoach / sendBuildSkill. Builds the user turn
 *  + streaming assistant turn, acks the run, and arms event routing. */
async function startRun(input: {
  mode: CoachMode
  userContent: string
  /** The build-skill candidate — seeds the assistant turn's draft card. */
  candidate?: SkillCandidate
  prompt?: string
  evidence?: Parameters<typeof fetchCoachRun>[0]['evidence']
  resume: boolean
}): Promise<void> {
  const s = useCoachSkillsStore.getState()
  if (!s.harnessKind || !s.workspacePath) {
    setRunFailed('select a harness and a workspace first')
    return
  }
  const userMessage: ChatMessage = { id: nextMessageId(), role: 'user', content: input.userContent, mode: input.mode, tools: [], streaming: false }
  const assistantMessage = emptyAssistant(input.mode, input.candidate)
  setRunPending(userMessage, assistantMessage)

  const sessionId = input.resume ? s.sessionId : undefined
  const result = await fetchCoachRun({
    harnessKind: s.harnessKind,
    workspacePath: s.workspacePath,
    mode: input.mode,
    ...(input.prompt ? { prompt: input.prompt } : {}),
    ...(input.evidence ? { evidence: input.evidence } : {}),
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
  useCoachSkillsStore.setState({ activeRunId: result.data.runId })
}

function setRunPending(userMessage: ChatMessage, assistantMessage: ChatMessage): void {
  useCoachSkillsStore.setState(state => ({
    running: true,
    error: null,
    activeRunId: null,
    messages: [...state.messages, userMessage, assistantMessage],
  }))
}

function setRunFailed(error: string): void {
  useCoachSkillsStore.setState(state => ({
    running: false,
    error,
    messages: state.messages.map(message =>
      message.streaming ? { ...message, streaming: false, error } : message),
  }))
}

subscribeToRefresh(() => {
  void useCoachSkillsStore.getState().detection.reload()
})

/** Refetch the detection pool whenever the detection gate changes in
 *  Settings › Skills — tuning the thresholds must repaint the build-skill
 *  candidate pool without a manual refresh. */
let lastThresholdKey = ''
function watchThresholds(): void {
  const state = useSettingsStore.getState()
  const key = `${state.skillsFrequency}\0${state.skillsSpread}`
  if (key !== lastThresholdKey) {
    lastThresholdKey = key
    void useCoachSkillsStore.getState().detection.reload()
  }
}

useSettingsStore.subscribe(watchThresholds)

/** Save a draft card via the OS save dialog (user-initiated write). */
export async function saveDraftCard(name: string, content: string): Promise<string | null> {
  const result = await fetchSaveSkill({ name, content })
  if (!result.ok) return result.error
  if (!result.data.ok) return result.data.error
  return null
}
