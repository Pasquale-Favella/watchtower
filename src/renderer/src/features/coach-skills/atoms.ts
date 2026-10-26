import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Predicate from 'effect/Predicate'
import type * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import type { RpcClientError } from 'effect/rpc/RpcClientError'

import { createRpcQuerySlot } from '@/app/atoms/rpc-query'
import { overviewScopeAtom } from '@/app/atoms/scope'
import { preferencesAtom } from '@/features/settings/preferences-atoms'
import { ApplicationClient } from '@/shared/lib/application-rpc'
import { RendererApi } from '@/shared/lib/renderer-api'

import type { AnalyticsRpcError } from '../../../../shared/rpc/errors.js'
import type {
  CoachEventEnvelope,
  CoachHarnessRow,
  CoachSessionModels,
  CoachSessionModes,
} from '../../../../shared/schemas/agents.js'
import type { OverviewScope } from '../../../../shared/schemas/overview.js'
import type { SkillsPayload } from '../../../../shared/schemas/skills.js'

export interface ToolNotice {
  id?: string
  tool: string
  title?: string
  state: 'started' | 'completed' | 'error'
  input?: string
  output?: string
  error?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  thinking: string
  tools: ToolNotice[]
  notices: string[]
  meta?: { harness?: string; model?: string; mode?: string }
  error?: string
  streaming: boolean
}

export interface CoachKindCache {
  models: CoachSessionModels | null
  modes: CoachSessionModes | null
  modelId: string | null
  modeId: string | null
}

export interface CoachState {
  hydrated: boolean
  harnesses: CoachHarnessRow[]
  harnessKind: string | null
  harnessAutoPicked: boolean
  sessionModels: CoachSessionModels | null
  sessionModes: CoachSessionModes | null
  inspectingKind: string | null
  pendingProbeKinds: string[]
  modelsByKind: Record<string, CoachKindCache>
  modelId: string | null
  modeId: string | null
  messages: ChatMessage[]
  running: boolean
  activeRunId: string | null
  pendingEvents: Record<string, CoachEventEnvelope[]>
  resumeCursor: string | null
  runMessageIds: Record<string, string>
  runHarnessKinds: Record<string, string>
  error: string | null
  generation: number
  probeSequence: number
  runGenerations: Record<string, number>
}

export interface CoachDetectionRequest {
  readonly scope: OverviewScope
  readonly frequency: number
  readonly spread: number
}

type CoachDetectionQuery = (
  request: CoachDetectionRequest,
  selectionId: string,
) => Atom.Atom<AsyncResult.AsyncResult<SkillsPayload | null, AnalyticsRpcError | RpcClientError>>

const applicationCoachDetectionQuery: CoachDetectionQuery = (request, selectionId) =>
  ApplicationClient.query(
    'skills:view',
    { scope: request.scope, thresholds: { frequency: request.frequency, spread: request.spread } },
    { serializationKey: selectionId, reactivityKeys: ['ledger', 'pricing'] },
  )

const initialCoachState = (): CoachState => ({
  hydrated: false,
  harnesses: [],
  harnessKind: null,
  harnessAutoPicked: false,
  sessionModels: null,
  sessionModes: null,
  inspectingKind: null,
  pendingProbeKinds: [],
  modelsByKind: {},
  modelId: null,
  modeId: null,
  messages: [],
  running: false,
  activeRunId: null,
  pendingEvents: {},
  resumeCursor: null,
  runMessageIds: {},
  runHarnessKinds: {},
  error: null,
  generation: 0,
  probeSequence: 0,
  runGenerations: {},
})

const defaultHarnessId = (harnesses: CoachHarnessRow[]): string | null =>
  harnesses.find(h => h.status === 'ready')?.instanceId ??
  harnesses.find(h => h.status === 'warning' || h.status === 'pending')?.instanceId ??
  null

let messageSequence = 0
const nextMessageId = (): string => `coach-${++messageSequence}`

const messageContext = (state: CoachState): ChatMessage['meta'] => {
  const harness = state.harnesses.find(row => row.instanceId === state.harnessKind)
  const model = state.sessionModels?.availableModels.find(row => row.modelId === state.modelId)
  const mode = state.sessionModes?.availableModes.find(row => row.id === state.modeId)
  const meta = {
    ...(harness ? { harness: harness.displayName } : {}),
    ...(model ? { model: model.name } : {}),
    ...(mode ? { mode: mode.name } : {}),
  }
  return Object.keys(meta).length > 0 ? meta : undefined
}

const emptyAssistant = (state: CoachState): ChatMessage => ({
  id: nextMessageId(),
  role: 'assistant',
  content: '',
  thinking: '',
  tools: [],
  notices: [],
  meta: messageContext(state),
  streaming: true,
})

export const createCoachAtoms = (
  runtime: Atom.RegistryRuntimeFactory,
  apiLayer: Layer.Layer<RendererApi> = RendererApi.layer,
  detectionQuery: CoachDetectionQuery = applicationCoachDetectionQuery,
) => {
  const api = runtime(apiLayer)
  const coachStateAtom = Atom.keepAlive(Atom.make(initialCoachState()))
  const detection = createRpcQuerySlot<CoachDetectionRequest, SkillsPayload | null, AnalyticsRpcError | RpcClientError>(
    {
      key: request => `${JSON.stringify(request.scope)}:${request.frequency}:${request.spread}`,
      query: detectionQuery,
    },
  )

  const loadHarnessesAtom = api.fn<undefined>()(
    (_, get) =>
      Effect.gen(function* () {
        const rendererApi = yield* RendererApi
        const harnesses = yield* rendererApi.getCoachHarnesses()
        get.set(replaceHarnessesAtom, harnesses)
        return harnesses
      }),
    { concurrent: true },
  )

  const refreshHarnessesAtom = api.fn<undefined>()(
    (_, get) =>
      Effect.gen(function* () {
        const rendererApi = yield* RendererApi
        const harnesses = yield* rendererApi.refreshCoachHarnesses()
        get.set(replaceHarnessesAtom, harnesses)
        return harnesses
      }),
    { concurrent: true },
  )

  const openCoachLoginTerminalAtom = api.fn<string>()(
    instanceId =>
      Effect.gen(function* () {
        const rendererApi = yield* RendererApi
        yield* rendererApi.openCoachLoginTerminal(instanceId)
      }),
    { concurrent: true },
  )

  const inspectHarnessCommandAtom = Atom.family((kind: string) =>
    api.fn<number>()(
      (sequence, get) => {
        const allowApiKeyEnv = get(preferencesAtom).allowHarnessApiKeyEnv
        return Effect.gen(function* () {
          const rendererApi = yield* RendererApi
          const result = yield* rendererApi.inspectCoachHarness(
            allowApiKeyEnv ? { kind, allowApiKeyEnv: true } : { kind },
          )
          if (!result.ok) return
          const current = get(coachStateAtom)
          const existing = current.modelsByKind[kind]
          const isCurrent = current.harnessKind === kind
          const modelId = isCurrent
            ? (current.modelId ?? existing?.modelId ?? result.models?.currentModelId ?? null)
            : (existing?.modelId ?? result.models?.currentModelId ?? null)
          const modeId = isCurrent
            ? (current.modeId ?? existing?.modeId ?? result.modes?.currentModeId ?? null)
            : (existing?.modeId ?? result.modes?.currentModeId ?? null)
          get.set(coachStateAtom, {
            ...current,
            modelsByKind: {
              ...current.modelsByKind,
              [kind]: { models: result.models ?? null, modes: result.modes ?? null, modelId, modeId },
            },
            ...(isCurrent
              ? {
                  sessionModels: result.models ?? current.sessionModels,
                  sessionModes: result.modes ?? current.sessionModes,
                  modelId,
                  modeId,
                }
              : {}),
          })
        }).pipe(
          Effect.catch(() => Effect.void),
          Effect.ensuring(
            Effect.sync(() => {
              const current = get(coachStateAtom)
              get.set(coachStateAtom, {
                ...current,
                pendingProbeKinds: current.pendingProbeKinds.filter(pendingKind => pendingKind !== kind),
                ...(current.probeSequence === sequence && current.inspectingKind === kind
                  ? { inspectingKind: null }
                  : {}),
              })
            }),
          ),
        )
      },
      { concurrent: true },
    ),
  )

  const inspectHarnessAtom = api.fn<string>()(
    (kind, get) => {
      const state = get(coachStateAtom)
      if (state.pendingProbeKinds.includes(kind) || state.modelsByKind[kind]) return Effect.void
      const command = inspectHarnessCommandAtom(kind)
      const sequence = state.probeSequence + 1
      get.set(coachStateAtom, {
        ...state,
        inspectingKind: kind,
        pendingProbeKinds: [...state.pendingProbeKinds, kind],
        probeSequence: sequence,
      })
      return get.setResult(command, sequence).pipe(Effect.asVoid)
    },
    { concurrent: true },
  )

  const replaceHarnessesAtom = Atom.writable<CoachHarnessRow[], CoachHarnessRow[]>(
    get => get(coachStateAtom).harnesses,
    (context, harnesses: CoachHarnessRow[]) => {
      const state = context.get(coachStateAtom)
      const currentRow = state.harnessKind ? harnesses.find(row => row.instanceId === state.harnessKind) : undefined
      const keep =
        !!currentRow && !(state.harnessAutoPicked && state.messages.length === 0 && currentRow.status !== 'ready')
      const next = keep ? state.harnessKind : defaultHarnessId(harnesses)
      context.set(coachStateAtom, { ...state, harnesses, hydrated: true })
      if (next && next !== state.harnessKind) {
        context.set(setHarnessAtom, next)
        const selected = context.get(coachStateAtom)
        context.set(coachStateAtom, { ...selected, harnessAutoPicked: true })
        if (state.harnessKind && state.messages.length > 0) context.set(resetSessionAtom, undefined)
        context.set(inspectHarnessAtom, next)
      } else {
        const current = context.get(coachStateAtom)
        const changed = current.harnessKind !== next
        const cancelRunId = changed && current.running ? current.activeRunId : null
        context.set(coachStateAtom, {
          ...current,
          generation: changed ? current.generation + 1 : current.generation,
          harnessKind: next,
          ...(changed
            ? {
                running: false,
                activeRunId: null,
                ...(current.running
                  ? {
                      messages: current.messages.map(message =>
                        message.streaming ? { ...message, streaming: false, error: 'cancelled' } : message,
                      ),
                    }
                  : {}),
              }
            : {}),
          ...(next ? {} : { sessionModels: null, sessionModes: null, modelId: null, modeId: null }),
        })
        if (cancelRunId) context.set(cancelAtom, cancelRunId)
        if (next && current.harnessAutoPicked && current.messages.length === 0 && !current.modelsByKind[next]) {
          context.set(inspectHarnessAtom, next)
        }
      }
    },
  )

  const setHarnessAtom = Atom.writable(
    get => get(coachStateAtom).harnessKind,
    (context, kind: string) => {
      const state = context.get(coachStateAtom)
      const previous = state.harnessKind
      const outgoing = previous ? state.modelsByKind[previous] : undefined
      const modelsByKind =
        previous && previous !== kind && outgoing
          ? { ...state.modelsByKind, [previous]: { ...outgoing, modelId: state.modelId, modeId: state.modeId } }
          : state.modelsByKind
      const cached = modelsByKind[kind]
      context.set(coachStateAtom, {
        ...state,
        generation: previous !== kind ? state.generation + 1 : state.generation,
        harnessKind: kind,
        harnessAutoPicked: false,
        modelsByKind,
        ...(cached
          ? { sessionModels: cached.models, sessionModes: cached.modes, modelId: cached.modelId, modeId: cached.modeId }
          : { sessionModels: null, sessionModes: null, modelId: null, modeId: null }),
      })
      if (previous !== kind && state.running) context.set(cancelAtom, undefined)
    },
  )

  const setModelIdAtom = Atom.writable(
    get => get(coachStateAtom).modelId,
    (context, modelId: string | null) => {
      const state = context.get(coachStateAtom)
      const cached = state.harnessKind ? state.modelsByKind[state.harnessKind] : undefined
      context.set(coachStateAtom, {
        ...state,
        modelId,
        ...(cached && state.harnessKind
          ? { modelsByKind: { ...state.modelsByKind, [state.harnessKind]: { ...cached, modelId } } }
          : {}),
      })
    },
  )

  const setModeIdAtom = Atom.writable(
    get => get(coachStateAtom).modeId,
    (context, modeId: string | null) => {
      const state = context.get(coachStateAtom)
      const cached = state.harnessKind ? state.modelsByKind[state.harnessKind] : undefined
      context.set(coachStateAtom, {
        ...state,
        modeId,
        ...(cached && state.harnessKind
          ? { modelsByKind: { ...state.modelsByKind, [state.harnessKind]: { ...cached, modeId } } }
          : {}),
      })
    },
  )

  const eventAtom = Atom.writable(
    get => get(coachStateAtom),
    (context, envelope: CoachEventEnvelope) => {
      const state = context.get(coachStateAtom)
      const messageId = state.runMessageIds[envelope.runId]
      if (!messageId) {
        if (state.running && state.activeRunId === null) {
          const parked = state.pendingEvents[envelope.runId] ?? []
          context.set(coachStateAtom, {
            ...state,
            pendingEvents: { ...state.pendingEvents, [envelope.runId]: [...parked, envelope] },
          })
        }
        return
      }
      const runGeneration = state.runGenerations[envelope.runId]
      if (
        runGeneration !== undefined &&
        runGeneration !== state.generation &&
        state.messages.every(message => message.id !== messageId || message.error !== 'cancelled')
      )
        return
      const event = envelope.event
      const active = state.activeRunId === envelope.runId
      let next: CoachState = { ...state }
      const updateMessage = (update: (message: ChatMessage) => ChatMessage): void => {
        next = {
          ...next,
          messages: next.messages.map(message => (message.id === messageId ? update(message) : message)),
        }
      }
      switch (event.kind) {
        case 'status':
          if (event.state === 'done') {
            updateMessage(message => ({ ...message, streaming: false }))
            if (active) next = { ...next, running: false, activeRunId: null }
          } else if (active) next = { ...next, running: true }
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
        case 'tool':
          updateMessage(message => {
            const tools = [...message.tools]
            const notice: ToolNotice = { tool: event.tool, state: event.state ?? 'started' }
            if (event.id) notice.id = event.id
            if (event.title) notice.title = event.title
            if (event.input) notice.input = event.input
            if (event.output) notice.output = event.output
            if (event.error) notice.error = event.error
            const existing = notice.id ? tools.findIndex(tool => tool.id === notice.id) : -1
            if (existing < 0) tools.push(notice)
            else {
              const previousNotice = tools[existing]
              if (previousNotice) {
                tools[existing] = {
                  ...previousNotice,
                  ...(notice.state === 'started' ? {} : { state: notice.state }),
                  ...(notice.title ? { title: notice.title } : {}),
                  ...(notice.input ? { input: notice.input } : {}),
                  ...(notice.output ? { output: notice.output } : {}),
                  ...(notice.error ? { error: notice.error } : {}),
                }
              }
            }
            return { ...message, tools }
          })
          break
        case 'session':
          if (active) {
            const modelsByKind = { ...next.modelsByKind }
            const kind = next.runHarnessKinds[envelope.runId]
            if (kind && (event.models || event.modes || modelsByKind[kind])) {
              const cached = modelsByKind[kind]
              const models = event.models ?? next.sessionModels ?? null
              const modes = event.modes ?? next.sessionModes ?? null
              modelsByKind[kind] = {
                models,
                modes,
                modelId: next.modelId ?? cached?.modelId ?? models?.currentModelId ?? null,
                modeId: next.modeId ?? cached?.modeId ?? modes?.currentModeId ?? null,
              }
            }
            next = {
              ...next,
              resumeCursor: event.resumeCursor,
              sessionModels: event.models ?? next.sessionModels,
              sessionModes: event.modes ?? next.sessionModes,
              modelId: next.modelId ?? event.models?.currentModelId ?? null,
              modeId: next.modeId ?? event.modes?.currentModeId ?? null,
              modelsByKind,
            }
          }
          break
        case 'error':
          updateMessage(message =>
            message.error === 'cancelled'
              ? { ...message, streaming: false }
              : { ...message, streaming: false, error: event.message },
          )
          if (active) next = { ...next, running: false, activeRunId: null }
          break
      }
      context.set(coachStateAtom, next)
    },
  )

  const cancelAtom = api.fn<string | undefined>()(
    (requestedRunId, get) =>
      Effect.gen(function* () {
        const state = get(coachStateAtom)
        const runId = requestedRunId ?? state.activeRunId
        if (requestedRunId === undefined) {
          get.set(coachStateAtom, {
            ...state,
            generation: state.generation + 1,
            running: false,
            activeRunId: null,
            messages: state.messages.map(message =>
              message.streaming ? { ...message, streaming: false, error: 'cancelled' } : message,
            ),
          })
        }
        if (runId) {
          const rendererApi = yield* RendererApi
          yield* rendererApi.cancelCoachRun(runId)
        }
      }),
    { concurrent: true },
  )

  const resetSessionAtom = api.fn<undefined>()(
    (_, get) =>
      Effect.gen(function* () {
        const state = get(coachStateAtom)
        const generation = state.generation + 1
        const cached = state.harnessKind ? (state.modelsByKind[state.harnessKind] ?? null) : null
        get.set(coachStateAtom, {
          ...state,
          generation,
          messages: [],
          resumeCursor: null,
          error: null,
          running: false,
          activeRunId: null,
          pendingEvents: {},
          runMessageIds: {},
          runHarnessKinds: {},
          runGenerations: {},
          sessionModels: cached?.models ?? null,
          sessionModes: cached?.modes ?? null,
          modelId: cached?.modelId ?? null,
          modeId: cached?.modeId ?? null,
        })
        const rendererApi = yield* RendererApi
        yield* rendererApi.resetCoachWorkspace()
      }),
    { concurrent: false },
  )

  const runCoachEffect = (
    input: { readonly prompt: string; readonly retryMessageId?: string },
    get: Atom.FnContext,
  ) => {
    const state = get(coachStateAtom)
    const generation = state.generation
    return Effect.gen(function* () {
      const prompt = input.prompt.trim()
      if (state.running || !prompt) return
      if (!state.harnessKind) {
        get.set(coachStateAtom, { ...state, error: 'select a harness first' })
        return
      }
      const retryIndex = input.retryMessageId
        ? state.messages.findIndex(message => message.id === input.retryMessageId)
        : -1
      if (input.retryMessageId) {
        const target = state.messages[retryIndex]
        const lastAssistant = state.messages.findLastIndex(message => message.role === 'assistant')
        if (
          !target ||
          target.role !== 'assistant' ||
          target.streaming ||
          retryIndex !== lastAssistant ||
          state.messages[retryIndex - 1]?.role !== 'user'
        )
          return
      }
      const user = input.retryMessageId
        ? undefined
        : {
            id: nextMessageId(),
            role: 'user' as const,
            content: prompt,
            thinking: '',
            tools: [],
            notices: [],
            streaming: false,
          }
      const assistant = emptyAssistant(state)
      get.set(coachStateAtom, {
        ...state,
        running: true,
        activeRunId: null,
        error: null,
        pendingEvents: {},
        messages: input.retryMessageId
          ? state.messages.filter(message => message.id !== input.retryMessageId).concat(assistant)
          : user
            ? [...state.messages, user, assistant]
            : [...state.messages, assistant],
      })
      const preferenceSnapshot = get(preferencesAtom)
      const request = {
        harnessKind: state.harnessKind,
        scope: get(overviewScopeAtom),
        prompt,
        ...(state.sessionModels ? { modelId: state.modelId ?? undefined } : {}),
        ...(state.sessionModes ? { modeId: state.modeId ?? undefined } : {}),
        ...(state.resumeCursor ? { resumeCursor: state.resumeCursor } : {}),
        ...(preferenceSnapshot.allowHarnessApiKeyEnv ? { allowApiKeyEnv: true as const } : {}),
      }
      const rendererApi = yield* RendererApi
      const result = yield* rendererApi.startCoachRun(request)
      const latest = get(coachStateAtom)
      if (latest.generation !== generation || !latest.running) {
        if (result.ok) yield* rendererApi.cancelCoachRun(result.runId)
        return
      }
      if (!result.ok) {
        get.set(coachStateAtom, {
          ...latest,
          running: false,
          error: result.error,
          pendingEvents: {},
          messages: latest.messages.map(message =>
            message.streaming ? { ...message, streaming: false, error: result.error } : message,
          ),
        })
        return
      }
      const runId = result.runId
      get.set(coachStateAtom, {
        ...latest,
        activeRunId: runId,
        runMessageIds: { ...latest.runMessageIds, [runId]: assistant.id },
        runHarnessKinds: { ...latest.runHarnessKinds, [runId]: state.harnessKind },
        runGenerations: { ...latest.runGenerations, [runId]: generation },
      })
      const parked = get(coachStateAtom).pendingEvents[runId]
      get.set(coachStateAtom, { ...get(coachStateAtom), pendingEvents: {} })
      for (const envelope of parked ?? []) get.set(eventAtom, envelope)
    }).pipe(
      Effect.catch(error => {
        return Effect.sync(() => {
          const latest = get(coachStateAtom)
          if (latest.generation !== generation) return
          const message =
            Predicate.hasProperty(error, 'message') && Predicate.isString(error.message)
              ? error.message
              : 'Unable to start the Coach run.'
          get.set(coachStateAtom, {
            ...latest,
            running: false,
            activeRunId: null,
            error: message,
            pendingEvents: {},
            messages: latest.messages.map(item =>
              item.streaming ? { ...item, streaming: false, error: message } : item,
            ),
          })
        })
      }),
    )
  }

  const sendCoachAtom = api.fn<string>()((prompt, get) => runCoachEffect({ prompt }, get), { concurrent: true })
  const retryAssistantAtom = api.fn<string>()(
    (messageId, get) => {
      const state = get(coachStateAtom)
      const index = state.messages.findIndex(message => message.id === messageId)
      const user = state.messages[index - 1]
      return user?.role === 'user'
        ? runCoachEffect({ prompt: user.content, retryMessageId: messageId }, get)
        : Effect.void
    },
    { concurrent: true },
  )

  return {
    coachStateAtom,
    detection,
    loadHarnessesAtom,
    refreshHarnessesAtom,
    openCoachLoginTerminalAtom,
    replaceHarnessesAtom,
    setHarnessAtom,
    inspectHarnessAtom,
    setModelIdAtom,
    setModeIdAtom,
    sendCoachAtom,
    retryAssistantAtom,
    cancelAtom,
    resetSessionAtom,
    eventAtom,
  }
}

export type CoachAtoms = ReturnType<typeof createCoachAtoms>

/** Pins asynchronous Coach commands to the window lifetime, across Section navigation. */
export const mountCoachAtoms = (registry: AtomRegistry.AtomRegistry, atoms: CoachAtoms): (() => void) => {
  const releases = [
    registry.mount(atoms.loadHarnessesAtom),
    registry.mount(atoms.refreshHarnessesAtom),
    registry.mount(atoms.openCoachLoginTerminalAtom),
    registry.mount(atoms.inspectHarnessAtom),
    registry.mount(atoms.sendCoachAtom),
    registry.mount(atoms.retryAssistantAtom),
    registry.mount(atoms.cancelAtom),
    registry.mount(atoms.resetSessionAtom),
  ]
  return () => {
    for (const release of releases) release()
  }
}

import { runtime as sharedRuntime } from '@/app/renderer-runtime'

const defaultCoachAtoms = createCoachAtoms(sharedRuntime)

export const {
  coachStateAtom,
  detection: coachDetection,
  loadHarnessesAtom,
  refreshHarnessesAtom,
  openCoachLoginTerminalAtom,
  replaceHarnessesAtom,
  setHarnessAtom,
  inspectHarnessAtom,
  setModelIdAtom,
  setModeIdAtom,
  sendCoachAtom,
  retryAssistantAtom,
  cancelAtom: cancelCoachAtom,
  resetSessionAtom,
  eventAtom: coachEventAtom,
} = defaultCoachAtoms

export const mountCoachWorkflow = (registry: AtomRegistry.AtomRegistry): (() => void) =>
  mountCoachAtoms(registry, defaultCoachAtoms)
