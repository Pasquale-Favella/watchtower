import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Schema from 'effect/Schema'
import { BrowserWindow, ipcMain } from 'electron'

import {
  type CoachEvent,
  type CoachEventEnvelope,
  type CoachHarnessRow,
  type CoachInspectResult,
  type CoachLoginTerminalResult,
  coachOpenLoginTerminalRequestSchema,
  type CoachRunResult,
} from '../../shared/schemas/agents.js'
import {
  type SkillsDismissal,
  skillsDismissalRequestSchema,
  type SkillsDismissalResult,
} from '../../shared/schemas/skills.js'
import type { MainRuntime, MainServices } from '../main-runtime.js'
import { createCoachCoordinator } from './coach-coordinator.js'
import { coachProtocolError } from './coach-protocol-errors.js'
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
 * Coach & Skills IPC (ADR 0017, reshaped by map 53): the wire between the
 * HarnessRuntime seam and the renderer's unified Coach & Skills surface. The
 * runner is an Effect coordinator hosted by MainRuntime. It owns run
 * ack/stream/cancel and the per-conversation temp workspace against an
 * injected runtime + detection, so it is unit-testable without electron;
 * `registerAgentsIpc` is the thin glue that maps it onto ipcMain + webContents.
 *
 * No workspace picker anymore (map 53): the runner owns a private temp
 * workspace per conversation — a resumed run (sessionId present) reuses the
 * conversation's dir; a fresh run (no sessionId) clears the old one and
 * starts a new one; `coach:reset` + app quit clean it up. The harness gets
 * the platform's own data through the INJECTED in-app ledger MCP server
 * (map 53), scoped to the current UI scope the renderer sends on `coach:run`.
 *
 * Wire contract (frozen, shared schemas): `coach:harnesses` (invoke → rows),
 * `coach:run` (invoke → immediate `{ ok: true, runId }` ack, events pushed on
 * `coach:event` as runId-enveloped CoachEvents), `coach:cancel` (send →
 * stops the active run through its owned cancellation handle),
 * `coach:reset` (send → cancels all runs + cleans the conversation workspace).
 * The renderer revalidates every payload against the same schemas (ADR 0005).
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
  /** Effect-native capabilities owned by this coordinator. External callers
   *  provide the app's existing MainRuntime; Promise adapters below exist for
   *  the legacy Electron handlers during migration. */
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

export interface NativeCoachRunnerCapabilities {
  readonly list: Effect.Effect<CoachHarnessRow[], unknown, MainServices>
  readonly refresh: Effect.Effect<CoachHarnessRow[], unknown, MainServices>
  readonly inspect: (request: unknown) => Effect.Effect<CoachInspectResult, unknown, MainServices>
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
/** The main-side dismissal write (ticket 25), wired to the ledger so the
 *  not-a-skill signal persists. The skills:view handler reads the ledger
 *  directly (the db-worker owns that read); this source only carries the
 *  write — async, because the ledger lives on the worker thread. */
export interface SkillsDismissalSource {
  dismiss: (source: SkillsDismissal['source'], name: string, reason: string) => void | Promise<void>
}

export interface AgentsIpcSources {
  dismissals: SkillsDismissalSource
  /** The single main-owned graph contains the versioned, scoped harness snapshot. */
  runtime: MainRuntime
  /** Acquires the in-app ledger MCP server for a harness registry key
   *  (map 53) — the runner's app-specific dep, supplied by the composition
   *  root (main/index.ts). Takes no scope: the server serves the full
   *  lifetime ledger, and the harness filters via the tools' optional `scope`
   *  argument. Null when there is no ledger.db yet (fresh install) or the
   *  sidecar fails to boot — no data, no tools. */
  ledgerMcpServer: (harnessKind: string) => Effect.Effect<LedgerMcpAttachment | null, unknown, MainServices>
}

/** Wire the Coach & Skills IPC surface onto ipcMain. Call once from
 *  registerIpc(); returns the runner cleanup handle (temp workspace teardown)
 *  for the app's quit path. `dismissals` bridges the not-a-skill store. */
export function registerAgentsIpc(sources: AgentsIpcSources): {
  reset: () => Promise<void>
  dispose: () => Promise<void>
  native: NativeCoachIpcCapabilities
} {
  const { dismissals, runtime: mainRuntime, ledgerMcpServer } = sources
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

  ipcMain.handle('coach:harnesses', async (): Promise<CoachHarnessRow[]> =>
    runner.harnesses().catch(error => {
      throw new Error(coachProtocolError(error), { cause: error })
    }),
  )
  ipcMain.handle('coach:harnesses-refresh', async (): Promise<CoachHarnessRow[]> =>
    runner.refreshHarnesses().catch(error => {
      throw new Error(coachProtocolError(error), { cause: error })
    }),
  )
  ipcMain.handle('coach:open-login-terminal', async (_event, request: unknown): Promise<CoachLoginTerminalResult> => {
    return mainRuntime
      .runPromise(native.openLoginTerminal(request))
      .catch(error => ({ ok: false, error: coachProtocolError(error) }))
  })

  /** Pre-flight probe (map 47 ticket 50): the harness's handshake-declared
   *  models/modes without a run, so the pickers render before the first
   *  message. The request is a bare registry key — the runner re-detects and
   *  never trusts it beyond that key, and a probe failure is `{ ok: false }`
   *  (pickers absent, chat unaffected). */
  ipcMain.handle('coach:inspect', async (_event, request: unknown): Promise<CoachInspectResult> => {
    // The runner validates (bare key or { kind, allowApiKeyEnv }) — a probe
    // failure is `{ ok: false }` (pickers absent, chat unaffected).
    return runner.inspect(request).catch(error => ({ ok: false, error: coachProtocolError(error) }))
  })

  ipcMain.handle('coach:run', async (event, request: unknown): Promise<CoachRunResult> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { ok: false, error: 'no window' }
    return runner
      .start(request, (runId, coachEvent) => {
        if (!win.isDestroyed()) {
          win.webContents.send('coach:event', { runId, event: coachEvent } satisfies CoachEventEnvelope)
        } else {
          // The window that launched the run is gone — stop pulling the stream
          // so the ACP child process is torn down instead of leaking.
          runner.cancel(runId)
        }
      })
      .catch(error => ({ ok: false, error: coachProtocolError(error) }))
  })

  ipcMain.on('coach:cancel', (_event, runId: string) => {
    // Fire-and-forget from the user's Stop button — the renderer recovers on
    // its own; the teardown promise is just the wait-for-cleanup handle.
    void runner.cancel(runId)
  })

  /** Conversation reset (map 53 ticket 56): cancels active runs and deletes
   *  the conversation's temp workspace — fired by the renderer's
   *  `resetSession` (a brand-new conversation) and by the app quit path. The
   *  runner awaits the run teardowns before deleting, so a child process
   *  still holding the workspace (Windows) can never produce an uncaught
   *  EPERM here. */
  ipcMain.on('coach:reset', () => {
    void runner.reset()
  })

  // Skills draft board (ticket 25): the not-a-skill store. skills:view /
  // skills:save stay in registerIpc (they need the ledger + dialog directly);
  // this module owns the harness-touching wire — skill prose runs through
  // coach:run's single coach mode (ADR 0017 reshaped), so no separate prose
  // channel exists here.
  ipcMain.handle('skills:dismiss', async (_event, request: unknown): Promise<SkillsDismissalResult> => {
    const parsed = Schema.decodeUnknownResult(skillsDismissalRequestSchema)(request)
    if (parsed._tag === 'Failure') return { ok: false, error: 'invalid dismissal request' }
    await dismissals.dismiss(parsed.success.source, parsed.success.name, parsed.success.reason)
    return { ok: true }
  })

  const startup = mainRuntime.runFork(
    Effect.sleep(Duration.millis(1500)).pipe(
      Effect.andThen(Effect.flatMap(HarnessSnapshot, snapshot => snapshot.start())),
      Effect.catchCause(() => Effect.void),
    ),
  )
  return {
    native,
    reset: async () => {
      await runner.reset()
    },
    dispose: async () => {
      // This boundary can run after MainRuntime has started closing, so the
      // service-free fiber interrupt must not depend on that runtime.
      // eslint-disable-next-line no-restricted-syntax
      await Effect.runPromise(Fiber.interrupt(startup))
      await runner.dispose()
    },
  }
}

export interface NativeCoachIpcCapabilities extends NativeCoachRunnerCapabilities {
  readonly openLoginTerminal: (request: unknown) => Effect.Effect<CoachLoginTerminalResult, unknown, MainServices>
}
