import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, ipcMain } from 'electron'
import { detectHarnesses, type HarnessInfo } from './detect.js'
import { probeClaudeAuthStatus } from './auth-probe.js'
import { createHarnessRuntime, loadHarnessSdk, type HarnessRuntime } from './runtime.js'
import { resolveBundledEntry } from './harnesses/bundled.js'
import { buildCoachPrompt, buildLedgerBriefing } from './prompts.js'
import type { AcpMcpServer } from './harnesses/types.js'
import type { OverviewScope } from '../../shared/schemas/overview.js'
import {
  coachInspectRequestSchema,
  coachRunRequestSchema,
  type CoachEvent,
  type CoachEventEnvelope,
  type CoachHarnessRow,
  type CoachInspectResult,
  type CoachRunRequest,
  type CoachRunResult,
} from '../../shared/schemas/agents.js'
import {
  skillsDismissalRequestSchema,
  type SkillsDismissal,
  type SkillsDismissalResult,
} from '../../shared/schemas/skills.js'

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

export interface CoachRunnerDeps {
  /** Lazily-provided seam — the SDK loads on the first run, not at boot. */
  getRuntime: () => Promise<HarnessRuntime>
  /** Detection for the picker AND the run's HarnessInfo (scrubEnv, bin). The
   *  runner never trusts the renderer's kind string beyond a registry key. */
  detect: () => Promise<HarnessInfo[]>
  /** Builds the in-app ledger MCP server config (map 53). App-specific
   *  (execPath, asar entry path, dbPath) — injected so the runner stays
   *  electron-free; tests inject a fake. Takes NO scope: the server serves the
   *  full lifetime ledger and the harness filters through the tools' optional
   *  `scope` argument. Null when there is no ledger.db yet (fresh install,
   *  nothing scanned) — the run then has no data tools, which is correct:
   *  there is no data to serve. */
  ledgerMcpServer: () => AcpMcpServer | null
}

export interface CoachRunner {
  harnesses(): Promise<CoachHarnessRow[]>
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
 *  the warmed session must be spawned with (see runProbe). */
interface ProbeInput {
  kind: string
  allowApiKeyEnv: boolean
}

/** Normalizes the `coach:inspect` wire payload (bare registry key or
 *  `{ kind, allowApiKeyEnv }`) so the probe, its warmed session, and the runs
 *  that resume it all agree on the environment. Null when invalid. */
function toProbeInput(request: unknown): ProbeInput | null {
  const parsed = coachInspectRequestSchema.safeParse(request)
  if (!parsed.success) return null
  if (typeof parsed.data === 'string') return { kind: parsed.data, allowApiKeyEnv: false }
  return { kind: parsed.data.kind, allowApiKeyEnv: parsed.data.allowApiKeyEnv ?? false }
}

export function createCoachRunner(deps: CoachRunnerDeps): CoachRunner {
  const activeRuns = new Map<string, AsyncGenerator<CoachEvent>>()
  /** The conversation's private temp workspace (map 53 ticket 56): created on
   *  the first run, reused while the session resumes, deleted on reset/quit. */
  let workspace: string | null = null
  /** The probe-warmed ACP session (optimization): `inspect` runs the agent's
   *  handshake to read its declared models/modes; the conversation's FIRST
   *  run resumes that same session (`existingSessionId`) instead of creating
   *  one, so the agent does not cold-start twice. Keyed to the workspace the
   *  probe ran in, so a probe that outlives a `reset` (workspace deleted + a
   *  new one created) can never leak its session into the next conversation.
   *  Cleared once the first run consumes it. The probed session carries NO
   *  prompt — `start` still includes the ledger briefing on that first run
   *  (it keys on the absent renderer sessionId, which holds exactly here). */
  let probedSession: { kind: string; sessionId: string; workspace: string; allowApiKeyEnv: boolean } | null = null
  /** The single in-flight probe (coalescing, optimization): rapid harness
   *  switching must not spawn one ACP process per switch. One probe runs at a
   *  time; `probedQueued` holds the NEWEST request while an older probe is in
   *  flight and runs right after it settles — intermediate kinds are skipped
   *  entirely. Every caller's promise resolves with its own kind's result (or
   *  a 'superseded' arm when a newer request replaced it before its spawn);
   *  the renderer's stale-guard drops anything it has moved past. */
  let probedChain: Promise<CoachInspectResult> | null = null
  let probedQueued: { input: ProbeInput; resolve: (result: CoachInspectResult | Promise<CoachInspectResult>) => void } | null = null
  /** Bumped by every `reset`: a probe that started before a reset must not
   *  remember its session afterwards (it was warmed in a conversation the
   *  reset just discarded — the workspace-keyed guard alone cannot catch the
   *  case where the probe CREATES its workspace only after the reset). */
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

  /** ONE ACP probe spawn: detect, warm the session in the conversation
   *  workspace, remember the session for the first-run resume, and return the
   *  renderer-facing result (the session id stays main-side — the renderer's
   *  resume handle comes from the run's session event as usual). */
  async function runProbe(input: ProbeInput): Promise<CoachInspectResult> {
    const generation = conversationGeneration
    try {
      const found = await deps.detect()
      const harness = found.find(h => h.kind === input.kind)
      if (!harness) {
        return { ok: false, error: `harness not detected: ${input.kind}` }
      }
      const runtime = await deps.getRuntime()
      // The conversation workspace as the probe's cwd — created lazily, the
      // same way the first run would; a session-less probe must still spawn
      // the agent somewhere real (reset/quit cleans it up). Snapshot the path
      // locally: a reset mid-probe must not re-key the remembered session to
      // the NEW workspace it would otherwise point the closure at.
      const probeWorkspace = workspace ??= mkdtempSync(join(tmpdir(), 'watchtower-coach-'))
      // The probe spawns the agent EXACTLY like the run would — including the
      // API-key passthrough opt-in — so the warmed session the first run
      // resumes carries the same environment.
      const result = await runtime.inspect({
        harness,
        workspacePath: probeWorkspace,
        ...(input.allowApiKeyEnv ? { allowApiKeyEnv: true as const } : {}),
      })
      // Only remember the session if no reset happened while probing — a
      // stale probe belongs to a discarded conversation and must never be
      // resumed by the next one (generation, not workspace, is the truth).
      if (result.sessionId && conversationGeneration === generation) {
        probedSession = { kind: input.kind, sessionId: result.sessionId, workspace: probeWorkspace, allowApiKeyEnv: input.allowApiKeyEnv }
      }
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
      const found = await deps.detect()
      return found.map(h => ({
        kind: h.kind,
        displayName: h.displayName,
        authStatus: h.authStatus,
      }))
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

      const found = await deps.detect()
      const harness = found.find(h => h.kind === req.harnessKind)
      if (!harness) {
        return { ok: false, error: `harness not detected: ${req.harnessKind}` }
      }

      // The in-app ledger MCP server (map 53): read-only platform data scoped
      // to this conversation. Null on a fresh install (no ledger.db yet) —
      // then there are no data tools and the prompts carry no briefing (the
      // agent must not be told to call tools that do not exist). Built only
      // AFTER the harness check: a run that never launches must not spawn
      // anything.
      const ledgerServer = deps.ledgerMcpServer()
      // The MCP briefing (ADR 0020): what the ledger tools are, that they
      // serve the full lifetime ledger filtered through an optional `scope`
      // argument, and the ground-your-answer rule — plus the user's current
      // window as a suggested default. Only on the FIRST run of a
      // conversation (no sessionId yet) — the harness resumes its session
      // with the briefing already in context, so restating it every turn
      // would just burn tokens. A probe-warmed first run still counts as
      // first: the probe carried no prompt, so the agent has never seen the
      // briefing — and this condition holds for it exactly (resumeProbed
      // below requires !req.sessionId).
      const briefing = ledgerServer && !req.sessionId ? buildLedgerBriefing(scope) : ''

      // Resume the probe-warmed session on the conversation's first run
      // (optimization, no double cold-start): the agent skips creating a new
      // ACP session and picks up where the probe's handshake left it. Only
      // when the probed harness matches AND the session still lives in THIS
      // workspace — a stale probe (superseded, or one that outlived a reset)
      // must never be resumed. The resumed run still attaches the ledger MCP
      // server (it is in the run config below) and carries the briefing in
      // its prompt, so it behaves like a fresh first run.
      const resumeProbed = !req.sessionId
        && probedSession !== null
        && probedSession.kind === req.harnessKind
        && probedSession.workspace === workspace
        // A probe-warmed session is bound to the environment it was spawned
        // with: resuming it under a different API-key opt-in would silently
        // run with the wrong credentials, so a flag mismatch starts fresh.
        && probedSession.allowApiKeyEnv === (req.allowApiKeyEnv ?? false)
      // (the re-check narrows probedSession for TS — resumeProbed alone cannot
      // prove it is non-null)
      const resumeSessionId = resumeProbed && probedSession ? probedSession.sessionId : req.sessionId

      // The one prompt path (ADR 0017 reshaped): the coach prompt carries the
      // briefing's TWO-scope role (coaching + skill authoring), so a skill
      // request needs no separate builder. MCP-aware (ADR 0020): the briefing
      // tells the agent it can query the user's real usage data through the
      // ledger tools.
      const prompt = buildCoachPrompt(req.prompt!, briefing)

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
          ...(resumeSessionId ? { sessionId: resumeSessionId } : {}),
          // A probe-warmed session is expendable: if its resume fails on this
          // first run, the seam restarts fresh instead of erroring — nothing
          // was ever sent to it. Genuine conversation resumes (req.sessionId)
          // stay strict: restarting would silently drop their context.
          resumeIsExpendable: resumeProbed,
          // Merged after any spec-level servers. Null on a fresh install (no
          // ledger.db yet) — then no data tools.
          mcpServers: [...(ledgerServer ? [ledgerServer] : [])],
        })
        // The probe's warm session has been handed to this run — the memory is
        // consumed (a second session-less run must not resume it again).
        if (resumeProbed) probedSession = null
        activeRuns.set(runId, gen)

        // Stream in the background — the ack returns immediately; events land
        // on the push channel as they stream. A generator throw (SDK failure)
        // becomes an error event, never a crash.
        void (async () => {
          try {
            for await (const event of gen) {
              emit(runId, event)
            }
          } catch (err) {
            emit(runId, { kind: 'error', message: err instanceof Error ? err.message : String(err) })
          } finally {
            activeRuns.delete(runId)
          }
        })()

        return { ok: true, runId }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },

    cancel(runId) {
      const gen = activeRuns.get(runId)
      if (gen && typeof gen.return === 'function') {
        // Same-iterator interruption: the finally in the seam's run() then
        // tears the ACP provider's child process down (ADR 0016). The promise
        // resolves when that teardown completes — reset() awaits it so the
        // workspace is never deleted under a live child (Windows EPERM).
        // return() can reject if the generator's finally (provider cleanup)
        // throws — that must not become an unhandled rejection; the stream is
        // already being torn down by the caller's intent.
        return gen.return(undefined).catch(() => { /* teardown already in flight */ }) as Promise<void>
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
      // The probe-warmed session lives in the workspace being deleted — it is
      // meaningless to the next conversation. Clear it AND bump the generation
      // so any probe still in flight (which may not even have created its
      // workspace yet) knows not to remember its session for the new
      // conversation.
      probedSession = null
      conversationGeneration++
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
 *  directly (index.ts owns that read); this source only carries the write. */
export interface SkillsDismissalSource {
  dismiss: (source: SkillsDismissal['source'], name: string, reason: string) => void
}

export interface AgentsIpcSources {
  dismissals: SkillsDismissalSource
  /** The app root (`app.getAppPath()`): bundled ACP servers (e.g. codex)
   *  are resolved from `<appPath>/node_modules`, so no global install is
   *  needed (ADR 0016 map 47 ticket 49). */
  appPath: string
  /** Builds the in-app ledger MCP server (map 53) — the runner's app-specific
   *  dep, supplied by the composition root (main/index.ts). Takes no scope:
   *  the server serves the full lifetime ledger, and the harness filters via
   *  the tools' optional `scope` argument. Null when there is no ledger.db yet
   *  (fresh install) — no data, no tools. */
  ledgerMcpServer: () => AcpMcpServer | null
}

/** Wire the Coach & Skills IPC surface onto ipcMain. Call once from
 *  registerIpc(); returns the runner cleanup handle (temp workspace teardown)
 *  for the app's quit path. `dismissals` bridges the not-a-skill store. */
export function registerAgentsIpc(sources: AgentsIpcSources): { reset: () => Promise<void> } {
  const { dismissals, appPath, ledgerMcpServer } = sources
  let runtimePromise: Promise<HarnessRuntime> | null = null
  const runner = createCoachRunner({
    // The SDK is ESM and heavy; boot stays independent of it (the seam's
    // lazy-wire design). First run pays the load once.
    getRuntime: () => {
      runtimePromise ??= loadHarnessSdk().then(createHarnessRuntime)
      return runtimePromise
    },
    detect: () => detectHarnesses({
      resolveBundled: spec => resolveBundledEntry(spec, appPath),
      // Claude Code sign-in probe (auth wall early signal): the ACP
      // handshake reports models/modes WITHOUT authenticating, so without
      // this the picker would offer a harness that cannot run. The probe
      // reads only the CLI's logged-in boolean and never throws (see
      // auth-probe.ts). Other harnesses have no probe yet and stay
      // 'unknown' — informative only, never blocking.
      authProbe: kind => (kind === 'claude' ? probeClaudeAuthStatus() : Promise.resolve('unknown')),
    }),
    ledgerMcpServer,
  })

  ipcMain.handle('coach:harnesses', async (): Promise<CoachHarnessRow[]> => runner.harnesses())

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
  ipcMain.handle('skills:dismiss', (_event, request: unknown): SkillsDismissalResult => {
    const parsed = skillsDismissalRequestSchema.safeParse(request)
    if (!parsed.success) return { ok: false, error: 'invalid dismissal request' }
    dismissals.dismiss(parsed.data.source, parsed.data.name, parsed.data.reason)
    return { ok: true }
  })

  return { reset: () => runner.reset() }
}
