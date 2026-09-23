import { create } from 'zustand'
import {
  fetchCoachHarnesses,
  fetchCoachInspect,
  fetchCoachRun,
  fetchSkills,
  refreshCoachHarnesses,
} from '@/shared/lib/api'
import { selectScope, useScopeStore } from '@/app/stores/scope-store'
import { scopedDataSlice, type ScopedDataSlice } from '../../app/stores/data-store'
import { subscribeToRefresh } from '../../app/stores/scan-store'
import { useSettingsStore } from '@/features/settings/store'
import type {
  CoachEventEnvelope,
  CoachHarnessRow,
  CoachSessionModels,
  CoachSessionModes,
} from '../../../../shared/schemas/agents.js'
import type { SkillsPayload } from '../../../../shared/schemas/skills.js'

/** One tool-call notice on a streaming assistant turn — the lifecycle of a
 *  single agent tool call, in the order it was announced. `started` opens the
 *  notice; the matching `completed`/`error` closes it (id-paired when the
 *  harness attached one). Input/output are truncated JSON previews the seam
 *  ships — enough to render a Tool-card-style activity panel without raw
 *  payloads crossing IPC. */
export interface ToolNotice {
  /** The tool call id — pairs the started notice with its completion. */
  id?: string
  /** The tool name (e.g. Bash, Read, Edit). */
  tool: string
  /** Optional human-readable title the harness attached to the call. */
  title?: string
  /** Lifecycle state: started while executing, completed/error once it ends. */
  state: 'started' | 'completed' | 'error'
  /** Truncated JSON preview of the call's input arguments. */
  input?: string
  /** Truncated JSON preview of the call's result output. */
  output?: string
  /** Truncated error message when the call failed (state 'error'). */
  error?: string
}

/** One message in the unified Coach thread (ADR 0017). User turns carry the
 *  prompt; assistant turns accumulate streamed text, thinking/reasoning text,
 *  and tool-call notices live via `onEvent`. The run-context snapshot
 *  (`meta`) is captured at spawn so every bubble can show the harness/model/
 *  mode it actually ran under. */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  /** The user prompt. */
  content: string
  /** Accumulated thinking/reasoning text, streamed before the answer. */
  thinking: string
  /** Assistant tool-call notices, in order, with their lifecycle state. */
  tools: ToolNotice[]
  /** Informational notices emitted during this run. */
  notices: string[]
  /** Run context captured at spawn: harness/model/mode labels the bubble can
   *  show. `model`/`mode` are the agent-declared picks sent with the run. */
  meta?: { harness?: string; model?: string; mode?: string }
  /** Assistant turn failed (ack error, stream error, or cancelled). */
  error?: string
  /** Whether the turn is still streaming. */
  streaming: boolean
}

/** The per-harness model cache (optimization): what a successful pre-flight
 *  probe — or a run's session event — declared for a harness kind, PLUS the
 *  user's model/mode picks against it. `models`/`modes` are null when the
 *  probe succeeded but the agent declared nothing selectable; the kind is
 *  still cached so re-opening never re-spawns the agent. A FAILED probe is
 *  never cached, so an unavailable agent is retried on the next open. Agent
 *  capabilities are stable for the session, so the cache survives harness
 *  switches and conversation resets — switching back to a probed harness
 *  restores its set (and the user's picks for it) instantly, with no reload. */
export interface CoachKindCache {
  models: CoachSessionModels | null
  modes: CoachSessionModes | null
  /** The user's pick for this harness (null = agent default). */
  modelId: string | null
  modeId: string | null
}

/** The unified Coach state (ADR 0017, conversation prototype map 58): the
 *  message-model chat surface. Every run is part of ONE conversation that
 *  resumes (resumeCursor). There is ONE kind of run — a free-form prompt the
 *  harness answers in either of its two scopes (coaching analysis or skill
 *  authoring); the separate build-skill mode was deleted. */
export interface CoachSkillsState {
  /** Harnesses detected on the host, for the picker. */
  hydrated: boolean
  harnesses: CoachHarnessRow[]
  /** The selected harness registry key (null until the user picks one). */
  harnessKind: string | null
  /** The selection is the store's default pick, not the user's. */
  harnessAutoPicked: boolean
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
  /** The per-harness probe cache (see CoachKindCache): a probed kind never
   *  re-spawns the agent — switching to it restores the declared set and the
   *  user's picks from memory. The current harness's set always mirrors its
   *  cache entry (setHarness restores it; inspect/session events refresh it). */
  modelsByKind: Record<string, CoachKindCache>
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
  /** Opaque resume handle from the last run's session event. */
  resumeCursor: string | null
  /** The assistant message owned by each run, retained for late events. */
  runMessageIds: Record<string, string>
  error: string | null
  /** The scoped detection payload — the pattern pool behind the WELCOME
   *  SCREEN's suggested-skill chips only. The chips are chat-starters: each
   *  one sends a normal coach prompt to craft a SKILL.md (no build-skill
   *  mode, no draft card). There is no dismiss flow here — the detector's
   *  not-a-skill signal lives in the ledger store, not the chat. */
  detection: ScopedDataSlice<SkillsPayload>
  /** Loads the detected harnesses for the picker (idempotent refresh). */
  loadHarnesses: () => Promise<void>
  /** Re-checks detected harnesses and applies the returned managed snapshot. */
  refreshHarnesses: () => Promise<void>
  /** Applies a live managed snapshot broadcast without spawning a probe. */
  replaceHarnesses: (harnesses: CoachHarnessRow[]) => void
  /** Persists the picker choice. Restores the target harness's cached set
   *  (and picks) instantly when it has been probed before; otherwise clears
   *  the live set and probes the new harness eagerly. */
  setHarness: (kind: string) => void
  /** Pre-flight probe (map 47 ticket 50): asks the harness's handshake for
   *  its declared models/modes WITHOUT a run, so the pickers render before
   *  the first message. Latest-wins + stale-guarded on the current harness;
   *  a failed probe (unavailable agent, auth wall) just leaves the pickers
   *  absent — the first run surfaces the real error. Results are cached per
   *  harness kind, so a later switch-back restores them without a reload. */
  inspectHarness: (kind: string) => Promise<void>
  /** Sets the user's model choice for the next run (null = agent default). */
  setModelId: (modelId: string | null) => void
  /** Sets the user's mode choice for the next run (null = agent default). */
  setModeId: (modeId: string | null) => void
  /** Starts a coach run with a free-form prompt (session-resuming). */
  sendCoach: (prompt: string) => Promise<void>
  /** Regenerates the LAST assistant turn in place: re-runs the same prompt
   *  and replaces the old answer with the fresh streaming turn. The user
   *  message stays — no duplicate turn. Refused while a run is in flight or
   *  for any non-last / non-assistant message. */
  retryAssistant: (messageId: string) => Promise<void>
  /** Interrupts the active run (fire-and-forget; cancel is terminal). */
  cancel: () => void
  /** Starts a brand-new conversation: clears messages + the resume handle and
   *  tells the main process to delete the old conversation's temp workspace
   *  (map 53). The current harness's cached set and picks are restored from
   *  the per-kind cache — agent capabilities survive a reset. */
  resetSession: () => void
  /** Applies one runId-enveloped CoachEvent to the active turn. */
  onEvent: (envelope: CoachEventEnvelope) => void
}

let messageSeq = 0
function nextMessageId(): string {
  messageSeq += 1
  return `m${messageSeq}`
}

/** Default instance: first ready, else first warning/pending — never an errored one. */
function defaultHarnessId(harnesses: CoachHarnessRow[]): string | null {
  return harnesses.find(h => h.status === 'ready')?.instanceId
    ?? harnesses.find(h => h.status === 'warning' || h.status === 'pending')?.instanceId
    ?? null
}

/** A ready-to-spread empty assistant turn for the thread. The run context
 *  (`meta`) is snapshotted at spawn — harness label plus the agent-declared
 *  model/mode the user picked — so the bubble can show what actually ran even
 *  after the picker changes. */
function emptyAssistant(): ChatMessage {
  // Runtime snapshot: only ever called from startRun, long after the store
  // below is created — never during module init (avoids the TDZ).
  const s = useCoachSkillsStore.getState()
  const harness = s.harnesses.find(h => h.instanceId === s.harnessKind)
  const model = s.sessionModels?.availableModels.find(m => m.modelId === s.modelId)
  const smode = s.sessionModes?.availableModes.find(m => m.id === s.modeId)
  const meta: ChatMessage['meta'] = {
    ...(harness ? { harness: harness.displayName } : {}),
    ...(model ? { model: model.name } : {}),
    ...(smode ? { mode: smode.name } : {}),
  }
  return {
    id: nextMessageId(),
    role: 'assistant',
    content: '',
    thinking: '',
    tools: [],
    notices: [],
    meta: Object.keys(meta).length > 0 ? meta : undefined,
    streaming: true,
  }
}

export const useCoachSkillsStore = create<CoachSkillsState>()((set, get) => ({
  hydrated: false,
  harnesses: [],
  harnessKind: null,
  harnessAutoPicked: false,
  sessionModels: null,
  sessionModes: null,
  inspectingKind: null,
  modelsByKind: {},
  modelId: null,
  modeId: null,
  messages: [],
  running: false,
  activeRunId: null,
  pendingEvents: {},
  resumeCursor: null,
  runMessageIds: {},
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
    get().replaceHarnesses(result.data)
  },
  refreshHarnesses: async () => {
    const result = await refreshCoachHarnesses()
    if (!result.ok) return
    get().replaceHarnesses(result.data)
  },
  replaceHarnesses: (harnesses) => {
    const { harnessKind: current, harnessAutoPicked, messages } = get()
    const currentRow = current ? harnesses.find(h => h.instanceId === current) : undefined
    // An auto-pick is re-evaluated as probes land, until the user picks or chats.
    const keep = !!currentRow && !(harnessAutoPicked && messages.length === 0 && currentRow.status !== 'ready')
    const next = keep ? current : defaultHarnessId(harnesses)
    set({ harnesses, hydrated: true })
    if (next && next !== current) {
      // setHarness first so it snapshots the outgoing harness's live picks;
      // resetSession then stops any in-flight run of the vanished harness.
      get().setHarness(next)
      set({ harnessAutoPicked: true })
      if (current && messages.length > 0) get().resetSession()
      // Hybrid warm-start (pre-#145): probe the auto-picked harness so its
      // models populate without opening the picker. Guarded/cached inside
      // inspectHarness, so a repeated snapshot never re-spawns.
      void get().inspectHarness(next)
    } else {
      set({
        harnessKind: next,
        ...(next ? {} : { sessionModels: null, sessionModes: null, modelId: null, modeId: null }),
      })
      // Still auto-picked with no conversation (e.g. pending -> ready as
      // managed probes land): warm-start the unprobed pick.
      if (next && harnessAutoPicked && messages.length === 0 && !get().modelsByKind[next]) {
        void get().inspectHarness(next)
      }
    }
  },
  setHarness: (harnessKind) => {
    const s = get()
    const previous = s.harnessKind
    // Remember the OUTGOING harness's current picks against its cached set —
    // the set itself is already cached by its probe/session events, but the
    // user's live choices may have changed since. Only when the kind has an
    // entry: a never-probed kind must not be marked cached (its next probe
    // can still fail and must be retried).
    const modelsByKind = previous && previous !== harnessKind && s.modelsByKind[previous]
      ? { ...s.modelsByKind, [previous]: { ...s.modelsByKind[previous], modelId: s.modelId, modeId: s.modeId } }
      : s.modelsByKind
    // A previously probed harness restores its declared set + the user's
    // picks INSTANTLY. An uncached harness starts clean; the picker triggers
    // its lazy inspect when opened or hovered. The auto-pick warm-start lives
    // in replaceHarnesses (probes the default pick on load), not here, so a
    // manual switch stays lazy.
    const cached = modelsByKind[harnessKind] ?? null
    set({
      harnessKind,
      harnessAutoPicked: false,
      modelsByKind,
      ...(cached
        ? { sessionModels: cached.models, sessionModes: cached.modes, modelId: cached.modelId, modeId: cached.modeId }
        : { sessionModels: null, sessionModes: null, modelId: null, modeId: null }),
    })
  },
  inspectHarness: async (kind) => {
    // Hybrid probe (map 47 ticket 50, pre-#145): lazy when the model picker
    // opens/hovers, plus a warm-start for the auto-selected harness on load
    // (fired from replaceHarnesses). The probe declares models/modes only —
    // it never warms a resumable session (F5).
    // Latest-wins: record the probed kind so the composer can show a loading
    // state and a superseded probe (a harness switched mid-flight) is
    // dropped. A probe for this exact kind is already in flight — its result
    // applies when it lands, so skip the redundant round-trip (the main
    // process also coalesces concurrent probes into one spawn slot).
    if (get().inspectingKind === kind) return
    // This kind has been probed before (declared set OR empty declaration) —
    // its result is in the cache, so a re-open / re-switch never re-spawns
    // the agent. A FAILED probe never lands here, so an unavailable agent is
    // still retried on the next open.
    if (get().modelsByKind[kind]) return
    set({ inspectingKind: kind })
    // The probe warms a session the first run may resume — spawn it with the
    // same API-key opt-in the run will use, or the resumed session would
    // carry the wrong environment.
    const allowApiKeyEnv = useSettingsStore.getState().allowHarnessApiKeyEnv
    const inspectRequest = allowApiKeyEnv ? { kind, allowApiKeyEnv: true as const } : { kind }
    const result = await fetchCoachInspect(inspectRequest)
    set(state => (state.inspectingKind === kind ? { inspectingKind: null } : state))
    if (!result.ok || !result.data.ok) return
    const { models, modes } = result.data
    set(state => {
      // Cache the result under the probed kind REGARDLESS of which harness is
      // current — a later switch-back restores it instantly. The remembered
      // pick: for the CURRENT harness the user's live pick wins (a pick made
      // from an earlier session event must survive a switch-away-and-back);
      // for a switched-away kind only an already-cached pick (captured at
      // switch time) applies — the live pick belongs to a different harness.
      // Else the agent's current model/mode.
      const existing = state.modelsByKind[kind]
      const isCurrent = state.harnessKind === kind
      const pickModelId = isCurrent
        ? state.modelId ?? existing?.modelId ?? models?.currentModelId ?? null
        : existing?.modelId ?? models?.currentModelId ?? null
      const pickModeId = isCurrent
        ? state.modeId ?? existing?.modeId ?? modes?.currentModeId ?? null
        : existing?.modeId ?? modes?.currentModeId ?? null
      const modelsByKind = {
        ...state.modelsByKind,
        [kind]: { models: models ?? null, modes: modes ?? null, modelId: pickModelId, modeId: pickModeId },
      }
      // Apply to the LIVE surface only when the user is still on this
      // harness — a probe that answers after a switch belongs to the cache,
      // never to the current picker.
      if (!isCurrent) return { modelsByKind }
      return {
        modelsByKind,
        sessionModels: models ?? state.sessionModels,
        sessionModes: modes ?? state.sessionModes,
        modelId: pickModelId,
        modeId: pickModeId,
      }
    })
  },
  setModelId: (modelId) => set(state => {
    // Write-through to the per-harness cache (when the kind has an entry):
    // the cache ALSO holds the user's picks, and `resetSession` restores
    // from it — without this a pick made after the probe would be lost on a
    // new conversation. No entry is created for a never-probed kind: that
    // would mark it cached and block its lazy probe (`inspectHarness`
    // returns early on cached kinds) — the live pick still survives the
    // probe via its live-pick-wins rule.
    const kind = state.harnessKind
    const entry = kind ? state.modelsByKind[kind] : undefined
    if (!kind || !entry) return { modelId }
    return { modelId, modelsByKind: { ...state.modelsByKind, [kind]: { ...entry, modelId } } }
  }),
  setModeId: (modeId) => set(state => {
    // Same write-through contract as setModelId (see above).
    const kind = state.harnessKind
    const entry = kind ? state.modelsByKind[kind] : undefined
    if (!kind || !entry) return { modeId }
    return { modeId, modelsByKind: { ...state.modelsByKind, [kind]: { ...entry, modeId } } }
  }),
  sendCoach: async (prompt) => {
    const s = get()
    if (s.running) return
    const trimmed = prompt.trim()
    if (!trimmed) return
    await startRun({
      userContent: trimmed,
      prompt: trimmed,
      resume: true,
    })
  },
  retryAssistant: async (messageId) => {
    const s = get()
    if (s.running) return
    const index = s.messages.findIndex(m => m.id === messageId)
    const assistant = s.messages[index]
    // Only the LAST assistant turn is regenerable — replacing a mid-thread
    // answer would strand the turns after it — and only once it is FINISHED:
    // a half-streamed turn has nothing stable to re-run. The preceding user
    // turn is the prompt being re-run.
    const lastAssistantIndex = s.messages.findLastIndex(m => m.role === 'assistant')
    if (!assistant || assistant.role !== 'assistant' || assistant.streaming || index !== lastAssistantIndex) return
    const user = s.messages[index - 1]
    if (!user || user.role !== 'user') return
    await startRun({
      userContent: user.content,
      prompt: user.content,
      resume: true,
    }, { replaceAssistantId: messageId })
  },
  cancel: () => {
    const runId = get().activeRunId
    if (runId) window.api.cancelCoachRun(runId)
    set(state => ({
      running: false,
      activeRunId: null,
      messages: state.messages.map(message =>
        message.streaming ? { ...message, streaming: false, error: 'cancelled' } : message),
    }))
  },
  resetSession: () => {
    // A brand-new conversation: the main process cancels active runs and
    // deletes the old conversation's temp workspace (map 53).
    window.api.resetCoachWorkspace()
    set(state => {
      // The thread is conversation state — cleared. Agent capabilities are
      // not: restore the current harness's cached set + picks so the pickers
      // never go blank after a reset (no re-probe needed).
      const cached = state.harnessKind ? state.modelsByKind[state.harnessKind] ?? null : null
      return {
        messages: [],
        resumeCursor: null,
        error: null,
        running: false,
        activeRunId: null,
        pendingEvents: {},
        runMessageIds: {},
        sessionModels: cached?.models ?? null,
        sessionModes: cached?.modes ?? null,
        modelId: cached?.modelId ?? null,
        modeId: cached?.modeId ?? null,
      }
    })
  },
  onEvent: (envelope) => {
    const state = get()
    const messageId = state.runMessageIds[envelope.runId]
    if (!messageId) {
      if (state.running && state.activeRunId === null) {
        const parked = state.pendingEvents[envelope.runId] ?? []
        set({ pendingEvents: { ...state.pendingEvents, [envelope.runId]: [...parked, envelope] } })
      }
      return
    }
    const event = envelope.event
    const active = state.activeRunId === envelope.runId
    const updateMessage = (update: (message: ChatMessage) => ChatMessage): void => {
      set(current => ({ messages: current.messages.map(message => message.id === messageId ? update(message) : message) }))
    }
    switch (event.kind) {
      case 'status':
        if (event.state === 'done') {
          updateMessage(message => ({ ...message, streaming: false }))
          if (active) set({ running: false, activeRunId: null })
        } else if (active) {
          set({ running: true })
        }
        break
      case 'text':
        updateMessage(message => ({ ...message, content: message.content + event.delta }))
        break
      case 'reasoning':
        updateMessage(message => ({ ...message, thinking: message.thinking + event.delta }))
        break
      case 'notice':
        updateMessage(message => ({ ...message, notices: [...message.notices, event.message] }))
        break
      case 'tool': {
        updateMessage(message => {
          const tools = [...message.tools]
          const notice: ToolNotice = { tool: event.tool, state: event.state ?? 'started' }
          if (event.id) notice.id = event.id
          if (event.title) notice.title = event.title
          if (event.input) notice.input = event.input
          if (event.output) notice.output = event.output
          if (event.error) notice.error = event.error
          const existing = notice.id ? tools.findIndex(tool => tool.id === notice.id) : -1
          if (existing !== -1) {
            // A `started` re-announcement (tool-call carrying args) only enriches — it never reopens a closed call.
            tools[existing] = {
              ...tools[existing],
              ...(notice.state === 'started' ? {} : { state: notice.state }),
              ...(notice.title ? { title: notice.title } : {}),
              ...(notice.input ? { input: notice.input } : {}),
              ...(notice.output ? { output: notice.output } : {}),
              ...(notice.error ? { error: notice.error } : {}),
            }
          } else {
            tools.push(notice)
          }
          return { ...message, tools }
        })
        break
      }
      case 'session': {
        if (!active) break
        set(state => {
          const modelsByKind = { ...state.modelsByKind }
          if (state.harnessKind && (event.models || event.modes || state.modelsByKind[state.harnessKind])) {
            const existing = state.modelsByKind[state.harnessKind]
            const models = event.models ?? state.sessionModels ?? null
            const modes = event.modes ?? state.sessionModes ?? null
            modelsByKind[state.harnessKind] = {
              models,
              modes,
              // Live-pick-wins (same rule as inspectHarness): the user's
              // current choice beats a stale cached one — with the
              // setModelId/setModeId write-through the two are in step
              // anyway, and a run must never resurrect a superseded pick.
              modelId: state.modelId ?? existing?.modelId ?? models?.currentModelId ?? null,
              modeId: state.modeId ?? existing?.modeId ?? modes?.currentModeId ?? null,
            }
          }
          return {
            resumeCursor: event.resumeCursor,
            sessionModels: event.models ?? state.sessionModels,
            sessionModes: event.modes ?? state.sessionModes,
            modelId: state.modelId ?? (event.models?.currentModelId ?? null),
            modeId: state.modeId ?? (event.modes?.currentModeId ?? null),
            modelsByKind,
          }
        })
        break
      }
      case 'error':
        updateMessage(message => message.error === 'cancelled'
          ? { ...message, streaming: false }
          : { ...message, streaming: false, error: event.message })
        if (active) set({ running: false, activeRunId: null })
        break
    }
  },
}))

/** The one run path behind sendCoach / retryAssistant. Builds the user turn +
 *  streaming assistant turn, acks the run, and arms event routing. When
 *  `replaceAssistantId` is set (a retry), the old assistant turn is swapped
 *  out IN PLACE — the user message is kept, no duplicate turn is added. */
async function startRun(input: {
  userContent: string
  prompt: string
  resume: boolean
}, options: { replaceAssistantId?: string } = {}): Promise<void> {
  const s = useCoachSkillsStore.getState()
  if (!s.harnessKind) {
    setRunFailed('select a harness first')
    return
  }
  const userMessage: ChatMessage = { id: nextMessageId(), role: 'user', content: input.userContent, thinking: '', tools: [], notices: [], streaming: false }
  const assistantMessage = emptyAssistant()
  setRunPending(userMessage, assistantMessage, options.replaceAssistantId)

  const resumeCursor = input.resume ? s.resumeCursor : undefined
  // API-key passthrough opt-in (persisted Coach setting): lets key-based
  // terminal sign-ins work inside harness runs. Sent per run (never stored
  // with the conversation) so toggling applies immediately.
  const allowApiKeyEnv = useSettingsStore.getState().allowHarnessApiKeyEnv
  const result = await fetchCoachRun({
    harnessKind: s.harnessKind,
    // The conversation's UI-scope snapshot (map 53): no longer baked into the
    // MCP server (it serves the full lifetime ledger) — it rides the first-run
    // briefing as the suggested default window for the agent's queries.
    scope: selectScope(useScopeStore.getState()),
    prompt: input.prompt,
    // Progressive model/mode selection (map 47 ticket 50): forward the user's
    // choices ONLY when the agent declared that set (null = agent default).
    ...(s.sessionModels ? { modelId: s.modelId ?? undefined } : {}),
    ...(s.sessionModes ? { modeId: s.modeId ?? undefined } : {}),
    ...(resumeCursor ? { resumeCursor } : {}),
    ...(allowApiKeyEnv ? { allowApiKeyEnv: true as const } : {}),
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
  useCoachSkillsStore.setState(state => ({
    activeRunId: runId,
    runMessageIds: { ...state.runMessageIds, [runId]: assistantMessage.id },
  }))
  // Replay any events that streamed before the ack round-trip landed (a fast
  // failure must surface, not hang the turn). Only this run's parked events
  // replay; parked events for other runIds are stale and are dropped here.
  const parked = useCoachSkillsStore.getState().pendingEvents[runId]
  useCoachSkillsStore.setState({ pendingEvents: {} })
  if (parked) for (const envelope of parked) useCoachSkillsStore.getState().onEvent(envelope)
}

function setRunPending(userMessage: ChatMessage, assistantMessage: ChatMessage, replaceAssistantId?: string): void {
  useCoachSkillsStore.setState(state => ({
    running: true,
    error: null,
    activeRunId: null,
    // A retry swaps the OLD assistant turn for the fresh streaming one (the
    // user message stays); a fresh run appends both turns.
    messages: replaceAssistantId
      ? state.messages.filter(message => message.id !== replaceAssistantId).concat(assistantMessage)
      : [...state.messages, userMessage, assistantMessage],
  }))
}

function setRunFailed(error: string): void {
  useCoachSkillsStore.setState(state => ({
    running: false,
    error,
    pendingEvents: {},
    messages: state.messages.map(message =>
      message.streaming ? { ...message, streaming: false, error } : message,
    ),
  }))
}

subscribeToRefresh(() => {
  void useCoachSkillsStore.getState().detection.reload()
})

/** Refetch the detection pool whenever the detection gate changes in
 *  Settings › Skills — tuning the thresholds must repaint the welcome
 *  screen's suggested-skill chips without a manual refresh. */
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
