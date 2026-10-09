import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { BrowserWindow, ipcMain } from 'electron'

import {
  type CoachEvent,
  type CoachEventEnvelope,
  type CoachHarnessRow,
  coachInspectRequestSchema,
  type CoachInspectResult,
  type CoachLoginTerminalResult,
  coachOpenLoginTerminalRequestSchema,
  type CoachRunRequest,
  coachRunRequestSchema,
  type CoachRunResult,
} from '../../shared/schemas/agents.js'
import type { OverviewScope } from '../../shared/schemas/overview.js'
import {
  type SkillsDismissal,
  skillsDismissalRequestSchema,
  type SkillsDismissalResult,
} from '../../shared/schemas/skills.js'
import type { MainRuntime } from '../main-runtime.js'
import { logCodeFor, safeLogOperationalEvent } from '../operational-log.js'
import { CoachSdkFailure, coachSdkFailureMessage } from './coach-errors.js'
import { coachProtocolError } from './coach-protocol-errors.js'
import { harnessSpecs } from './harnesses/index.js'
import type { AcpMcpServer } from './harnesses/types.js'
import { openLoginTerminal } from './login-terminal.js'
import { buildCoachPrompt, buildLedgerBriefing, buildScopeUpdate } from './prompts.js'
import { decodeResumeCursor } from './resume-cursor.js'
import {
  type ControlledHarnessInspection,
  type ControlledHarnessRun,
  createHarnessRuntime,
  type HarnessInspectResult,
  type HarnessRuntime,
  isAuthFailureMessage,
  loadHarnessSdk,
} from './runtime.js'
import { type HarnessInstance, HarnessSnapshot } from './snapshot.js'

/**
 * Coach & Skills IPC (ADR 0017, reshaped by map 53): the wire between the
 * HarnessRuntime seam and the renderer's unified Coach & Skills surface. The
 * runner is a pure, injectable controller (ADR 0006) — it owns run
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
  /** Lazily-provided seam — the SDK loads on the first run, not at boot. */
  getRuntime: () => Promise<HarnessRuntime>
  /** Managed harness snapshot: picker rows and instance lookup — never spawns
   *  per call. The runner never trusts the renderer's id beyond a lookup key. */
  harnesses: HarnessSource
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
  ledgerMcpServer: (harnessKind: string) => Promise<LedgerMcpAttachment | null>
}

export interface HarnessSource {
  list: () => Promise<CoachHarnessRow[]>
  refresh: () => Promise<CoachHarnessRow[]>
  get: (instanceId: string) => Promise<HarnessInstance | undefined>
  reportAuth?: (instanceId: string, status: 'configured' | 'unauthenticated') => void
}

export interface CoachRunner {
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
}

/** Normalized pre-flight probe input — the registry key plus the env flag
 *  the probe's agent must be spawned with (same as the run's). */
interface ProbeInput {
  kind: string
  allowApiKeyEnv: boolean
}

/** Normalizes the `coach:inspect` wire payload (bare registry key or
 *  `{ kind, allowApiKeyEnv }`). Null when invalid. */
function toProbeInput(request: unknown): ProbeInput | null {
  const parsed = Schema.decodeUnknownResult(coachInspectRequestSchema)(request)
  if (parsed._tag === 'Failure') return null
  if (typeof parsed.success === 'string') return { kind: parsed.success, allowApiKeyEnv: false }
  return { kind: parsed.success.kind, allowApiKeyEnv: parsed.success.allowApiKeyEnv ?? false }
}

export function createCoachRunner(deps: CoachRunnerDeps): CoachRunner {
  const harnessSource = deps.harnesses
  const activeRuns = new Map<string, { run: ControlledHarnessRun; kind: string }>()
  const cancelPromises = new Map<string, Promise<void>>()
  /** The conversation's private temp workspace (map 53 ticket 56): created on
   *  the first run, reused while the session resumes, deleted on reset/quit. */
  let workspace: string | null = null
  /** The single in-flight probe (coalescing, optimization): rapid harness
   *  switching must not spawn one ACP process per switch. One probe runs at a
   *  time; `probedQueued` holds the NEWEST request while an older probe is in
   *  flight and runs right after it settles — intermediate kinds are skipped
   *  entirely. Every caller's promise resolves with its own kind's result (or
   *  a 'superseded' arm when a newer request replaced it before its spawn);
   *  the renderer's stale-guard drops anything it has moved past. */
  let probedChain: Promise<CoachInspectResult> | null = null
  interface ProbeAttempt {
    generation: number
    cancelled: boolean
    resultOnCancel: Promise<CoachInspectResult>
    resolveCancelled: (result: CoachInspectResult) => void
    inspection?: ControlledHarnessInspection
    legacyInspectSettled?: Promise<void>
    stopPromise?: Promise<void>
  }
  let activeProbe: ProbeAttempt | undefined
  let probedQueued: {
    input: ProbeInput
    generation: number
    resolve: (result: CoachInspectResult | Promise<CoachInspectResult>) => void
  } | null = null
  /** Scope the agent was last briefed with (full briefing or scope update) — a
   *  resumed turn under a different scope gets a one-line update. */
  let briefedScopeKey: string | null = null
  /** Unreleased attachments by run. A run releases its claim when it settles;
   *  reset and dispose release any claims left by a stalled run. The generation
   *  identifies claims from earlier conversations. */
  const runAttachments = new Map<string, { attachment: LedgerMcpAttachment; generation: number }>()

  /** Releases one attachment exactly once, from either owner. */
  function releaseAttachment(runId: string, attachment?: LedgerMcpAttachment | null): void {
    if (!attachment) return
    const owned = runAttachments.get(runId)
    if (!owned || owned.attachment !== attachment) return
    runAttachments.delete(runId)
    try {
      owned.attachment.release()
    } catch {
      // A release that threw must not become an unhandled rejection in a
      // `finally` or in a teardown path; the claim is dropped either way.
    }
  }

  let conversationGeneration = 0

  /** Deletes a conversation workspace with Windows-aware retries, swallowing a
   *  final failure. The ACP child process's CWD holds the dir until it has
   *  actually EXITED — teardown is awaited before this runs, but exit can lag
   *  the kill by a moment. rmSync's maxRetries/retryDelay retry
   *  EPERM/EBUSY/ENOTEMPTY with a linear backoff instead of throwing an
   *  uncaught exception into the IPC handler (the crash dialog the user hit).
   *  A leftover scratch dir under the OS temp root is harmless and cleaned on
   *  reboot — it must never take the app down. */
  function deleteWorkspace(target: string): void {
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // The retries gave up (a probe may still be holding it) — best effort.
    }
  }

  /** ONE catalog probe spawn: resolve the instance, run the handshake in the
   *  conversation workspace for its declared models/modes, and tear it down —
   *  the session is never reused by a run. */
  const cancelledProbeResult: CoachInspectResult = { ok: false, error: 'conversation reset' }
  const probeIsCurrent = (attempt: ProbeAttempt): boolean =>
    !attempt.cancelled && attempt.generation === conversationGeneration && activeProbe === attempt

  async function runProbe(input: ProbeInput, attempt: ProbeAttempt): Promise<CoachInspectResult> {
    try {
      const instance = await harnessSource.get(input.kind)
      if (!probeIsCurrent(attempt)) return cancelledProbeResult
      const harness = instance?.info
      if (!harness) {
        return { ok: false, error: `harness not detected: ${input.kind}` }
      }
      const runtime = await deps.getRuntime()
      if (!probeIsCurrent(attempt)) return cancelledProbeResult
      // No await separates the generation check from acquiring the workspace.
      const probeWorkspace = (workspace ??= mkdtempSync(join(tmpdir(), 'watchtower-coach-')))
      const probeInput = {
        harness,
        workspacePath: probeWorkspace,
        ...(input.allowApiKeyEnv ? { allowApiKeyEnv: true as const } : {}),
      }
      const inspection = runtime.inspectControlled?.(probeInput)
      let result: HarnessInspectResult
      if (inspection) {
        attempt.inspection = inspection
        if (!probeIsCurrent(attempt)) {
          await stopProbe(attempt)
          return cancelledProbeResult
        }
        result = await inspection.result
      } else {
        // Transitional support for injected runtimes; production runtime has
        // an owned inspect handle. Remove when all runtime callers migrate.
        const inspectResult = runtime.inspect(probeInput)
        attempt.legacyInspectSettled = inspectResult.then(
          () => undefined,
          () => undefined,
        )
        result = await inspectResult
      }
      if (!probeIsCurrent(attempt)) return cancelledProbeResult
      return {
        ok: true,
        ...(result.models ? { models: result.models } : {}),
        ...(result.modes ? { modes: result.modes } : {}),
      }
    } catch (err) {
      if (!probeIsCurrent(attempt)) return cancelledProbeResult
      if (err instanceof CoachSdkFailure) return { ok: false, error: coachSdkFailureMessage('The agent', err) }
      throw err
    }
  }

  function stopProbe(attempt: ProbeAttempt): Promise<void> {
    if (attempt.stopPromise) return attempt.stopPromise
    attempt.cancelled = true
    attempt.resolveCancelled(cancelledProbeResult)
    attempt.stopPromise = attempt.inspection?.stop() ?? Promise.resolve()
    return attempt.stopPromise
  }

  /** Frees the single probe slot after the active probe settles — starting
   *  the queued newer kind if one arrived. */
  function releaseProbeSlot(attempt: ProbeAttempt): void {
    if (activeProbe !== attempt) return
    activeProbe = undefined
    probedChain = null
    const queued = probedQueued
    if (queued) {
      probedQueued = null
      if (queued.generation === conversationGeneration) queued.resolve(startProbe(queued.input, queued.generation))
      else queued.resolve(cancelledProbeResult)
    }
  }

  /** Starts the probe chain (or continues it after the active probe settles):
   *  the chain is the single spawn slot — when it frees up, a queued newer
   *  kind is probed next and its caller resolves with its own result. */
  function startProbe(input: ProbeInput, generation = conversationGeneration): Promise<CoachInspectResult> {
    let resolveCancelled!: (result: CoachInspectResult) => void
    const resultOnCancel = new Promise<CoachInspectResult>(resolve => {
      resolveCancelled = resolve
    })
    const attempt: ProbeAttempt = { generation, cancelled: false, resultOnCancel, resolveCancelled }
    activeProbe = attempt
    probedChain = Promise.race([runProbe(input, attempt), resultOnCancel]).then(
      result => {
        releaseProbeSlot(attempt)
        return result
      },
      error => {
        releaseProbeSlot(attempt)
        throw error
      },
    )
    return probedChain
  }

  return {
    async harnesses() {
      return harnessSource.list()
    },

    async refreshHarnesses() {
      return harnessSource.refresh()
    },

    async inspect(request: unknown): Promise<CoachInspectResult> {
      const input = toProbeInput(request)
      if (!input) {
        return { ok: false, error: 'invalid coach inspect request' }
      }
      // Coalesce (optimization): never run two probes at once. A free slot
      // spawns immediately; otherwise the newest requested kind queues (a
      // previously queued one is superseded and resolved now — it never gets
      // its spawn, and the renderer would have dropped its result anyway).
      if (probedChain === null) {
        return startProbe(input)
      }
      if (probedQueued) probedQueued.resolve({ ok: false, error: 'superseded' })
      return new Promise(resolve => {
        probedQueued = { input, generation: conversationGeneration, resolve }
      })
    },

    async start(request: unknown, emit): Promise<CoachRunResult> {
      const runGeneration = conversationGeneration
      const parsed = Schema.decodeUnknownResult(coachRunRequestSchema)(request)
      if (parsed._tag === 'Failure') {
        return { ok: false, error: 'invalid coach run request' }
      }
      const req: CoachRunRequest = parsed.success
      const runId = randomUUID()

      // The conversation's UI scope snapshot (map 53): no longer baked into
      // the MCP server (it serves the full lifetime ledger) — it now rides the
      // briefing as a suggested default window for the agent's queries. Absent
      // scope degrades to the lifetime label so the hint matches the tools'
      // own no-arg default (the renderer always sends the current UI scope).
      const scope: OverviewScope = req.scope ?? { period: 'lifetime' }

      // Presence check FIRST: cheap, side-effect-free — a run without a
      // prompt is refused before anything is detected or spawned. The actual
      // prompt STRING is built later, once the briefing is known.
      if (!req.prompt || !req.prompt.trim()) {
        return { ok: false, error: 'coach run requires a prompt' }
      }

      const instance = await harnessSource.get(req.harnessKind)
      if (runGeneration !== conversationGeneration) return { ok: false, error: 'conversation reset' }
      const harness = instance?.info
      if (!harness) {
        return { ok: false, error: `harness not detected: ${req.harnessKind}` }
      }

      // The in-app ledger MCP server (map 53): read-only platform data scoped
      // to this conversation. Null on a fresh install (no ledger.db yet) or
      // when the sidecar fails to boot — then there are no data tools and the
      // prompts carry no briefing (the agent must not be told to call tools
      // that do not exist). Acquired only AFTER the harness check: a run that
      // never launches must not spawn anything. Registered on the
      // conversation's attachment map so BOTH owners can end the claim — the
      // run's stream settling (see the two release sites below) and the
      // conversation's teardown (`reset`/`dispose`).
      let attachment: LedgerMcpAttachment | null = null
      try {
        attachment = await deps.ledgerMcpServer(req.harnessKind)
      } catch {
        attachment = null
      }
      if (runGeneration !== conversationGeneration) {
        if (attachment) {
          runAttachments.set(runId, { attachment, generation: runGeneration })
          releaseAttachment(runId, attachment)
        }
        return { ok: false, error: 'conversation reset' }
      }
      if (attachment) runAttachments.set(runId, { attachment, generation: runGeneration })
      const ledgerServer = attachment?.server ?? null
      const instanceId = instance.instanceId
      const sessionId = req.resumeCursor ? decodeResumeCursor(req.resumeCursor, instanceId) : undefined
      const firstRun = !sessionId
      const resumeLost = !!req.resumeCursor && !sessionId
      const scopeKey = JSON.stringify({
        period: scope.period,
        provider: scope.provider ?? null,
        range: scope.range ? { since: scope.range.since, until: scope.range.until } : null,
      })
      const freshPrompt = buildCoachPrompt(req.prompt!, ledgerServer ? buildLedgerBriefing(scope) : '')
      // Resumed turns already hold the briefing; only a changed scope is restated.
      const prompt = firstRun
        ? freshPrompt
        : buildCoachPrompt(req.prompt!, ledgerServer && briefedScopeKey !== scopeKey ? buildScopeUpdate(scope) : '')
      if (ledgerServer) briefedScopeKey = scopeKey

      try {
        const runtime = await deps.getRuntime()
        if (runGeneration !== conversationGeneration) {
          releaseAttachment(runId, attachment)
          return { ok: false, error: 'conversation reset' }
        }

        // Per-conversation temp workspace: created on the conversation's first
        // run and REUSED for the whole conversation — a resumed run (sessionId
        // present) and a session-less one both share it, so a run must NEVER
        // destroy it. Only `coach:reset` (renderer resetSession — a brand-new
        // conversation) and app quit delete it. `mkdtemp` guarantees a real
        // on-disk path — the seam's own workspace validation still runs.
        workspace ??= mkdtempSync(join(tmpdir(), 'watchtower-coach-'))

        const runInput = {
          harness,
          workspacePath: workspace,
          prompt,
          // Progressive model/mode selection (map 47 ticket 50): the renderer
          // can only send ids the agent's own handshake reported. Both are
          // optional — absent means the agent's default model/mode.
          ...(req.modelId ? { modelId: req.modelId } : {}),
          ...(req.modeId ? { modeId: req.modeId } : {}),
          ...(req.allowApiKeyEnv ? { allowApiKeyEnv: true as const } : {}),
          ...(sessionId ? { sessionId } : {}),
          freshPrompt,
          // Merged after any spec-level servers. Null on a fresh install (no
          // ledger.db yet) — then no data tools.
          mcpServers: [...(ledgerServer ? [ledgerServer] : [])],
        }
        // createHarnessRuntime always provides this bounded stop path in
        // production. Keep a separately bounded adapter for older injected
        // runtimes while their callers migrate.
        const run =
          runtime.runControlled?.(runInput) ??
          (() => {
            const events = runtime.run(runInput)
            return {
              events,
              stop: () =>
                new Promise<void>(resolve => {
                  let settled = false
                  const finish = (): void => {
                    if (settled) return
                    settled = true
                    clearTimeout(timer)
                    resolve()
                  }
                  const timer = setTimeout(finish, 3_000)
                  try {
                    void events.return(undefined).then(finish, finish)
                  } catch {
                    finish()
                  }
                }),
            }
          })()
        activeRuns.set(runId, { run, kind: req.harnessKind })

        // The ack returns immediately. Failures after it become bounded error
        // events; the operational log records only harness kind and code.
        safeLogOperationalEvent('info', 'harness.start', { kind: req.harnessKind })
        const canPublish = (): boolean => activeRuns.get(runId)?.run === run && runGeneration === conversationGeneration
        void (async () => {
          let settled = false
          try {
            if (resumeLost && canPublish())
              emit(runId, {
                kind: 'notice',
                message: 'The previous session could not be restored — continuing in a fresh session.',
              })
            if (firstRun && !ledgerServer && canPublish())
              emit(runId, {
                kind: 'notice',
                message:
                  'Ledger data is not available yet (no scan found) — answers will not be grounded in your usage data.',
              })
            for await (const event of run.events) {
              if (!canPublish()) break
              if (event.kind === 'status' && event.state === 'done')
                harnessSource.reportAuth?.(instance.instanceId, 'configured')
              if (event.kind === 'error' && isAuthFailureMessage(event.message))
                harnessSource.reportAuth?.(instance.instanceId, 'unauthenticated')
              if (canPublish()) emit(runId, event)
            }
            settled = true
          } catch (err) {
            if (canPublish()) {
              emit(runId, { kind: 'error', message: coachProtocolError(err) })
              safeLogOperationalEvent('error', 'harness.error', { kind: req.harnessKind, code: logCodeFor(err) })
            }
          } finally {
            const wasOwned = activeRuns.get(runId)?.run === run
            if (settled && wasOwned) safeLogOperationalEvent('info', 'harness.finish', { kind: req.harnessKind })
            if (wasOwned) activeRuns.delete(runId)
            releaseAttachment(runId, attachment)
          }
        })()

        return { ok: true, runId }
      } catch (err) {
        releaseAttachment(runId, attachment)
        if (err instanceof CoachSdkFailure)
          return { ok: false, error: coachSdkFailureMessage(harness.displayName, err) }
        throw err
      }
    },

    cancel(runId) {
      const existing = cancelPromises.get(runId)
      if (existing) return existing
      const active = activeRuns.get(runId)
      if (active) {
        // Remove ownership before stopping so late stream events cannot be
        // published. The controlled handle owns bounded teardown independently
        // of whether the generator pump settles.
        const { run, kind } = active
        activeRuns.delete(runId)
        releaseAttachment(runId)
        const cancelPromise = run
          .stop()
          .then(() => {
            safeLogOperationalEvent('info', 'harness.cancel', { kind })
          })
          .finally(() => {
            cancelPromises.delete(runId)
          }) as Promise<void>
        cancelPromises.set(runId, cancelPromise)
        return cancelPromise
      }
      return Promise.resolve()
    },

    async reset() {
      const currentGeneration = ++conversationGeneration
      const runsToStop = [...activeRuns.entries()]
      const probeToStop = activeProbe
      const attachmentsToRelease = [...runAttachments.entries()].filter(
        ([, owner]) => owner.generation < currentGeneration,
      )
      // Snapshot and release the workspace BEFORE awaiting teardown: a new run
      // or probe racing in during the wait would otherwise hit
      // `workspace ??= mkdtempSync(...)` and REUSE the old (about-to-be
      // deleted) path. Releasing first hands it a fresh dir immediately.
      const target = workspace
      workspace = null
      briefedScopeKey = null
      // Release claims before waiting for teardown so a stalled run cannot
      // keep them past reset. The sidecar remains app-scoped across resets.
      for (const [runId, owner] of attachmentsToRelease) releaseAttachment(runId, owner.attachment)
      if (probedQueued) {
        probedQueued.resolve(cancelledProbeResult)
        probedQueued = null
      }
      let probeTeardown: Promise<void> = Promise.resolve()
      if (probeToStop) {
        void stopProbe(probeToStop)
        probeTeardown = probeToStop.inspection
          ? (probeToStop.stopPromise ?? Promise.resolve())
          : (probeToStop.legacyInspectSettled ?? Promise.resolve())
        if (activeProbe === probeToStop) activeProbe = undefined
        probedChain = null
      }
      // Stop every active run and probe, then await their bounded teardown
      // handles before deleting: the ACP
      // child process's CWD is the workspace, and deleting it while the child
      // is still alive fails on Windows with EPERM. AllSettled
      // lets one teardown fail without skipping workspace cleanup. Controlled
      // production handles resolve only after provider cleanup has
      // completed or forced teardown has run. The legacy runtime adapter above
      // has its own ceiling for injected runtimes that only expose run().
      await Promise.allSettled([
        ...runsToStop.map(([runId]) => this.cancel(runId)),
        ...cancelPromises.values(),
        probeTeardown,
      ])
      if (target) deleteWorkspace(target)
    },
  }
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
  ledgerMcpServer: (harnessKind: string) => Promise<LedgerMcpAttachment | null>
}

/** Wire the Coach & Skills IPC surface onto ipcMain. Call once from
 *  registerIpc(); returns the runner cleanup handle (temp workspace teardown)
 *  for the app's quit path. `dismissals` bridges the not-a-skill store. */
export function registerAgentsIpc(sources: AgentsIpcSources): {
  reset: () => Promise<void>
  dispose: () => Promise<void>
} {
  const { dismissals, runtime: mainRuntime, ledgerMcpServer } = sources
  let runtimePromise: Promise<HarnessRuntime> | null = null
  const harnesses: HarnessSource = {
    list: () => mainRuntime.runPromise(Effect.flatMap(HarnessSnapshot, snapshot => snapshot.list())),
    refresh: () => mainRuntime.runPromise(Effect.flatMap(HarnessSnapshot, snapshot => snapshot.refresh())),
    get: instanceId => mainRuntime.runPromise(Effect.flatMap(HarnessSnapshot, snapshot => snapshot.get(instanceId))),
    reportAuth: (instanceId, status) => {
      void mainRuntime
        .runPromise(Effect.flatMap(HarnessSnapshot, snapshot => snapshot.reportAuth(instanceId, status)))
        .catch(() => {})
    },
  }
  const runner = createCoachRunner({
    // The SDK is ESM and heavy; boot stays independent of it (the seam's
    // lazy-wire design). First run pays the load once.
    getRuntime: () => {
      runtimePromise ??= loadHarnessSdk().then(createHarnessRuntime)
      return runtimePromise
    },
    harnesses,
    ledgerMcpServer,
  })

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
    const parsed = Schema.decodeUnknownResult(coachOpenLoginTerminalRequestSchema)(request)
    if (parsed._tag === 'Failure') return { ok: false, error: 'invalid harness instance id' }
    return harnesses
      .get(parsed.success)
      .then(instance => {
        const loginCommand = instance
          ? harnessSpecs.find(spec => spec.kind === instance.info.kind)?.auth?.loginCommand
          : undefined
        return openLoginTerminal(parsed.success, instanceId =>
          instanceId === parsed.success ? loginCommand : undefined,
        )
      })
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

  const startup = setTimeout(() => {
    void mainRuntime.runPromise(Effect.flatMap(HarnessSnapshot, snapshot => snapshot.start())).catch(() => {})
  }, 1500)
  startup.unref?.()
  return {
    reset: async () => {
      await runner.reset()
    },
    dispose: async () => {
      clearTimeout(startup)
      await runner.reset()
    },
  }
}
