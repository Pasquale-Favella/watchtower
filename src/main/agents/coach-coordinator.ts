import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Queue from 'effect/Queue'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'

import {
  type CoachEvent,
  coachInspectRequestSchema,
  type CoachInspectResult,
  type CoachRunRequest,
  coachRunRequestSchema,
  type CoachRunResult,
} from '../../shared/schemas/agents.js'
import type { OverviewScope } from '../../shared/schemas/overview.js'
import type { MainRuntime, MainServices } from '../main-runtime.js'
import { logCodeFor, safeLogOperationalEvent } from '../operational-log.js'
import { CoachSdkFailure, coachSdkFailureMessage } from './coach-errors.js'
import { coachProtocolError } from './coach-protocol-errors.js'
import type { CoachRunner, LedgerMcpAttachment, NativeCoachRunnerCapabilities, NativeHarnessSource } from './ipc.js'
import { buildCoachPrompt, buildLedgerBriefing, buildScopeUpdate } from './prompts.js'
import { decodeResumeCursor } from './resume-cursor.js'
import {
  CoachHarnessExecution,
  type HarnessProviderInput,
  type HarnessRunInput,
  isAuthFailureMessage,
  type NativeHarnessInspection,
  type NativeHarnessRun,
} from './runtime.js'

export interface CoachCoordinatorDeps {
  readonly runtime: MainRuntime
  readonly harnesses: NativeHarnessSource
  readonly startRun: (input: HarnessRunInput) => Effect.Effect<NativeHarnessRun, Error, CoachHarnessExecution>
  readonly startInspection: (
    input: HarnessProviderInput,
  ) => Effect.Effect<NativeHarnessInspection, Error, CoachHarnessExecution>
  readonly ledgerMcpServer: (harnessKind: string) => Effect.Effect<LedgerMcpAttachment | null, unknown, MainServices>
}

interface ActiveRun {
  readonly run: NativeHarnessRun
  fiber?: Fiber.Fiber<void, unknown>
  readonly kind: string
}

interface ProbeRequest {
  readonly kind: string
  readonly allowApiKeyEnv: boolean
  readonly generation: number
  readonly reply: Deferred.Deferred<Exit.Exit<CoachInspectResult, unknown>>
}

interface ActiveProbe {
  readonly inspection: NativeHarnessInspection
  readonly fiber: Fiber.Fiber<CoachInspectResult, unknown>
  readonly reply: Deferred.Deferred<Exit.Exit<CoachInspectResult, unknown>>
}

const cancelledProbeResult: CoachInspectResult = { ok: false, error: 'conversation reset' }
const supersededProbeResult: CoachInspectResult = { ok: false, error: 'superseded' }

function deleteWorkspace(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // A leftover temp workspace is harmless; shutdown must continue.
  }
}

/**
 * Effect-native Coach orchestration for production. Promise APIs are kept at
 * the Electron IPC edge; SDK work, event pumps, cancellation, probe ordering,
 * and cleanup are fibers in the existing app runtime scope.
 */
export function createCoachCoordinator(deps: CoachCoordinatorDeps): CoachRunner {
  const activeRuns = new Map<string, ActiveRun>()
  // A harness can finish allocating a run before startWithId has registered
  // it in activeRuns. Keep that handle visible to the start finalizer during
  // this short admission window so interruption cannot orphan it.
  const startingRuns = new Map<string, NativeHarnessRun>()
  const inFlightStarts = new Map<string, Deferred.Deferred<undefined>>()
  const cancelWaiters = new Map<string, Deferred.Deferred<undefined>>()
  const cancelPromises = new Map<string, Promise<void>>()
  const attachments = new Map<string, { readonly attachment: LedgerMcpAttachment; readonly generation: number }>()
  let activeProbe: ActiveProbe | undefined
  let dequeuedProbe: ProbeRequest | undefined
  let queuedProbe: ProbeRequest | undefined
  let workspace: string | null = null
  let generation = 0
  let briefedScopeKey: string | null = null
  let closed = false

  const releaseAttachment = (runId: string): void => {
    const owned = attachments.get(runId)
    if (!owned) return
    attachments.delete(runId)
    releaseOne(owned.attachment)
  }

  const releaseOne = (attachment: LedgerMcpAttachment): void => {
    try {
      attachment.release()
    } catch {
      // The attachment is no longer ours even when its release hook fails.
    }
  }

  const workspacePath = (): string => (workspace ??= mkdtempSync(join(tmpdir(), 'watchtower-coach-')))

  const inspectOne = (request: ProbeRequest): Effect.Effect<CoachInspectResult, unknown, MainServices> =>
    Effect.gen(function* () {
      const instance = yield* deps.harnesses.get(request.kind)
      if (request.generation !== generation || closed) return cancelledProbeResult
      const harness = instance?.info
      if (!harness) return { ok: false, error: `harness not detected: ${request.kind}` }
      const input = {
        harness,
        workspacePath: workspacePath(),
        ...(request.allowApiKeyEnv ? { allowApiKeyEnv: true as const } : {}),
      }
      const inspection = yield* deps.startInspection(input)
      if (request.generation !== generation || closed) {
        yield* inspection.stop.pipe(Effect.catchCause(() => Effect.void))
        return cancelledProbeResult
      }
      const fiber = yield* Effect.forkChild(
        Effect.map(inspection.result, result =>
          request.generation === generation && !closed
            ? {
                ok: true as const,
                ...(result.models ? { models: result.models } : {}),
                ...(result.modes ? { modes: result.modes } : {}),
              }
            : cancelledProbeResult,
        ),
      )
      activeProbe = { inspection, fiber, reply: request.reply }
      const result = yield* Fiber.join(fiber).pipe(
        Effect.catch(error =>
          request.generation !== generation || closed
            ? Effect.succeed(cancelledProbeResult)
            : error instanceof CoachSdkFailure
              ? Effect.succeed({ ok: false as const, error: coachSdkFailureMessage('The agent', error) })
              : Effect.fail(error),
        ),
      )
      if (activeProbe?.fiber === fiber) activeProbe = undefined
      return result
    })

  const probeRequests = deps.runtime.runSync(Queue.dropping<true>(1))
  const probeActor: Effect.Effect<never, never, MainServices> = Effect.forever(
    Effect.gen(function* () {
      yield* Queue.take(probeRequests)
      while (dequeuedProbe) {
        const current = dequeuedProbe
        const result = yield* Effect.exit(inspectOne(current))
        if (dequeuedProbe === current) {
          dequeuedProbe = queuedProbe
          queuedProbe = undefined
        }
        yield* Deferred.succeed(current.reply, result)
      }
    }),
  )

  const stopRun = (runId: string, owned: ActiveRun): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (activeRuns.get(runId) === owned) activeRuns.delete(runId)
      releaseAttachment(runId)
      yield* owned.run.stop
      if (owned.fiber) yield* Fiber.interrupt(owned.fiber)
      safeLogOperationalEvent('info', 'harness.cancel', { kind: owned.kind })
    }).pipe(Effect.catchCause(() => Effect.void))

  const cancelEffect = Effect.fnUntraced(function* (runId: string) {
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const existing = cancelWaiters.get(runId)
        if (existing) return yield* Deferred.await(existing)
        const owned = activeRuns.get(runId)
        if (!owned) return
        const waiter = yield* Deferred.make<undefined>()
        cancelWaiters.set(runId, waiter)
        yield* stopRun(runId, owned)
        yield* Deferred.succeed(waiter, undefined)
        if (cancelWaiters.get(runId) === waiter) cancelWaiters.delete(runId)
      }),
    )
  })

  const resetEffect: Effect.Effect<void> = Effect.uninterruptible(
    Effect.gen(function* () {
      const resetGeneration = ++generation
      const queued = queuedProbe
      const current = dequeuedProbe
      const probe = activeProbe
      queuedProbe = undefined
      dequeuedProbe = undefined
      activeProbe = undefined
      const toStop = [...activeRuns.entries()].filter(([runId]) => !cancelWaiters.has(runId))
      const existingCancellations = [...cancelWaiters.entries()]
      const starting = [...startingRuns.entries()]
      const pendingStarts = [...inFlightStarts.values()]
      const priorWorkspace = workspace
      workspace = null
      briefedScopeKey = null
      for (const [runId, owned] of attachments) {
        if (owned.generation < resetGeneration) releaseAttachment(runId)
      }
      if (queued) yield* Deferred.succeed(queued.reply, Exit.succeed(cancelledProbeResult))
      if (current) yield* Deferred.succeed(current.reply, Exit.succeed(cancelledProbeResult))
      if (probe) {
        yield* Deferred.succeed(probe.reply, Exit.succeed(cancelledProbeResult))
        yield* probe.inspection.stop.pipe(Effect.catchCause(() => Effect.void))
        yield* Fiber.interrupt(probe.fiber).pipe(
          Effect.asVoid,
          Effect.catchCause(() => Effect.void),
        )
      }
      yield* Effect.forEach(toStop, ([runId, owned]) => stopRun(runId, owned), {
        concurrency: 'unbounded',
        discard: true,
      })
      yield* Effect.forEach(
        starting,
        ([runId, run]) =>
          Effect.sync(() => startingRuns.delete(runId)).pipe(
            Effect.andThen(run.stop),
            Effect.catchCause(() => Effect.void),
            Effect.andThen(Effect.sync(() => releaseAttachment(runId))),
          ),
        { concurrency: 'unbounded', discard: true },
      )
      yield* Effect.forEach(
        existingCancellations,
        ([runId, waiter]) =>
          Deferred.await(waiter).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (cancelWaiters.get(runId) === waiter) cancelWaiters.delete(runId)
              }),
            ),
          ),
        { concurrency: 'unbounded', discard: true },
      )
      yield* Effect.forEach(pendingStarts, Deferred.await, { concurrency: 'unbounded', discard: true })
      if (priorWorkspace) yield* Effect.sync(() => deleteWorkspace(priorWorkspace))
    }),
  )

  // This fiber is a scope finalizer for the shared conversation state. Its
  // lifetime is the MainRuntime scope; explicit dispose/reset remains an IPC
  // edge but is not the only cleanup owner.
  deps.runtime.runFork(
    Effect.ensuring(
      Effect.never,
      Effect.uninterruptible(Effect.sync(() => (closed = true)).pipe(Effect.andThen(resetEffect))),
    ),
  )
  deps.runtime.runFork(probeActor)

  const startWithIdEffect = Effect.fnUntraced(function* (
    request: unknown,
    emit: (runId: string, event: CoachEvent) => void,
    runId: string,
  ) {
    const parsed = Schema.decodeUnknownResult(coachRunRequestSchema)(request)
    if (parsed._tag === 'Failure') return { ok: false as const, error: 'invalid coach run request' }
    const req: CoachRunRequest = parsed.success
    const userPrompt = req.prompt
    if (!userPrompt || !userPrompt.trim()) return { ok: false as const, error: 'coach run requires a prompt' }
    const runGeneration = generation
    if (closed) return { ok: false as const, error: 'conversation reset' }
    const instance = yield* deps.harnesses.get(req.harnessKind)
    if (runGeneration !== generation || closed) return { ok: false as const, error: 'conversation reset' }
    if (!instance?.info) return { ok: false as const, error: `harness not detected: ${req.harnessKind}` }
    const harness = instance.info
    const attachment = yield* Effect.uninterruptibleMask(() =>
      deps.ledgerMcpServer(req.harnessKind).pipe(
        Effect.catch(() => Effect.succeed(null)),
        Effect.tap(acquired =>
          acquired
            ? Effect.sync(() => attachments.set(runId, { attachment: acquired, generation: runGeneration }))
            : Effect.void,
        ),
      ),
    )
    if (runGeneration !== generation || closed) {
      releaseAttachment(runId)
      return { ok: false as const, error: 'conversation reset' }
    }
    const ledgerServer = attachment?.server ?? null
    const scope: OverviewScope = req.scope ?? { period: 'lifetime' }
    const sessionId = req.resumeCursor ? decodeResumeCursor(req.resumeCursor, instance.instanceId) : undefined
    const firstRun = !sessionId
    const resumeLost = !!req.resumeCursor && !sessionId
    const scopeKey = JSON.stringify({
      period: scope.period,
      provider: scope.provider ?? null,
      range: scope.range ? { since: scope.range.since, until: scope.range.until } : null,
    })
    const freshPrompt = buildCoachPrompt(userPrompt, ledgerServer ? buildLedgerBriefing(scope) : '')
    const prompt = firstRun
      ? freshPrompt
      : buildCoachPrompt(userPrompt, ledgerServer && briefedScopeKey !== scopeKey ? buildScopeUpdate(scope) : '')
    if (ledgerServer) briefedScopeKey = scopeKey
    const input: HarnessRunInput = {
      harness,
      workspacePath: workspacePath(),
      prompt,
      ...(req.modelId ? { modelId: req.modelId } : {}),
      ...(req.modeId ? { modeId: req.modeId } : {}),
      ...(req.allowApiKeyEnv ? { allowApiKeyEnv: true as const } : {}),
      ...(sessionId ? { sessionId } : {}),
      freshPrompt,
      mcpServers: ledgerServer ? [ledgerServer] : [],
    }
    const started = yield* Effect.uninterruptibleMask(() =>
      deps.startRun(input).pipe(
        Effect.tap(run => Effect.sync(() => startingRuns.set(runId, run))),
        Effect.map(run => ({ _tag: 'Started' as const, run })),
        Effect.catch(error => Effect.succeed({ _tag: 'Failed' as const, error })),
      ),
    )
    if (started._tag === 'Failed') {
      startingRuns.delete(runId)
      releaseAttachment(runId)
      return started.error instanceof CoachSdkFailure
        ? { ok: false as const, error: coachSdkFailureMessage(harness.displayName, started.error) }
        : yield* Effect.fail(started.error)
    }
    const run = started.run
    if (runGeneration !== generation || closed) {
      startingRuns.delete(runId)
      releaseAttachment(runId)
      yield* run.stop
      return { ok: false as const, error: 'conversation reset' }
    }
    const owned: ActiveRun = { run, kind: req.harnessKind }
    activeRuns.set(runId, owned)
    startingRuns.delete(runId)
    const canPublish = (): boolean => activeRuns.get(runId)?.run === run && runGeneration === generation && !closed
    if (resumeLost)
      emit(runId, {
        kind: 'notice',
        message: 'The previous session could not be restored — continuing in a fresh session.',
      })
    if (firstRun && !ledgerServer)
      emit(runId, {
        kind: 'notice',
        message: 'Ledger data is not available yet (no scan found) — answers will not be grounded in your usage data.',
      })
    safeLogOperationalEvent('info', 'harness.start', { kind: req.harnessKind })
    let terminalEmitted = false
    const pump = Stream.fromAsyncIterable(run.events, error => error).pipe(
      Stream.runForEach(event =>
        Effect.gen(function* () {
          if (!canPublish()) return
          if (event.kind === 'status' && event.state === 'done')
            if (deps.harnesses.reportAuth)
              yield* deps.harnesses.reportAuth(instance.instanceId, 'configured').pipe(Effect.catch(() => Effect.void))
          if (event.kind === 'error' && isAuthFailureMessage(event.message))
            if (deps.harnesses.reportAuth)
              yield* deps.harnesses
                .reportAuth(instance.instanceId, 'unauthenticated')
                .pipe(Effect.catch(() => Effect.void))
          if (event.kind === 'error' || (event.kind === 'status' && event.state === 'done')) terminalEmitted = true
          emit(runId, event)
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          if (canPublish()) {
            if (!terminalEmitted) {
              terminalEmitted = true
              emit(runId, { kind: 'status', state: 'done' })
            }
            safeLogOperationalEvent('info', 'harness.finish', { kind: req.harnessKind })
          }
        }),
      ),
      Effect.catch(error =>
        Effect.sync(() => {
          if (!canPublish()) return
          emit(runId, { kind: 'error', message: coachProtocolError(error) })
          safeLogOperationalEvent('error', 'harness.error', { kind: req.harnessKind, code: logCodeFor(error) })
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (activeRuns.get(runId) === owned) activeRuns.delete(runId)
          releaseAttachment(runId)
        }),
      ),
    )
    owned.fiber = deps.runtime.runFork(pump)
    return { ok: true as const, runId }
  })
  const startEffect = (
    request: unknown,
    emit: (runId: string, event: CoachEvent) => void,
    onRunId?: (runId: string) => void,
  ) => {
    const runId = randomUUID()
    onRunId?.(runId)
    let completed: Deferred.Deferred<undefined> | undefined
    return Effect.gen(function* () {
      completed = yield* Deferred.make<undefined>()
      inFlightStarts.set(runId, completed)
      return yield* startWithIdEffect(request, emit, runId)
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() => {
          inFlightStarts.delete(runId)
          const finish = completed ? Deferred.succeed(completed, undefined) : Effect.void
          if (!activeRuns.has(runId)) {
            const starting = startingRuns.get(runId)
            startingRuns.delete(runId)
            if (starting)
              return starting.stop.pipe(
                Effect.catchCause(() => Effect.void),
                Effect.andThen(Effect.sync(() => releaseAttachment(runId))),
                Effect.andThen(finish),
              )
            releaseAttachment(runId)
          }
          return finish
        }),
      ),
    )
  }

  const native: NativeCoachRunnerCapabilities = {
    list: deps.harnesses.list(),
    refresh: deps.harnesses.refresh(),
    inspect: Effect.fnUntraced(function* (request: unknown) {
      if (closed) return cancelledProbeResult
      const parsed = Schema.decodeUnknownResult(coachInspectRequestSchema)(request)
      if (parsed._tag === 'Failure') return { ok: false as const, error: 'invalid coach inspect request' }
      const input =
        typeof parsed.success === 'string'
          ? { kind: parsed.success, allowApiKeyEnv: false }
          : { kind: parsed.success.kind, allowApiKeyEnv: parsed.success.allowApiKeyEnv ?? false }
      const reply = yield* Deferred.make<Exit.Exit<CoachInspectResult, unknown>>()
      const next = { ...input, generation, reply }
      if (dequeuedProbe) {
        if (queuedProbe) yield* Deferred.succeed(queuedProbe.reply, Exit.succeed(supersededProbeResult))
        queuedProbe = next
      } else {
        dequeuedProbe = next
      }
      yield* Queue.offer(probeRequests, true)
      const result = yield* Deferred.await(reply)
      return Exit.isFailure(result) ? yield* Effect.failCause(result.cause) : result.value
    }),
    start: startEffect,
    cancel: runId => cancelEffect(runId),
    reset: resetEffect,
  }

  return {
    native,
    harnesses: () => deps.runtime.runPromise(native.list),
    refreshHarnesses: () => deps.runtime.runPromise(native.refresh),

    inspect(request: unknown): Promise<CoachInspectResult> {
      return deps.runtime.runPromise(native.inspect(request))
    },

    start(request: unknown, emit: (runId: string, event: CoachEvent) => void): Promise<CoachRunResult> {
      return deps.runtime.runPromise(native.start(request, emit))
    },

    cancel(runId: string): Promise<void> {
      const existing = cancelPromises.get(runId)
      if (existing) return existing
      const pending = deps.runtime.runPromise(native.cancel(runId)).finally(() => cancelPromises.delete(runId))
      cancelPromises.set(runId, pending)
      return pending
    },

    reset: () => deps.runtime.runPromise(native.reset),
    dispose: async () => {
      closed = true
      await deps.runtime.runPromise(resetEffect)
    },
  }
}
