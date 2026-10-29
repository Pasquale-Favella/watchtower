import * as Effect from 'effect/Effect'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { RpcClientDefect, RpcClientError } from 'effect/rpc/RpcClientError'
import * as Stream from 'effect/Stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { overviewScopeAtom, periodAtom } from '../src/renderer/stores/atoms/scope.js'
import { createCoachAtoms, mountCoachAtoms } from '../src/renderer/features/coach-skills/atoms.js'
import { harnessBadge, statusLabel } from '../src/renderer/features/coach-skills/lib.js'
import { preferencesAtom } from '../src/renderer/features/settings/preferences-atoms.js'
import { CoachRpcError, type CoachRunFrame } from '../src/shared/rpc/coach.js'
import type {
  CoachEventEnvelope,
  CoachHarnessRow,
  CoachInspectRequest,
  CoachSessionModels,
  CoachSessionModes,
} from '../src/shared/schemas/agents.js'
import { type CoachRpcTestOverrides, makeCoachRpcTestClient } from './coach-rpc-test-helper.js'

const harnesses: CoachHarnessRow[] = [
  { instanceId: 'claude', kind: 'claude', displayName: 'Claude Code', status: 'ready', auth: { status: 'configured' } },
  { instanceId: 'gemini', kind: 'gemini', displayName: 'Gemini CLI', status: 'warning', auth: { status: 'unknown' } },
]
const models: CoachSessionModels = {
  availableModels: [{ modelId: 'opus', name: 'Claude Opus' }],
  currentModelId: 'opus',
}
const modes: CoachSessionModes = { availableModes: [{ id: 'plan', name: 'Plan' }], currentModeId: 'plan' }
const envelope = (runId: string, event: CoachEventEnvelope['event']): CoachEventEnvelope => ({ runId, event })

function setup(overrides: CoachRpcTestOverrides = {}) {
  const registry = AtomRegistry.make()
  const runtime = Atom.context()
  const client = makeCoachRpcTestClient(runtime, {
    harnesses: () => Effect.succeed(harnesses),
    refreshHarnesses: () => Effect.succeed(harnesses),
    inspect: () => Effect.succeed({ ok: true, models, modes }),
    ...overrides,
  })
  const atoms = createCoachAtoms(client)
  registry.mount(atoms.coachStateAtom)
  const release = mountCoachAtoms(registry, atoms)
  return { registry, atoms, client, release }
}

const runningStream = (runId: string): Stream.Stream<CoachRunFrame, CoachRpcError> =>
  Stream.concat(Stream.make({ _tag: 'Started' as const, runId }), Stream.never)

const finishedStream = (runId: string, events: CoachRunFrame[] = []): Stream.Stream<CoachRunFrame, CoachRpcError> =>
  Stream.fromIterable([{ _tag: 'Started' as const, runId }, ...events])

const eventFrame = (runId: string, event: CoachEventEnvelope['event']): CoachRunFrame => ({
  _tag: 'Event',
  runId,
  event,
})

const waitFor = async (registry: AtomRegistry.AtomRegistry, predicate: () => boolean): Promise<void> => {
  await vi.waitFor(() => expect(predicate()).toBe(true))
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Coach native atom workflow', () => {
  it('derives harness status labels and badges without a DOM', () => {
    const warning: CoachHarnessRow = {
      instanceId: 'codex',
      kind: 'codex',
      displayName: 'Codex',
      status: 'warning',
      auth: { status: 'unknown' },
    }
    expect(statusLabel(warning.status)).toBe('Needs attention')
    expect(harnessBadge(warning)).toBe('Sign-in?')
    expect(harnessBadge({ ...warning, status: 'error' })).toBe('Unavailable')
    expect(harnessBadge({ ...warning, status: 'pending' })).toBe('Checking…')
  })

  it('owns conversation state per registry and hydrates the default harness', async () => {
    const first = setup()
    const second = setup()
    first.registry.set(first.atoms.loadHarnessesAtom, undefined)
    await waitFor(first.registry, () => first.registry.get(first.atoms.coachStateAtom).hydrated)

    expect(first.registry.get(first.atoms.coachStateAtom)).toMatchObject({
      harnessKind: 'claude',
      messages: [],
      running: false,
    })
    expect(second.registry.get(second.atoms.coachStateAtom)).toMatchObject({ hydrated: false, harnessKind: null })
    first.registry.dispose()
    second.registry.dispose()
  })

  it('switches auto-picks to a ready harness but keeps a user choice', () => {
    const { registry, atoms } = setup()
    const pending = (instanceId: string): CoachHarnessRow => ({
      instanceId,
      kind: instanceId,
      displayName: instanceId,
      status: 'pending',
      auth: { status: 'unknown' },
    })
    registry.set(atoms.replaceHarnessesAtom, [pending('claude'), pending('codex')])
    expect(registry.get(atoms.coachStateAtom).harnessKind).toBe('claude')
    registry.set(atoms.replaceHarnessesAtom, [
      { ...pending('claude'), status: 'error' },
      { ...pending('codex'), status: 'ready', auth: { status: 'configured' } },
    ])
    expect(registry.get(atoms.coachStateAtom).harnessKind).toBe('codex')
    registry.set(atoms.setHarnessAtom, 'claude')
    registry.set(atoms.replaceHarnessesAtom, [
      { ...pending('claude'), status: 'error' },
      { ...pending('codex'), status: 'ready', auth: { status: 'configured' } },
    ])
    expect(registry.get(atoms.coachStateAtom).harnessKind).toBe('claude')
    registry.dispose()
  })

  it('starts empty and chooses ready ahead of earlier warning or pending rows, never errors', () => {
    const { registry, atoms } = setup()
    expect(registry.get(atoms.coachStateAtom)).toMatchObject({
      hydrated: false,
      harnessKind: null,
      messages: [],
      running: false,
    })
    const row = (instanceId: string, state: CoachHarnessRow['status']): CoachHarnessRow => ({
      instanceId,
      kind: instanceId,
      displayName: instanceId,
      status: state,
      auth: { status: 'unknown' },
    })
    registry.set(atoms.replaceHarnessesAtom, [row('error', 'error'), row('warning', 'warning'), row('ready', 'ready')])
    expect(registry.get(atoms.coachStateAtom)).toMatchObject({ hydrated: true, harnessKind: 'ready' })
    registry.set(atoms.replaceHarnessesAtom, [row('error', 'error')])
    expect(registry.get(atoms.coachStateAtom).harnessKind).toBeNull()
    registry.dispose()
  })

  it('hydrates and refreshes harness rows through their Effect commands', async () => {
    const refreshed = [{ ...harnesses[1]!, instanceId: 'codex', kind: 'codex' }]
    const getCoachHarnesses = vi.fn(() => Effect.succeed(harnesses))
    const refreshCoachHarnesses = vi.fn(() => Effect.succeed(refreshed))
    const { registry, atoms } = setup({ harnesses: getCoachHarnesses, refreshHarnesses: refreshCoachHarnesses })
    registry.set(atoms.loadHarnessesAtom, undefined)
    await waitFor(registry, () => registry.get(atoms.coachStateAtom).hydrated)
    expect(registry.get(atoms.coachStateAtom).harnessKind).toBe('claude')
    registry.set(atoms.refreshHarnessesAtom, undefined)
    await waitFor(registry, () => registry.get(atoms.coachStateAtom).harnesses[0]?.instanceId === 'codex')
    expect(getCoachHarnesses).toHaveBeenCalledTimes(1)
    expect(refreshCoachHarnesses).toHaveBeenCalledTimes(1)
    registry.dispose()
  })

  it('caches successful probes by harness, restores picks, and leaves failed probes retryable', async () => {
    const inspect = vi.fn((request: string | { kind: string; allowApiKeyEnv?: boolean }) =>
      Effect.succeed(
        (typeof request === 'string' ? request : request.kind) === 'claude'
          ? { ok: true as const, models, modes }
          : { ok: false as const, error: 'offline' },
      ),
    )
    const { registry, atoms } = setup({ inspect })
    registry.set(atoms.replaceHarnessesAtom, harnesses)
    registry.set(atoms.inspectHarnessAtom, 'claude')
    await waitFor(registry, () => registry.get(atoms.coachStateAtom).modelsByKind.claude !== undefined)
    registry.set(atoms.setModelIdAtom, 'opus')
    registry.set(atoms.setHarnessAtom, 'gemini')
    registry.set(atoms.inspectHarnessAtom, 'gemini')
    await waitFor(registry, () => registry.get(atoms.coachStateAtom).inspectingKind === null)
    registry.set(atoms.setHarnessAtom, 'claude')
    expect(registry.get(atoms.coachStateAtom)).toMatchObject({ sessionModels: models, modelId: 'opus' })
    registry.set(atoms.setHarnessAtom, 'gemini')
    registry.set(atoms.inspectHarnessAtom, 'gemini')
    await waitFor(registry, () => inspect.mock.calls.length >= 3)
    expect(registry.get(atoms.coachStateAtom).modelsByKind.gemini).toBeUndefined()
    registry.dispose()
  })

  it.each(['loadHarnessesAtom', 'refreshHarnessesAtom'] as const)(
    'does not replace newer lifecycle harness rows with a late %s response',
    async command => {
      let resolve!: (rows: CoachHarnessRow[]) => void
      const delayed = () =>
        Effect.promise(
          () =>
            new Promise<CoachHarnessRow[]>(done => {
              resolve = done
            }),
        )
      const { registry, atoms } = setup({ harnesses: delayed, refreshHarnesses: delayed })
      registry.set(atoms[command], undefined)
      await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
      const newer = [{ ...harnesses[0]!, status: 'warning' as const, auth: { status: 'unauthenticated' as const } }]
      registry.set(atoms.replaceHarnessesAtom, newer)
      resolve(harnesses)
      await vi.waitFor(() => expect(registry.get(atoms[command])).toMatchObject({ _tag: 'Success', waiting: false }))
      expect(registry.get(atoms.coachStateAtom).harnesses).toEqual(newer)
      registry.dispose()
    },
  )

  it('caches a successful empty probe and suppresses duplicate probes for a kind in flight', async () => {
    let resolve!: (value: { ok: true }) => void
    const inspectCoachHarness = vi.fn((_request: CoachInspectRequest) =>
      Effect.promise(
        () =>
          new Promise<{ ok: true }>(done => {
            resolve = done
          }),
      ),
    )
    const { registry, atoms } = setup({ inspect: inspectCoachHarness })
    registry.set(atoms.inspectHarnessAtom, 'claude')
    await vi.waitFor(() => expect(inspectCoachHarness).toHaveBeenCalledTimes(1))
    registry.set(atoms.inspectHarnessAtom, 'claude')
    expect(inspectCoachHarness).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    resolve({ ok: true })
    await waitFor(registry, () => registry.get(atoms.coachStateAtom).inspectingKind === null)
    expect(registry.get(atoms.coachStateAtom).modelsByKind.claude).toEqual({
      models: null,
      modes: null,
      modelId: null,
      modeId: null,
    })
    registry.set(atoms.inspectHarnessAtom, 'claude')
    expect(inspectCoachHarness).toHaveBeenCalledTimes(1)
    registry.dispose()
  })

  it('caches a late probe for its original kind without replacing the newly selected harness', async () => {
    let resolveClaude!: (value: { ok: true; models: CoachSessionModels; modes: CoachSessionModes }) => void
    const inspectCoachHarness = vi.fn((request: CoachInspectRequest) => {
      const kind = typeof request === 'string' ? request : request.kind
      if (kind === 'claude')
        return Effect.promise(
          () =>
            new Promise<{ ok: true; models: CoachSessionModels; modes: CoachSessionModes }>(done => {
              resolveClaude = done
            }),
        )
      return Effect.succeed({ ok: true as const, models: { availableModels: [], currentModelId: 'default' } })
    })
    const { registry, atoms } = setup({ inspect: inspectCoachHarness })
    registry.set(atoms.replaceHarnessesAtom, harnesses)
    registry.set(atoms.inspectHarnessAtom, 'claude')
    await vi.waitFor(() => expect(resolveClaude).toBeTypeOf('function'))
    registry.set(atoms.setHarnessAtom, 'gemini')
    registry.set(atoms.inspectHarnessAtom, 'gemini')
    await vi.waitFor(() => expect(inspectCoachHarness).toHaveBeenCalledTimes(2))
    await waitFor(registry, () => registry.get(atoms.coachStateAtom).modelsByKind.gemini !== undefined)
    resolveClaude({ ok: true, models, modes })
    await waitFor(registry, () => registry.get(atoms.coachStateAtom).modelsByKind.claude !== undefined)
    expect(registry.get(atoms.coachStateAtom).modelsByKind.claude).toMatchObject({ models, modes })
    expect(registry.get(atoms.coachStateAtom)).toMatchObject({
      harnessKind: 'gemini',
      sessionModels: { availableModels: [] },
    })
    registry.dispose()
  })

  it('binds the Started frame before reducing the first streamed event and snapshots request state', async () => {
    const run = vi.fn(() =>
      finishedStream('run-1', [
        eventFrame('run-1', { kind: 'text', delta: 'fast ' }),
        eventFrame('run-1', { kind: 'error', message: 'fast failure' }),
      ]),
    )
    const { registry, atoms, release } = setup({ run })
    registry.set(periodAtom, 'lifetime')
    registry.set(preferencesAtom, { ...registry.get(preferencesAtom), allowHarnessApiKeyEnv: true })
    registry.set(atoms.replaceHarnessesAtom, harnesses)
    registry.set(atoms.sendCoachAtom, '  hello coach  ')
    await waitFor(registry, () => registry.get(atoms.coachStateAtom).messages.at(-1)?.error === 'fast failure')
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'hello coach',
        scope: registry.get(overviewScopeAtom),
        allowApiKeyEnv: true,
      }),
    )
    release()
    registry.dispose()
  })

  it('does not launch without a harness and reports a stream that ends before Started', async () => {
    const run = vi.fn(() => Stream.empty)
    const first = setup({ run })
    first.registry.set(first.atoms.sendCoachAtom, 'question')
    await waitFor(first.registry, () => first.registry.get(first.atoms.coachStateAtom).error !== null)
    expect(run).not.toHaveBeenCalled()
    expect(first.registry.get(first.atoms.coachStateAtom).error).toBe('Select a harness first.')
    first.registry.set(first.atoms.replaceHarnessesAtom, harnesses)
    first.registry.set(first.atoms.sendCoachAtom, 'question')
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    await waitFor(first.registry, () => !first.registry.get(first.atoms.coachStateAtom).running)
    expect(first.registry.get(first.atoms.coachStateAtom).error).toBeTruthy()
    expect(first.registry.get(first.atoms.coachStateAtom)).toMatchObject({ running: false, activeRunId: null })
    expect(first.registry.get(first.atoms.coachStateAtom).messages.at(-1)).toMatchObject({
      role: 'assistant',
      streaming: false,
      error: expect.any(String),
    })
    first.registry.dispose()
  })

  it('surfaces a typed RPC failure that arrives before Started', async () => {
    const failure = new CoachRpcError({ code: 'start-failed', message: 'Unable to start the Coach run.' })
    const { registry, atoms } = setup({ run: () => Stream.fail(failure) })
    registry.set(atoms.replaceHarnessesAtom, harnesses)
    registry.set(atoms.sendCoachAtom, 'question')

    await waitFor(registry, () => !registry.get(atoms.coachStateAtom).running)
    expect(registry.get(atoms.coachStateAtom)).toMatchObject({
      activeRunId: null,
      error: 'Unable to start the Coach run.',
    })
    expect(registry.get(atoms.coachStateAtom).messages.at(-1)).toMatchObject({
      role: 'assistant',
      streaming: false,
      error: 'Unable to start the Coach run.',
    })
    registry.dispose()
  })

  it('keeps a partial answer visible and marks it interrupted when the RPC connection fails', async () => {
    const disconnected = new RpcClientError({
      reason: new RpcClientDefect({ message: 'Connection lost', cause: new Error('socket closed') }),
    })
    const { registry, atoms } = setup({
      run: () =>
        finishedStream('run-disconnected', [
          eventFrame('run-disconnected', { kind: 'text', delta: 'partial answer' }),
        ]).pipe(Stream.concat(Stream.fail(disconnected))),
    })
    registry.set(atoms.replaceHarnessesAtom, harnesses)
    registry.set(atoms.sendCoachAtom, 'question')

    await waitFor(registry, () => !registry.get(atoms.coachStateAtom).running)
    expect(registry.get(atoms.coachStateAtom).messages.at(-1)).toMatchObject({
      content: 'partial answer',
      streaming: false,
      error: 'Connection lost. This partial response was interrupted; retry your message to continue.',
    })
    registry.dispose()
  })

  it('omits model and mode IDs until the harness declares those choices', async () => {
    const run = vi.fn<NonNullable<CoachRpcTestOverrides['run']>>(() => runningStream('run-1'))
    const { registry, atoms } = setup({ run })
    registry.set(atoms.setHarnessAtom, 'claude')
    registry.set(atoms.setModelIdAtom, 'custom-model')
    registry.set(atoms.setModeIdAtom, 'custom-mode')
    registry.set(atoms.sendCoachAtom, 'question')
    await waitFor(registry, () => run.mock.calls.length === 1)
    expect(run.mock.calls[0]?.[0]).not.toHaveProperty('modelId')
    expect(run.mock.calls[0]?.[0]).not.toHaveProperty('modeId')
    registry.dispose()
  })

  it('resumes from the last session cursor and snapshots the selected UI Scope on each run', async () => {
    let sequence = 0
    const run = vi.fn<NonNullable<CoachRpcTestOverrides['run']>>(() => runningStream(`run-${++sequence}`))
    const { registry, atoms } = setup({ run })
    registry.set(atoms.replaceHarnessesAtom, harnesses)
    registry.set(atoms.sendCoachAtom, 'first')
    await waitFor(registry, () => registry.get(atoms.coachStateAtom).activeRunId === 'run-1')
    registry.set(atoms.eventAtom, envelope('run-1', { kind: 'session', resumeCursor: 'resume-1' }))
    registry.set(atoms.eventAtom, envelope('run-1', { kind: 'status', state: 'done' }))
    registry.set(periodAtom, 'lifetime')
    registry.set(atoms.sendCoachAtom, 'second')
    await waitFor(registry, () => registry.get(atoms.coachStateAtom).activeRunId === 'run-2')
    expect(run.mock.calls[1]?.[0]).toMatchObject({
      prompt: 'second',
      resumeCursor: 'resume-1',
      scope: { period: 'lifetime' },
    })
    registry.dispose()
  })

  it('sends the picked model/mode only after the active harness declares them', async () => {
    let sequence = 0
    const run = vi.fn<NonNullable<CoachRpcTestOverrides['run']>>(() => runningStream(`run-${++sequence}`))
    const { registry, atoms } = setup({ run })
    registry.set(atoms.replaceHarnessesAtom, harnesses)
    registry.set(atoms.sendCoachAtom, 'first')
    await waitFor(registry, () => registry.get(atoms.coachStateAtom).activeRunId === 'run-1')
    registry.set(atoms.eventAtom, envelope('run-1', { kind: 'session', resumeCursor: 'resume-1', models, modes }))
    registry.set(atoms.eventAtom, envelope('run-1', { kind: 'status', state: 'done' }))
    registry.set(atoms.setModelIdAtom, 'opus')
    registry.set(atoms.setModeIdAtom, 'plan')
    registry.set(atoms.sendCoachAtom, 'second')
    await waitFor(registry, () => registry.get(atoms.coachStateAtom).activeRunId === 'run-2')
    expect(run.mock.calls[1]?.[0]).toMatchObject({ modelId: 'opus', modeId: 'plan' })
    expect(run.mock.calls[1]?.[0]).not.toHaveProperty('allowApiKeyEnv')
    registry.dispose()
  })

  it('reduces text, reasoning, paired tools, session identity and terminal errors into the owning message', async () => {
    const { registry, atoms } = setup()
    registry.set(atoms.replaceHarnessesAtom, harnesses)
    registry.set(atoms.sendCoachAtom, 'question')
    await waitFor(registry, () => registry.get(atoms.coachStateAtom).activeRunId === 'run-1')
    registry.set(atoms.eventAtom, envelope('run-1', { kind: 'reasoning', delta: 'thinking' }))
    registry.set(
      atoms.eventAtom,
      envelope('run-1', { kind: 'tool', tool: 'Read', id: 't1', state: 'started', input: '{"path":"a"}' }),
    )
    registry.set(
      atoms.eventAtom,
      envelope('run-1', { kind: 'tool', tool: 'Read', id: 't1', state: 'started', title: 'Read file' }),
    )
    registry.set(
      atoms.eventAtom,
      envelope('run-1', { kind: 'tool', tool: 'Read', id: 't1', state: 'completed', output: 'file' }),
    )
    registry.set(atoms.eventAtom, envelope('run-1', { kind: 'session', resumeCursor: 'resume-1', models, modes }))
    registry.set(atoms.eventAtom, envelope('run-1', { kind: 'error', message: 'auth required' }))
    const state = registry.get(atoms.coachStateAtom)
    expect(state).toMatchObject({ running: false, activeRunId: null, resumeCursor: 'resume-1' })
    expect(state.messages.at(-1)).toMatchObject({ thinking: 'thinking', error: 'auth required', streaming: false })
    expect(state.messages.at(-1)?.tools).toEqual([
      { tool: 'Read', id: 't1', state: 'completed', input: '{"path":"a"}', title: 'Read file', output: 'file' },
    ])
    expect(state.modelsByKind.claude).toMatchObject({ models, modes })
    registry.dispose()
  })

  it('interrupts a pending run stream when reset wins before Started', async () => {
    let startStream!: (runId: string) => void
    let streamInterrupted = false
    const run = vi.fn(() =>
      Stream.fromEffect(
        Effect.promise(
          () =>
            new Promise<string>(resolve => {
              startStream = resolve
            }),
        ),
      ).pipe(
        Stream.flatMap(runId => runningStream(runId)),
        Stream.ensuring(Effect.sync(() => (streamInterrupted = true))),
      ),
    )
    const reset = vi.fn(() => Effect.void)
    const { registry, atoms, release } = setup({ run, reset })
    registry.set(atoms.replaceHarnessesAtom, harnesses)
    registry.set(atoms.sendCoachAtom, 'question')
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    registry.set(atoms.resetSessionAtom, undefined)
    await waitFor(registry, () => reset.mock.calls.length === 1)
    await waitFor(registry, () => streamInterrupted)
    startStream('late-run')
    expect(registry.get(atoms.coachStateAtom)).toMatchObject({ messages: [], activeRunId: null, running: false })
    release()
    registry.dispose()
  })

  it('interrupts a pending run stream immediately when cancelled before Started', async () => {
    let releaseStarted!: (runId: string) => void
    let streamInterrupted = false
    const run = vi.fn(() =>
      Stream.fromEffect(
        Effect.promise(
          () =>
            new Promise<string>(resolve => {
              releaseStarted = resolve
            }),
        ),
      ).pipe(
        Stream.flatMap(runId => runningStream(runId)),
        Stream.ensuring(Effect.sync(() => (streamInterrupted = true))),
      ),
    )
    const { registry, atoms } = setup({ run })
    registry.set(atoms.replaceHarnessesAtom, harnesses)
    registry.set(atoms.sendCoachAtom, 'question')
    await waitFor(registry, () => run.mock.calls.length === 1)
    expect(registry.get(atoms.coachStateAtom)).toMatchObject({ running: true, activeRunId: null })

    registry.set(atoms.cancelAtom, undefined)
    await waitFor(registry, () => streamInterrupted)
    expect(registry.get(atoms.coachStateAtom)).toMatchObject({ running: false, activeRunId: null })

    releaseStarted('late-run')
    await Promise.resolve()
    expect(registry.get(atoms.coachStateAtom)).toMatchObject({ running: false, activeRunId: null })
    expect(registry.get(atoms.coachStateAtom).messages.at(-1)).toMatchObject({
      content: '',
      streaming: false,
      error: 'cancelled',
    })
    registry.dispose()
  })

  it('resets conversation and resume state while restoring the current harness capability cache', async () => {
    const reset = vi.fn(() => Effect.void)
    const { registry, atoms } = setup({ reset })
    registry.set(atoms.replaceHarnessesAtom, harnesses)
    registry.set(atoms.inspectHarnessAtom, 'claude')
    await waitFor(registry, () => registry.get(atoms.coachStateAtom).modelsByKind.claude !== undefined)
    registry.set(atoms.setModelIdAtom, 'opus')
    registry.set(atoms.setModeIdAtom, 'plan')
    registry.set(atoms.sendCoachAtom, 'question')
    await waitFor(registry, () => registry.get(atoms.coachStateAtom).activeRunId === 'run-1')
    registry.set(atoms.eventAtom, envelope('run-1', { kind: 'session', resumeCursor: 'resume-1' }))
    registry.set(atoms.resetSessionAtom, undefined)
    await waitFor(registry, () => reset.mock.calls.length === 1)
    expect(registry.get(atoms.coachStateAtom)).toMatchObject({
      messages: [],
      resumeCursor: null,
      harnessKind: 'claude',
      sessionModels: models,
      sessionModes: modes,
      modelId: 'opus',
      modeId: 'plan',
    })
    expect(registry.get(atoms.coachStateAtom).modelsByKind.claude).toMatchObject({ models, modes })
    registry.dispose()
  })

  it('cancel marks the turn immediately and late payloads cannot revive a different run', async () => {
    const cancel = vi.fn(() => Effect.void)
    const { registry, atoms } = setup({ cancel })
    registry.set(atoms.replaceHarnessesAtom, harnesses)
    registry.set(atoms.sendCoachAtom, 'question')
    await waitFor(registry, () => registry.get(atoms.coachStateAtom).activeRunId === 'run-1')
    registry.set(atoms.cancelAtom, undefined)
    await waitFor(registry, () => cancel.mock.calls.length === 1)
    expect(registry.get(atoms.coachStateAtom)).toMatchObject({ running: false, activeRunId: null })
    expect(registry.get(atoms.coachStateAtom).messages.at(-1)).toMatchObject({ error: 'cancelled', streaming: false })
    registry.set(atoms.eventAtom, envelope('run-1', { kind: 'error', message: 'late failure' }))
    expect(registry.get(atoms.coachStateAtom).messages.at(-1)).toMatchObject({ error: 'cancelled' })
    registry.set(atoms.eventAtom, envelope('run-1', { kind: 'text', delta: 'late text' }))
    expect(registry.get(atoms.coachStateAtom).messages.at(-1)).toMatchObject({
      content: '',
      error: 'cancelled',
    })
    registry.set(atoms.eventAtom, envelope('run-1', { kind: 'tool', tool: 'Read', id: 't1', state: 'completed' }))
    expect(registry.get(atoms.coachStateAtom).messages.at(-1)?.tools).toEqual([])
    registry.dispose()
  })

  it('keeps idless tool events distinct and merges id-paired re-announcements without reopening completion', async () => {
    const { registry, atoms } = setup()
    registry.set(atoms.replaceHarnessesAtom, harnesses)
    registry.set(atoms.sendCoachAtom, 'question')
    await waitFor(registry, () => registry.get(atoms.coachStateAtom).activeRunId === 'run-1')
    registry.set(atoms.eventAtom, envelope('run-1', { kind: 'tool', tool: 'Read', id: 'paired', state: 'completed' }))
    registry.set(
      atoms.eventAtom,
      envelope('run-1', { kind: 'tool', tool: 'Read', id: 'paired', state: 'started', input: 'args' }),
    )
    registry.set(
      atoms.eventAtom,
      envelope('run-1', { kind: 'tool', tool: 'Read', state: 'completed', output: 'first' }),
    )
    registry.set(
      atoms.eventAtom,
      envelope('run-1', { kind: 'tool', tool: 'Read', state: 'completed', output: 'second' }),
    )
    expect(registry.get(atoms.coachStateAtom).messages.at(-1)?.tools).toEqual([
      { tool: 'Read', id: 'paired', state: 'completed', input: 'args' },
      { tool: 'Read', state: 'completed', output: 'first' },
      { tool: 'Read', state: 'completed', output: 'second' },
    ])
    registry.dispose()
  })

  it('fences a run when the selected harness changes and routes later session events only by source identity', async () => {
    const cancel = vi.fn(() => Effect.void)
    const { registry, atoms } = setup({ cancel })
    registry.set(atoms.replaceHarnessesAtom, harnesses)
    registry.set(atoms.sendCoachAtom, 'question')
    await waitFor(registry, () => registry.get(atoms.coachStateAtom).activeRunId === 'run-1')
    registry.set(atoms.setHarnessAtom, 'gemini')
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith('run-1'))
    registry.set(atoms.eventAtom, envelope('run-1', { kind: 'session', resumeCursor: 'stale', models, modes }))
    expect(registry.get(atoms.coachStateAtom)).toMatchObject({
      harnessKind: 'gemini',
      running: false,
      activeRunId: null,
      resumeCursor: null,
      sessionModels: null,
    })
    registry.dispose()
  })

  it('cancels and closes a run when its selected harness disappears with no replacement', async () => {
    const cancel = vi.fn(() => Effect.void)
    const { registry, atoms } = setup({ cancel })
    registry.set(atoms.replaceHarnessesAtom, harnesses)
    registry.set(atoms.sendCoachAtom, 'question')
    await waitFor(registry, () => registry.get(atoms.coachStateAtom).activeRunId === 'run-1')

    registry.set(atoms.replaceHarnessesAtom, [])
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith('run-1'))
    expect(registry.get(atoms.coachStateAtom)).toMatchObject({ harnessKind: null, running: false, activeRunId: null })
    expect(registry.get(atoms.coachStateAtom).messages.at(-1)).toMatchObject({ streaming: false, error: 'cancelled' })
    registry.dispose()
  })

  it('retry replaces only the final assistant turn while retaining its user prompt', async () => {
    let run = 0
    const start = vi.fn(() => runningStream(`run-${++run}`))
    const { registry, atoms } = setup({ run: start })
    registry.set(atoms.replaceHarnessesAtom, harnesses)
    registry.set(atoms.sendCoachAtom, 'same prompt')
    await waitFor(registry, () => registry.get(atoms.coachStateAtom).activeRunId === 'run-1')
    registry.set(atoms.eventAtom, envelope('run-1', { kind: 'status', state: 'done' }))
    const before = registry.get(atoms.coachStateAtom).messages
    const assistant = before.at(-1)
    expect(assistant?.role).toBe('assistant')
    if (!assistant) throw new Error('The first run should create an assistant turn.')
    registry.set(atoms.retryAssistantAtom, 'not-the-last-assistant')
    expect(start).toHaveBeenCalledTimes(1)
    registry.set(atoms.retryAssistantAtom, assistant.id)
    await waitFor(registry, () => registry.get(atoms.coachStateAtom).activeRunId === 'run-2')
    expect(registry.get(atoms.coachStateAtom).messages).toHaveLength(2)
    expect(registry.get(atoms.coachStateAtom).messages[0]).toMatchObject({ role: 'user', content: 'same prompt' })
    expect(start).toHaveBeenLastCalledWith(
      expect.objectContaining({ prompt: 'same prompt', scope: { period: 'today' } }),
    )
    registry.set(atoms.retryAssistantAtom, assistant.id)
    expect(start).toHaveBeenCalledTimes(2)
    registry.dispose()
  })

  it('refuses retry for streaming, user, non-final, or currently running turns', async () => {
    let sequence = 0
    const run = vi.fn(() => runningStream(`run-${++sequence}`))
    const { registry, atoms } = setup({ run })
    registry.set(atoms.replaceHarnessesAtom, harnesses)
    registry.set(atoms.sendCoachAtom, 'first prompt')
    await waitFor(registry, () => registry.get(atoms.coachStateAtom).activeRunId === 'run-1')
    const firstAssistant = registry.get(atoms.coachStateAtom).messages.at(-1)!
    const firstUser = registry.get(atoms.coachStateAtom).messages[0]!
    registry.set(atoms.retryAssistantAtom, firstAssistant.id)
    registry.set(atoms.retryAssistantAtom, firstUser.id)
    expect(run).toHaveBeenCalledTimes(1)
    registry.set(atoms.eventAtom, envelope('run-1', { kind: 'status', state: 'done' }))
    registry.set(atoms.sendCoachAtom, 'second prompt')
    await waitFor(registry, () => registry.get(atoms.coachStateAtom).activeRunId === 'run-2')
    registry.set(atoms.retryAssistantAtom, firstAssistant.id)
    expect(run).toHaveBeenCalledTimes(2)
    registry.set(atoms.eventAtom, envelope('run-2', { kind: 'status', state: 'done' }))
    const secondAssistant = registry.get(atoms.coachStateAtom).messages.at(-1)!
    registry.set(atoms.retryAssistantAtom, secondAssistant.id)
    await waitFor(registry, () => registry.get(atoms.coachStateAtom).activeRunId === 'run-3')
    expect(run).toHaveBeenCalledTimes(3)
    registry.dispose()
  })

  it('keeps detection lazy until selected, keyed by Scope and thresholds with same-key refresh semantics', async () => {
    const getSkills = vi.fn(async () => null)
    const { registry, atoms } = setup({ skills: getSkills })
    registry.mount(atoms.detection.resultAtom)
    expect(getSkills).not.toHaveBeenCalled()
    registry.set(atoms.detection.requestAtom, { scope: { period: 'today' }, frequency: 5, spread: 2 })
    await waitFor(registry, () => getSkills.mock.calls.length === 1)
    registry.set(atoms.detection.requestAtom, { scope: { period: 'today' }, frequency: 5, spread: 2 })
    expect(getSkills).toHaveBeenCalledTimes(1)
    registry.set(atoms.detection.refreshAtom, undefined)
    await waitFor(registry, () => getSkills.mock.calls.length === 2)
    registry.dispose()
  })
})
