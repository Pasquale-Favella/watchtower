import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Schema from 'effect/Schema'

import {
  type CoachEvent,
  type CoachHarnessRow,
  type CoachInspectResult,
  type CoachLoginTerminalResult,
  coachOpenLoginTerminalRequestSchema,
  type CoachRunResult,
} from '../../shared/schemas/agents.js'
import type { MainRuntime, MainServices } from '../main-runtime.js'
import { createCoachCoordinator } from './coach-coordinator.js'
import { harnessSpecs } from './harnesses/index.js'
import type { AcpMcpServer } from './harnesses/types.js'
import { openLoginTerminal } from './login-terminal.js'
import {
  CoachHarnessExecution,
  type HarnessProviderInput,
  type HarnessRunInput,
  type NativeHarnessInspection,
  type NativeHarnessRun,
} from './runtime.js'
import { type HarnessInstance, HarnessSnapshot } from './snapshot.js'

/**
 * Coach & Skills backend (ADR 0017, reshaped by map 53): the connection between
 * the HarnessRuntime seam and the app's unified Coach & Skills surface.
 * `createCoachRunner` adapts the Effect coordinator for tests;
 * `createApplicationAgents` combines it with the app-owned harness snapshot
 * and runtime for the versioned RPC handlers.
 *
 * No workspace picker anymore (map 53): the runner owns a private temp
 * workspace per conversation — a resumed run (sessionId present) reuses the
 * conversation's dir; a fresh run (no sessionId) clears the old one and
 * starts a new one; `coach:reset` + app quit clean it up. The harness gets
 * the platform's own data through the INJECTED in-app ledger MCP server
 * (map 53), scoped to the current UI scope the renderer sends on `coach:run`.
 *
 */

/** An acquired ledger MCP attachment: the session server config plus the
 *  release that ends this holder's claim on it. TODAY both implementations of
 *  that claim are a no-op — stdio servers are agent-spawned and harness-owned
 *  (ADR 0027), and the HTTP sidecar is app-scoped and released by the pool on
 *  app quit — so the release is a contract, not yet a resource. What the
 *  contract must survive is the runner: it ends the claim from BOTH owners,
 *  the run's settle path (the fast path) and the conversation's teardown on
 *  `reset`/`dispose`. A run whose generator never settles — a wedged ACP child,
 *  an interruption that never reaches the `finally` — therefore cannot keep a
 *  claim past the conversation that asked for it, so the first `release` that
 *  is not a no-op is already covered by a test rather than being a new
 *  failure mode.
 *  Removal: when every `release` is provably unreachable-by-design (the
 *  sidecar stays app-scoped and stdio stays harness-owned), this interface
 *  collapses back to a bare `AcpMcpServer` and the map below with it. */
export interface LedgerMcpAttachment {
  server: AcpMcpServer
  release: () => void
}

export interface CoachRunnerDeps {
  /** Native view of the app-owned harness snapshot. */
  harnesses: NativeHarnessSource
  /** Acquires the in-app ledger MCP server for a harness registry key
   *  (map 53, reshaped for per-harness transports). App-specific (execPath,
   *  asar entry path, dbPath, sidecar spawn) — injected so the runner stays
   *  electron-free; tests inject a fake. Takes NO scope: the server serves the
   *  full lifetime ledger and the harness filters through the tools' optional
   *  `scope` argument. Null when there is no ledger.db yet (fresh install,
   *  nothing scanned) — the run then has no data tools, which is correct:
   *  there is no data to serve. A spawn failure degrades the same way (the
   *  turn still runs, just without data tools) rather than failing the turn.
   *  The runner releases each claim when its run settles, and reset/dispose
   *  release any claims left by a stalled run. */
  ledgerMcpServer: (harnessKind: string) => Effect.Effect<LedgerMcpAttachment | null, unknown, MainServices>
  /** Production path: native execution effects hosted by the app runtime. */
  effectHost: MainRuntime
  startRun: (input: HarnessRunInput) => Effect.Effect<NativeHarnessRun, Error, CoachHarnessExecution>
  startInspection: (input: HarnessProviderInput) => Effect.Effect<NativeHarnessInspection, Error, CoachHarnessExecution>
}

export interface HarnessSource {
  list: () => Promise<CoachHarnessRow[]>
  refresh: () => Promise<CoachHarnessRow[]>
  get: (instanceId: string) => Promise<HarnessInstance | undefined>
  reportAuth?: (instanceId: string, status: 'configured' | 'unauthenticated') => void
}

export interface NativeHarnessSource {
  list: () => Effect.Effect<CoachHarnessRow[], unknown, MainServices>
  refresh: () => Effect.Effect<CoachHarnessRow[], unknown, MainServices>
  get: (instanceId: string) => Effect.Effect<HarnessInstance | undefined, unknown, MainServices>
  reportAuth?: (
    instanceId: string,
    status: 'configured' | 'unauthenticated',
  ) => Effect.Effect<void, unknown, MainServices>
}

export interface CoachRunner {
  /** Production RPC handlers use these Effect-native capabilities. The
   *  Promise methods below remain the coordinator's test adapter. */
  readonly native: NativeCoachRunnerCapabilities
  harnesses(): Promise<CoachHarnessRow[]>
  refreshHarnesses(): Promise<CoachHarnessRow[]>
  /** Pre-flight probe (map 47 ticket 50): asks the agent's handshake for its
   *  declared models/modes WITHOUT running a prompt, so the pickers render
   *  before the first message. Reuses the conversation workspace as the
   *  probe's cwd. A `{ ok: false }` result means the probe failed (unknown
   *  harness, unavailable agent) — the renderer just leaves the pickers
   *  absent and the first run surfaces the real error. */
  inspect(request: unknown): Promise<CoachInspectResult>
  /** Validates, acks immediately with a runId, then streams events to `emit`
   *  as they arrive. A `{ ok: false }` ack means the request never launched
   *  (unknown harness, malformed request). */
  start(request: unknown, emit: (runId: string, event: CoachEvent) => void): Promise<CoachRunResult>
  /** Stops the active run through its owned handle. Resolves after provider
   *  cleanup or forced child teardown, even if an SDK pull or generator
   *  cleanup remains pending. Callers deleting its workspace must await it. */
  cancel(runId: string): Promise<void>
  /** Cancels all active runs, AWAITS their teardown, and deletes the
   *  conversation's temp workspace (renderer `resetSession` fires
   *  `coach:reset`; the app calls this on quit). The delete retries briefly
   *  and never throws — a leftover scratch dir must never crash the app. */
  reset(): Promise<void>
  dispose(): Promise<void>
}

export interface NativeCoachRunnerCapabilities<R = MainServices> {
  readonly list: Effect.Effect<CoachHarnessRow[], unknown, R>
  readonly refresh: Effect.Effect<CoachHarnessRow[], unknown, R>
  readonly inspect: (request: unknown) => Effect.Effect<CoachInspectResult, unknown, R>
  readonly start: (
    request: unknown,
    emit: (runId: string, event: CoachEvent) => void,
    onRunId?: (runId: string) => void,
  ) => Effect.Effect<CoachRunResult, unknown, R>
  readonly cancel: (runId: string) => Effect.Effect<void, unknown, R>
  readonly reset: Effect.Effect<void, unknown, R>
}

export function createCoachRunner(deps: CoachRunnerDeps): CoachRunner {
  return createCoachCoordinator({
    runtime: deps.effectHost,
    harnesses: deps.harnesses,
    startRun: deps.startRun,
    startInspection: deps.startInspection,
    ledgerMcpServer: deps.ledgerMcpServer,
  })
}
export interface ApplicationAgentsSources {
  /** The single main-owned graph contains the versioned, scoped harness snapshot. */
  readonly runtime: MainRuntime
  /** Acquires the in-app ledger MCP server for a harness registry key. */
  readonly ledgerMcpServer: CoachRunnerDeps['ledgerMcpServer']
}

/** Compose app-owned harness capabilities for the authenticated RPC layer. */
export function createApplicationAgents(sources: ApplicationAgentsSources): {
  start: () => void
  reset: () => Promise<void>
  dispose: () => Promise<void>
  native: NativeCoachIpcCapabilities
} {
  const { runtime: mainRuntime, ledgerMcpServer } = sources
  const harnesses: NativeHarnessSource = {
    list: () => Effect.flatMap(HarnessSnapshot, snapshot => snapshot.list()),
    refresh: () => Effect.flatMap(HarnessSnapshot, snapshot => snapshot.refresh()),
    get: instanceId => Effect.flatMap(HarnessSnapshot, snapshot => snapshot.get(instanceId)),
    reportAuth: (instanceId, status) =>
      Effect.flatMap(HarnessSnapshot, snapshot => snapshot.reportAuth(instanceId, status)),
  }
  const runner = createCoachRunner({
    harnesses,
    ledgerMcpServer,
    effectHost: mainRuntime,
    startRun: input => Effect.flatMap(CoachHarnessExecution, execution => execution.startRun(input)),
    startInspection: input => Effect.flatMap(CoachHarnessExecution, execution => execution.startInspection(input)),
  })

  const native: NativeCoachIpcCapabilities = {
    ...runner.native,
    openLoginTerminal: Effect.fnUntraced(function* (request: unknown) {
      const parsed = Schema.decodeUnknownResult(coachOpenLoginTerminalRequestSchema)(request)
      if (parsed._tag === 'Failure') return { ok: false as const, error: 'invalid harness instance id' }
      const instanceId = parsed.success
      const instance = yield* harnesses.get(instanceId)
      const loginCommand = instance
        ? harnessSpecs.find(spec => spec.kind === instance.info.kind)?.auth?.loginCommand
        : undefined
      return yield* Effect.sync(() =>
        openLoginTerminal(instanceId, id => (id === instanceId ? loginCommand : undefined)),
      )
    }),
  }

  let startup: Fiber.Fiber<void> | undefined
  let disposed = false
  return {
    native,
    start: () => {
      if (disposed || startup) return
      startup = mainRuntime.runFork(
        Effect.flatMap(HarnessSnapshot, snapshot =>
          Effect.sleep(Duration.millis(1500)).pipe(
            Effect.andThen(snapshot.start()),
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => snapshot.shutdown()),
          ),
        ).pipe(Effect.catchCause(() => Effect.void)),
      )
    },
    reset: async () => {
      await runner.reset()
    },
    dispose: async () => {
      disposed = true
      // This boundary can run after MainRuntime has started closing, so the
      // startup fiber is interrupted without relying on its service runtime.
      if (startup) await Effect.runPromise(Fiber.interrupt(startup))
      await runner.dispose()
    },
  }
}

export interface NativeCoachIpcCapabilities extends NativeCoachRunnerCapabilities {
  readonly openLoginTerminal: (request: unknown) => Effect.Effect<CoachLoginTerminalResult, unknown, MainServices>
}
