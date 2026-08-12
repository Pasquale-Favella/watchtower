import { create } from 'zustand'
import {
  fetchCoachHarnesses,
  fetchCoachInspect,
  fetchCoachRun,
  fetchDismissSkill,
  fetchSaveSkill,
  fetchSkills,
} from '@/shared/lib/api'
import { selectScope, useScopeStore } from '@/app/stores/scope-store'
import { scopedDataSlice, type ScopedDataSlice } from '../../app/stores/data-store'
import { subscribeToRefresh } from '../../app/stores/scan-store'
import { useSettingsStore } from '@/features/settings/store'
import { looksLikeSkillMarkdown } from '@/features/coach-skills/lib'
import type {
  CoachEventEnvelope,
  CoachHarnessRow,
  CoachMode,
  CoachSessionModels,
  CoachSessionModes,
} from '../../../../shared/schemas/agents.js'
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
  /** Completed-skill draft: the detected candidate (build-skill run) + the
   *  harness markdown. Attached at the `done` event — for a build-skill run
   *  the candidate was seeded at spawn (never mid-stream); for a coach run it
   *  is attached on completion when the finished text looks like a SKILL.md. */
  draft?: { candidate?: SkillCandidate; markdown: string }
  /** Assistant turn failed (ack error, stream error, or cancelled). */
  error?: string
  /** Whether the turn is still streaming. */
  streaming: boolean
}

/** The unified Coach & Skills state (ADR 0017, conversation prototype map 58):
 *  the message-model chat surface. Every run is part of ONE conversation that
 *  resumes (sessionId). Runs are mode-tagged at spawn — `coach` streams the
 *  user's prompt; a `build-skill` run (seeded by clicking a detected pattern)
 *  carries a detected candidate and the MAIN process builds the authoring
 *  prompt from its normalized evidence, surfacing the result as a mid-thread
 *  draft card. A coach turn whose finished text is a completed SKILL.md gets
 *  the same card. There is no separate next-run mode: `build-skill` is invoked
 *  directly from the pattern chips. */
export interface CoachSkillsState {
  /** Harnesses detected on the host, for the picker. */
  hydrated: boolean
  harnesses: CoachHarnessRow[]
  /** The selected harness registry key (null until the user picks one). */
  harnessKind: string | null
  /** Agent-declared selectable models, from the last session event or the
   *  pre-flight probe (map 47 ticket 50). Absent until a harness reports them
   *  — the progressive picker only renders when this exists. */
  sessionModels: CoachSessionModels | null
  /** Agent-declared selectable modes, from the last session event or the
   *  pre-flight probe. */
  sessionModes: CoachSessionModes | null
  /** The harness kind whose pre-flight probe is in flight (null when none) —
   *  drives the composer's loading pill and the probe's stale-result guard.
   *  Latest-wins: a newer probe supersedes any in-flight one. */
  inspectingKind: string | null
  /** Harness kinds whose probe SUCCEEDED but declared no selectable models —
   *  opening the model picker for them must not re-spawn the agent (nothing
   *  would come back). Loaded sets (sessionModels) are guarded separately; a
   *  FAILED probe is never cached, so the next open retries an unavailable
   *  agent. Persists across harness switches and resets — capabilities are
   *  stable for the session. */
  probedEmptyKinds: string[]
  /** The user's model choice for the next run (from the reported set). */
  modelId: string | null
  /** The user's mode choice for the next run (from the reported set). */
  modeId: string | null
  /** The conversation thread. */
  messages: ChatMessage[]
  /** A run is in flight (acked, not yet done/errored). */
  running: boolean
  /** The active run's id — the cancel + event-routing key. */
  activeRunId: string | null
  /** Events that arrived before their run's ack landed (the main pumps as
   *  soon as it acks — a fast failure can beat the ack round-trip). Buffered
   *  by runId and replayed when the ack sets the active id, so a fast error
   *  surfaces instead of silently leaving the turn hanging. */
  pendingEvents: Record<string, CoachEventEnvelope[]>
  /** Resume handle from the last run's session event. */
  sessionId: string | null
  error: string | null
  /** The scoped detection payload — the pattern pool for the craft chips. */
  detection: ScopedDataSlice<SkillsPayload>
  /** Loads the detected harnesses for the picker (idempotent refresh). */
  loadHarnesses: () => Promise<void>
  /** Persists the picker choice. */
  setHarness: (kind: string) => void
  /** Pre-flight probe (map 47 ticket 50): asks the harness's handshake for
   *  its declared models/modes WITHOUT a run, so the pickers render before
   *  the first message. Latest-wins + stale-guarded on the current harness;
   *  a failed probe (unavailable agent, auth wall) just leaves the pickers
   *  absent — the first run surfaces the real error. */
  inspectHarness: (kind: string) => Promise<void>
  /** Sets the user's model choice for the next run (null = agent default). */
  setModelId: (modelId: string | null) => void
  /** Sets the user's mode choice for the next run (null = agent default). */
  setModeId: (modeId: string | null) => void
  /** Starts a coach run with a free-form prompt (session-resuming). */
  sendCoach: (prompt: string) => Promise<void>
  /** Starts a build-skill run for a detected candidate (conversation-resuming,
   *  evidence only — the prompt is built main-side). */
  sendBuildSkill: (candidate: SkillCandidate) => Promise<void>
  /** Interrupts the active run (fire-and-forget; cancel is terminal). */
  cancel: () => void
  /** Starts a brand-new conversation: clears messages + the resume handle and
   *  tells the main process to delete the old conversation's temp workspace
   *  (map 53). */
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
 *  event can fill in the harness markdown (ADR 0017); a coach turn starts
 *  bare and may earn a draft card on completion if its text is a SKILL.md. */
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
  sessionModels: null,
  sessionModes: null,
  inspectingKind: null,
  probedEmptyKinds: [],
  modelId: null,
  modeId: null,
  messages: [],
  running: false,
  activeRunId: null,
  pendingEvents: {},
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
    const next = current && harnesses.some(h => h.kind === current) ? current : harnesses[0]?.kind ?? null
    set({ harnessKind: next })
    // Hybrid warm start: ONLY the auto-selected harness is probed eagerly —
    // it warms a session the first run resumes and pre-populates the model
    // picker without an open. Manual harness switches stay lazy (probe on
    // picker open), and an idempotent refresh that keeps the same selection
    // skips it entirely (re-probing would spawn the agent needlessly).
    if (next && next !== current) void get().inspectHarness(next)
  },
  setHarness: (harnessKind) => {
    set({
      harnessKind,
      // A different harness is a different agent — its selectable set (and the
      // user's choices against the previous agent) do not carry over. The
      // next picker open re-probes the new agent lazily.
      sessionModels: null,
      sessionModes: null,
      modelId: null,
      modeId: null,
    })
  },
  inspectHarness: async (kind) => {
    // Lazy probe (map 47 ticket 50): called when the model picker opens —
    // and, for the auto-selected harness only, eagerly on load (hybrid warm
    // start). The probe ALSO warms a session the conversation's first run
    // can resume (no double cold-start).
    // Latest-wins: record the probed kind so the composer can show a loading
    // state and a superseded probe (a harness switched mid-flight) is
    // dropped. A probe for this exact kind is already in flight — its result
    // applies when it lands, so skip the redundant round-trip (the main
    // process also coalesces concurrent probes into one spawn slot).
    if (get().inspectingKind === kind) return
    // A previous SUCCESSFUL probe declared no selectable models for this
    // agent — re-opening must not re-spawn it (nothing would come back).
    if (get().probedEmptyKinds.includes(kind)) return
    // Already loaded for the current harness (a prior open, or a run's
    // session event) — opening the picker is just browsing the existing set.
    if (get().harnessKind === kind && get().sessionModels) return
    set({ inspectingKind: kind })
    const result = await fetchCoachInspect(kind)
    set(state => (state.inspectingKind === kind ? { inspectingKind: null } : state))
    if (!result.ok || !result.data.ok) return
    // The probe answers for the agent that was selected when it STARTED — if
    // the user has since switched harness, its declared set does not apply.
    if (get().harnessKind !== kind) return
    const { models, modes } = result.data
    set(state => ({
      sessionModels: models ?? state.sessionModels,
      sessionModes: modes ?? state.sessionModes,
      modelId: state.modelId ?? (models?.currentModelId ?? null),
      modeId: state.modeId ?? (modes?.currentModeId ?? null),
      // A SUCCESSFUL probe that declared no models is cached — the loaded
      // guard above covers the models case, so this only ever fires for the
      // empty set (the guard also makes a duplicate impossible). A FAILED
      // probe never lands here, so an unavailable agent is still retried on
      // the next open. A later run's session event invalidates the marker.
      ...(models ? {} : { probedEmptyKinds: [...state.probedEmptyKinds, kind] }),
    }))
  },
  setModelId: (modelId) => set({ modelId }),
  setModeId: (modeId) => set({ modeId }),
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
      // A build-skill run is part of the ONE conversation (map 58): it resumes
      // the session like a coach turn, so the user can iterate on the draft.
      resume: true,
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
      pendingEvents: {},
      messages: state.messages.map(message =>
        message.streaming ? { ...message, streaming: false, error: 'cancelled' } : message),
    }))
  },
  resetSession: () => {
    // A brand-new conversation: the main process cancels active runs and
    // deletes the old conversation's temp workspace (map 53).
    window.api.resetCoachWorkspace()
    set({
      messages: [],
      sessionId: null,
      error: null,
      pendingEvents: {},
      // The session is gone — so is the agent's selectable set and the
      // user's choices against it. The picker re-probes lazily on its next
      // open.
      sessionModels: null,
      sessionModes: null,
      modelId: null,
      modeId: null,
    })
  },
  onEvent: (envelope) => {
    const activeRunId = get().activeRunId
    // A run is pending (ack in flight): the main acks, THEN pumps — but a
    // fast failure (spawn error, auth wall) can emit before the ack's
    // round-trip lands here. Buffer by runId and replay on ack; a straggler
    // from a cancelled run parks under its OWN runId and never matches the
    // next ack, so it can't pollute the fresh turn.
    if (activeRunId === null) {
      const parked = get().pendingEvents[envelope.runId] ?? []
      set({ pendingEvents: { ...get().pendingEvents, [envelope.runId]: [...parked, envelope] } })
      return
    }
    // Stale-run guard: only the ACTIVE run's events may touch the thread.
    if (envelope.runId !== activeRunId) return
    const event = envelope.event
    switch (event.kind) {
      case 'status':
        if (event.state === 'done') {
          // Finalize the active turn: attach the draft card — for a build-skill
          // run it was seeded with its candidate at spawn (the accumulated text
          // IS the harness markdown); for a coach run it is attached when the
          // finished text looks like a completed SKILL.md.
          set(state => {
            const messages = state.messages.map(message => {
              if (!message.streaming) return message
              if (message.mode === 'build-skill' && message.draft) {
                return { ...message, streaming: false, draft: { ...message.draft, markdown: message.content } }
              }
              if (message.mode === 'coach' && looksLikeSkillMarkdown(message.content)) {
                return { ...message, streaming: false, draft: { markdown: message.content } }
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
        // The handshake may carry agent-declared models/modes — that is the
        // ONLY source for the progressive picker (map 47 ticket 50). The
        // session event lands on EVERY run, so an absent field just means the
        // agent did not re-declare it this run — the previous declaration
        // stays valid (a harness switch or reset clears it explicitly).
        set(state => ({
          sessionId: event.sessionId,
          sessionModels: event.models ?? state.sessionModels,
          sessionModes: event.modes ?? state.sessionModes,
          modelId: state.modelId ?? (event.models?.currentModelId ?? null),
          modeId: state.modeId ?? (event.modes?.currentModeId ?? null),
          // A run's LIVE declaration overrides a stale empty-probe cache: a
          // probe handshake may report no models where the run's handshake
          // does (the probe runs without the ledger MCP server), so once a
          // run proves the agent has models, the "no models" marker for the
          // current harness is invalid.
          ...(event.models
            ? { probedEmptyKinds: state.probedEmptyKinds.filter(k => k !== state.harnessKind) }
            : {}),
        }))
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
  if (!s.harnessKind) {
    setRunFailed('select a harness first')
    return
  }
  const userMessage: ChatMessage = { id: nextMessageId(), role: 'user', content: input.userContent, mode: input.mode, tools: [], streaming: false }
  const assistantMessage = emptyAssistant(input.mode, input.candidate)
  setRunPending(userMessage, assistantMessage)

  const sessionId = input.resume ? s.sessionId : undefined
  const result = await fetchCoachRun({
    harnessKind: s.harnessKind,
    mode: input.mode,
    // The conversation's UI-scope snapshot (map 53): no longer baked into the
    // MCP server (it serves the full lifetime ledger) — it rides the first-run
    // briefing as the suggested default window for the agent's queries.
    scope: selectScope(useScopeStore.getState()),
    ...(input.prompt ? { prompt: input.prompt } : {}),
    ...(input.evidence ? { evidence: input.evidence } : {}),
    // Progressive model/mode selection (map 47 ticket 50): forward the user's
    // choices ONLY when the agent declared that set (null = agent default).
    ...(s.sessionModels ? { modelId: s.modelId ?? undefined } : {}),
    ...(s.sessionModes ? { modeId: s.modeId ?? undefined } : {}),
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
  const runId = result.data.runId
  useCoachSkillsStore.setState({ activeRunId: runId })
  // Replay any events that streamed before the ack round-trip landed (a fast
  // failure must surface, not hang the turn). Only this run's parked events
  // replay; stragglers under other runIds stay parked and are cleared on the
  // next run.
  const parked = useCoachSkillsStore.getState().pendingEvents[runId]
  if (parked) {
    useCoachSkillsStore.setState(state => ({
      pendingEvents: Object.fromEntries(
        Object.entries(state.pendingEvents).filter(([id]) => id !== runId),
      ),
    }))
    for (const envelope of parked) useCoachSkillsStore.getState().onEvent(envelope)
  }
}

function setRunPending(userMessage: ChatMessage, assistantMessage: ChatMessage): void {
  useCoachSkillsStore.setState(state => ({
    running: true,
    error: null,
    activeRunId: null,
    // A new run's pending window starts clean: parked stragglers from a
    // cancelled/previous run must not replay into the fresh turn.
    pendingEvents: {},
    messages: [...state.messages, userMessage, assistantMessage],
  }))
}

function setRunFailed(error: string): void {
  useCoachSkillsStore.setState(state => ({
    running: false,
    error,
    pendingEvents: {},
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
