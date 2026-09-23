import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, ipcMain } from 'electron'
import { detectHarnesses, type HarnessInfo } from './detect.js'
import { createHarnessRuntime, isAuthFailureMessage, loadHarnessSdk, type HarnessRuntime } from './runtime.js'
import { probeHarness } from './probe.js'
import { createHarnessSnapshotStore, type HarnessInstance, type HarnessSnapshotStore } from './snapshot.js'
import { resolveBundledEntry } from './harnesses/bundled.js'
import { harnessSpecs } from './harnesses/index.js'
import { openLoginTerminal } from './login-terminal.js'
import { buildCoachPrompt, buildLedgerBriefing, buildScopeUpdate } from './prompts.js'
import { decodeResumeCursor } from './resume-cursor.js'
import type { AcpMcpServer } from './harnesses/types.js'
import type { OverviewScope } from '../../shared/schemas/overview.js'
import {
  coachInspectRequestSchema,
  coachOpenLoginTerminalRequestSchema,
  coachRunRequestSchema,
  type CoachEvent,
  type CoachEventEnvelope,
  type CoachHarnessRow,
  type CoachInspectResult,
  type CoachLoginTerminalResult,
  type CoachRunRequest,
  type CoachRunResult,
} from '../../shared/schemas/agents.js'
import {
  skillsDismissalRequestSchema,
  type SkillsDismissal,
  type SkillsDismissalResult,
} from '../../shared/schemas/skills.js'
import { logCodeFor, safeLogOperationalEvent } from '../operational-log.js'

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
 * interrupts the active run's SDK iterator so the harness gets a native stop),
 * `coach:reset` (send → cancels all runs + cleans the conversation workspace).
 * The renderer revalidates every payload against the same schemas (ADR 0005).
 */

/** An acquired ledger MCP attachment: the session server config plus its
 *  release. Stdio attachments are agent-spawned (release is a no-op); HTTP
 *  attachments are pooled per conversation (release is a pool no-op — the
 *  app quits). Either way the runner releases every attachment when its run
 *  settles. */
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
   *  The runner releases every acquired attachment when its run settles. */
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
  /** Interrupts the active run's generator so the harness's cleanup runs.
   *  Resolves once the generator's finally (the ACP child-process teardown)
   *  has completed — callers that delete the workspace must await it, or
   *  Windows can still hold the dir via the child's CWD (EPERM). */
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
  const parsed = coachInspectRequestSchema.safeParse(request)
  if (!parsed.success) return null
  if (typeof parsed.data === 'string') return { kind: parsed.data, allowApiKeyEnv: false }
  return { kind: parsed.data.kind, allowApiKeyEnv: parsed.data.allowApiKeyEnv ?? false }
}

export function createCoachRunner(deps: CoachRunnerDeps): CoachRunner {
  const harnessSource = deps.harnesses
  const activeRuns = new Map<string, AsyncGenerator<CoachEvent>>()
  const cancelPromises = new Map<string, Promise<void>>()
  /** Runs cancelled by the user before their stream settled — the settle path
   * logs `harness.cancel` instead of `harness.finish` for these (#130). */
  const cancelledRuns = new Set<string>()
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
  let probedQueued: { input: ProbeInput; resolve: (result: CoachInspectResult | Promise<CoachInspectResult>) => void } | null = null
  /** Scope the agent was last briefed with (full briefing or scope update) — a
   *  resumed turn under a different scope gets a one-line update. */
  let briefedScopeKey: string | null = null

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
  async function runProbe(input: ProbeInput): Promise<CoachInspectResult> {
    try {
      const instance = await harnessSource.get(input.kind)
      const harness = instance?.info
      if (!harness) {
        return { ok: false, error: `harness not detected: ${input.kind}` }
      }
      const runtime = await deps.getRuntime()
      // The conversation workspace as the probe's cwd — created lazily, the
      // same way the first run would; a probe must still spawn the agent
      // somewhere real (reset/quit cleans it up).
      const probeWorkspace = workspace ??= mkdtempSync(join(tmpdir(), 'watchtower-coach-'))
      const result = await runtime.inspect({
        harness,
        workspacePath: probeWorkspace,
        ...(input.allowApiKeyEnv ? { allowApiKeyEnv: true as const } : {}),
      })
      return {
        ok: true,
        ...(result.models ? { models: result.models } : {}),
        ...(result.modes ? { modes: result.modes } : {}),
      }
    } catch (err) {
      // Everything (detect included) becomes an ok:false arm — a rejection
      // must NEVER propagate: the chain's slot-release depends on runProbe
      // settling, and a wedged slot would hang every later probe.
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** Frees the single probe slot after the active probe settles — starting
   *  the queued newer kind if one arrived. */
  function releaseProbeSlot(): void {
    probedChain = null
    const queued = probedQueued
    if (queued) {
      probedQueued = null
      queued.resolve(startProbe(queued.input))
    }
  }

  /** Starts the probe chain (or continues it after the active probe settles):
   *  the chain is the single spawn slot — when it frees up, a queued newer
   *  kind is probed next and its caller resolves with its own result. */
  function startProbe(input: ProbeInput): Promise<CoachInspectResult> {
    probedChain = runProbe(input).then(
      result => {
        releaseProbeSlot()
        return result
      },
      // Belt-and-braces: runProbe catches everything, so this should never
      // fire — but if it ever did, the slot must still free or every later
      // probe would queue onto a dead chain forever.
      error => {
        releaseProbeSlot()
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
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
        probedQueued = { input, resolve }
      })
    },

    async start(request: unknown, emit): Promise<CoachRunResult> {
      const parsed = coachRunRequestSchema.safeParse(request)
      if (!parsed.success) {
        return { ok: false, error: 'invalid coach run request' }
      }
      const req: CoachRunRequest = parsed.data

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
      const harness = instance?.info
      if (!harness) {
        return { ok: false, error: `harness not detected: ${req.harnessKind}` }
      }

      // The in-app ledger MCP server (map 53): read-only platform data scoped
      // to this conversation. Null on a fresh install (no ledger.db yet) or
      // when the sidecar fails to boot — then there are no data tools and the
      // prompts carry no briefing (the agent must not be told to call tools
      // that do not exist). Acquired only AFTER the harness check: a run that
      // never launches must not spawn anything. Released when the run's
      // stream settles (see both finallys below).
      let attachment: LedgerMcpAttachment | null = null
      try {
        attachment = await deps.ledgerMcpServer(req.harnessKind)
      } catch {
        attachment = null
      }
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
        const runId = randomUUID()

        // Per-conversation temp workspace: created on the conversation's first
        // run and REUSED for the whole conversation — a resumed run (sessionId
        // present) and a session-less one both share it, so a run must NEVER
        // destroy it. Only `coach:reset` (renderer resetSession — a brand-new
        // conversation) and app quit delete it. `mkdtemp` guarantees a real
        // on-disk path — the seam's own workspace validation still runs.
        workspace ??= mkdtempSync(join(tmpdir(), 'watchtower-coach-'))

        const gen = runtime.run({
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
        })
        activeRuns.set(runId, gen)

        // Stream in the background — the ack returns immediately; events land
        // on the push channel as they stream. A generator throw (SDK failure)
        // becomes an error event, never a crash. Lifecycle lands in the
        // Operational log by harness kind only — never prompts (#130).
        safeLogOperationalEvent('info', 'harness.start', { kind: req.harnessKind })
        void (async () => {
          let settled = false
          try {
            if (resumeLost) emit(runId, { kind: 'notice', message: 'The previous session could not be restored — continuing in a fresh session.' })
            if (firstRun && !ledgerServer) emit(runId, { kind: 'notice', message: 'Ledger data is not available yet (no scan found) — answers will not be grounded in your usage data.' })
            for await (const event of gen) {
              if (event.kind === 'status' && event.state === 'done') harnessSource.reportAuth?.(instance.instanceId, 'configured')
              if (event.kind === 'error' && isAuthFailureMessage(event.message)) harnessSource.reportAuth?.(instance.instanceId, 'unauthenticated')
              emit(runId, event)
            }
            settled = true
          } catch (err) {
            emit(runId, { kind: 'error', message: err instanceof Error ? err.message : String(err) })
            safeLogOperationalEvent('error', 'harness.error', { kind: req.harnessKind, code: logCodeFor(err) })
          } finally {
            const wasCancelled = cancelledRuns.delete(runId)
            if (settled) {
              if (wasCancelled) {
                safeLogOperationalEvent('info', 'harness.cancel', { kind: req.harnessKind })
              } else {
                safeLogOperationalEvent('info', 'harness.finish', { kind: req.harnessKind })
              }
            }
            activeRuns.delete(runId)
            attachment?.release()
          }
        })()

        return { ok: true, runId }
      } catch (err) {
        attachment?.release()
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },

    cancel(runId) {
      const existing = cancelPromises.get(runId)
      if (existing) return existing
      const gen = activeRuns.get(runId)
      if (gen && typeof gen.return === 'function') {
        // Marked so the stream settle path logs `harness.cancel` instead of
        // `harness.finish` (#130). UUID runIds never repeat, and the settle
        // path deletes the mark — no leak.
        cancelledRuns.add(runId)
        // Same-iterator interruption: the finally in the seam's run() then
        // tears the ACP provider's child process down (ADR 0016). The promise
        // resolves when that teardown completes — reset() awaits it so the
        // workspace is never deleted under a live child (Windows EPERM).
        // return() can reject if the generator's finally (provider cleanup)
        // throws — that must not become an unhandled rejection; the stream is
        // already being torn down by the caller's intent.
        const cancelPromise = gen.return(undefined)
          .catch(() => { /* teardown already in flight */ })
          .finally(() => cancelPromises.delete(runId)) as Promise<void>
        cancelPromises.set(runId, cancelPromise)
        return cancelPromise
      }
      return Promise.resolve()
    },

    async reset() {
      // Snapshot and release the workspace BEFORE awaiting teardown: a new run
      // or probe racing in during the wait would otherwise hit
      // `workspace ??= mkdtempSync(...)` and REUSE the old (about-to-be
      // deleted) path. Releasing first hands it a fresh dir immediately.
      const target = workspace
      workspace = null
      briefedScopeKey = null
      // Stop every active run and AWAIT the teardown before deleting: the ACP
      // child process's CWD is the workspace, and deleting it while the child
      // is still alive fails on Windows with EPERM — as an uncaught exception
      // in the IPC handler it pops the main-process error dialog. AllSettled:
      // one wedged teardown must not block the others; the timeout is cheap
      // insurance so a wedged generator can never hold the delete hostage (a
      // leftover scratch dir beats a hung reset).
      await Promise.race([
        Promise.allSettled([...activeRuns.keys()].map(runId => this.cancel(runId))),
        new Promise(resolve => setTimeout(resolve, 3_000)),
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
  /** The app root (`app.getAppPath()`): bundled ACP servers (e.g. codex)
   *  are resolved from `<appPath>/node_modules`, so no global install is
   *  needed (ADR 0016 map 47 ticket 49). */
  appPath: string
  clientVersion: string
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
export function registerAgentsIpc(sources: AgentsIpcSources): { reset: () => Promise<void>; dispose: () => Promise<void> } {
  const { dismissals, appPath, clientVersion, ledgerMcpServer } = sources
  let runtimePromise: Promise<HarnessRuntime> | null = null
  const harnessStore: HarnessSnapshotStore = createHarnessSnapshotStore({
    detect: () => detectHarnesses({
      resolveBundled: spec => resolveBundledEntry(spec, appPath),
    }),
    probe: info => probeHarness(info, { clientVersion }),
    onChange: rows => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('coach:harnesses-changed', rows)
      }
    },
  })
  const runner = createCoachRunner({
    // The SDK is ESM and heavy; boot stays independent of it (the seam's
    // lazy-wire design). First run pays the load once.
    getRuntime: () => {
      runtimePromise ??= loadHarnessSdk().then(createHarnessRuntime)
      return runtimePromise
    },
    harnesses: harnessStore,
    ledgerMcpServer,
  })

  ipcMain.handle('coach:harnesses', async (): Promise<CoachHarnessRow[]> => runner.harnesses())
  ipcMain.handle('coach:harnesses-refresh', async (): Promise<CoachHarnessRow[]> => runner.refreshHarnesses())
  ipcMain.handle('coach:open-login-terminal', async (_event, request: unknown): Promise<CoachLoginTerminalResult> => {
    const parsed = coachOpenLoginTerminalRequestSchema.safeParse(request)
    if (!parsed.success) return { ok: false, error: 'invalid harness instance id' }
    const instance = await harnessStore.get(parsed.data)
    const loginCommand = instance
      ? harnessSpecs.find(spec => spec.kind === instance.info.kind)?.auth?.loginCommand
      : undefined
    return openLoginTerminal(parsed.data, instanceId => instanceId === parsed.data ? loginCommand : undefined)
  })

  /** Pre-flight probe (map 47 ticket 50): the harness's handshake-declared
   *  models/modes without a run, so the pickers render before the first
   *  message. The request is a bare registry key — the runner re-detects and
   *  never trusts it beyond that key, and a probe failure is `{ ok: false }`
   *  (pickers absent, chat unaffected). */
  ipcMain.handle('coach:inspect', async (_event, request: unknown): Promise<CoachInspectResult> => {
    // The runner validates (bare key or { kind, allowApiKeyEnv }) — a probe
    // failure is `{ ok: false }` (pickers absent, chat unaffected).
    return runner.inspect(request)
  })

  ipcMain.handle('coach:run', async (event, request: unknown): Promise<CoachRunResult> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { ok: false, error: 'no window' }
    return runner.start(request, (runId, coachEvent) => {
      if (!win.isDestroyed()) {
        win.webContents.send('coach:event', { runId, event: coachEvent } satisfies CoachEventEnvelope)
      } else {
        // The window that launched the run is gone — stop pulling the stream
        // so the ACP child process is torn down instead of leaking.
        runner.cancel(runId)
      }
    })
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
    const parsed = skillsDismissalRequestSchema.safeParse(request)
    if (!parsed.success) return { ok: false, error: 'invalid dismissal request' }
    await dismissals.dismiss(parsed.data.source, parsed.data.name, parsed.data.reason)
    return { ok: true }
  })

  const startup = setTimeout(() => harnessStore.start(), 1500)
  startup.unref?.()
  return {
    reset: async () => {
      await runner.reset()
    },
    dispose: async () => {
      await runner.reset()
      await harnessStore.dispose()
    },
  }
}
