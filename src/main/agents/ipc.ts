import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, ipcMain } from 'electron'
import { detectHarnesses, type HarnessInfo } from './detect.js'
import { createHarnessRuntime, loadHarnessSdk, type HarnessRuntime } from './runtime.js'
import { resolveBundledEntry } from './harnesses/bundled.js'
import { buildCoachPrompt, buildLedgerBriefing, buildProsePrompt } from './prompts.js'
import type { AcpMcpServer } from './harnesses/types.js'
import type { OverviewScope } from '../../shared/schemas/overview.js'
import {
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
  /** Builds the in-app ledger MCP server config for a conversation's scope
   *  (map 53). App-specific (execPath, asar entry path, dbPath) — injected so
   *  the runner stays electron-free; tests inject a fake. Null when there is
   *  no ledger.db yet (fresh install, nothing scanned) — the run then has no
   *  data tools, which is correct: there is no data to serve. */
  ledgerMcpServer: (scope: OverviewScope) => AcpMcpServer | null
}

export interface CoachRunner {
  harnesses(): Promise<CoachHarnessRow[]>
  /** Pre-flight probe (map 47 ticket 50): asks the agent's handshake for its
   *  declared models/modes WITHOUT running a prompt, so the pickers render
   *  before the first message. Reuses the conversation workspace as the
   *  probe's cwd. A `{ ok: false }` result means the probe failed (unknown
   *  harness, unavailable agent) — the renderer just leaves the pickers
   *  absent and the first run surfaces the real error. */
  inspect(kind: string): Promise<CoachInspectResult>
  /** Validates, acks immediately with a runId, then streams events to `emit`
   *  as they arrive. A `{ ok: false }` ack means the request never launched
   *  (unknown harness, malformed request). */
  start(request: unknown, emit: (runId: string, event: CoachEvent) => void): Promise<CoachRunResult>
  /** Interrupts the active run's generator so the harness's cleanup runs. */
  cancel(runId: string): void
  /** Cancels all active runs and deletes the conversation's temp workspace
   *  (renderer `resetSession` fires `coach:reset`; the app calls this on quit). */
  reset(): void
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
  let probedSession: { kind: string; sessionId: string; workspace: string } | null = null
  /** The single in-flight probe (coalescing, optimization): rapid harness
   *  switching must not spawn one ACP process per switch. One probe runs at a
   *  time; `probedQueued` holds the NEWEST request while an older probe is in
   *  flight and runs right after it settles — intermediate kinds are skipped
   *  entirely. Every caller's promise resolves with its own kind's result (or
   *  a 'superseded' arm when a newer request replaced it before its spawn);
   *  the renderer's stale-guard drops anything it has moved past. */
  let probedChain: Promise<CoachInspectResult> | null = null
  let probedQueued: { kind: string; resolve: (result: CoachInspectResult | Promise<CoachInspectResult>) => void } | null = null
  /** Bumped by every `reset`: a probe that started before a reset must not
   *  remember its session afterwards (it was warmed in a conversation the
   *  reset just discarded — the workspace-keyed guard alone cannot catch the
   *  case where the probe CREATES its workspace only after the reset). */
  let conversationGeneration = 0

  function cleanupWorkspace(): void {
    if (workspace) {
      rmSync(workspace, { recursive: true, force: true })
      workspace = null
    }
  }

  /** ONE ACP probe spawn: detect, warm the session in the conversation
   *  workspace, remember the session for the first-run resume, and return the
   *  renderer-facing result (the session id stays main-side — the renderer's
   *  resume handle comes from the run's session event as usual). */
  async function runProbe(kind: string): Promise<CoachInspectResult> {
    const generation = conversationGeneration
    try {
      const found = await deps.detect()
      const harness = found.find(h => h.kind === kind)
      if (!harness) {
        return { ok: false, error: `harness not detected: ${kind}` }
      }
      const runtime = await deps.getRuntime()
      // The conversation workspace as the probe's cwd — created lazily, the
      // same way the first run would; a session-less probe must still spawn
      // the agent somewhere real (reset/quit cleans it up). Snapshot the path
      // locally: a reset mid-probe must not re-key the remembered session to
      // the NEW workspace it would otherwise point the closure at.
      const probeWorkspace = workspace ??= mkdtempSync(join(tmpdir(), 'watchtower-coach-'))
      const result = await runtime.inspect({ harness, workspacePath: probeWorkspace })
      // Only remember the session if no reset happened while probing — a
      // stale probe belongs to a discarded conversation and must never be
      // resumed by the next one (generation, not workspace, is the truth).
      if (result.sessionId && conversationGeneration === generation) {
        probedSession = { kind, sessionId: result.sessionId, workspace: probeWorkspace }
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
      queued.resolve(startProbe(queued.kind))
    }
  }

  /** Starts the probe chain (or continues it after the active probe settles):
   *  the chain is the single spawn slot — when it frees up, a queued newer
   *  kind is probed next and its caller resolves with its own result. */
  function startProbe(kind: string): Promise<CoachInspectResult> {
    probedChain = runProbe(kind).then(
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

    async inspect(kind): Promise<CoachInspectResult> {
      // Coalesce (optimization): never run two probes at once. A free slot
      // spawns immediately; otherwise the newest requested kind queues (a
      // previously queued one is superseded and resolved now — it never gets
      // its spawn, and the renderer would have dropped its result anyway).
      if (probedChain === null) {
        return startProbe(kind)
      }
      if (probedQueued) probedQueued.resolve({ ok: false, error: 'superseded' })
      return new Promise(resolve => {
        probedQueued = { kind, resolve }
      })
    },

    async start(request: unknown, emit): Promise<CoachRunResult> {
      const parsed = coachRunRequestSchema.safeParse(request)
      if (!parsed.success) {
        return { ok: false, error: 'invalid coach run request' }
      }
      const req: CoachRunRequest = parsed.data

      // The conversation's UI scope snapshot (map 53): the ledger MCP server
      // is baked to it at spawn. Absent scope degrades to the app's default
      // period (the renderer always sends the current UI scope).
      const scope: OverviewScope = req.scope ?? { period: 'all' }

      // Mode-tagged presence check FIRST (ADR 0017): cheap, side-effect-free,
      // and the canonical error precedence — a build-skill run without
      // evidence (or a coach run without a prompt) is refused before anything
      // is detected or spawned. The actual prompt STRING is built later, once
      // the briefing is known.
      if (req.mode === 'build-skill' && !req.evidence) {
        return { ok: false, error: 'build-skill run requires evidence' }
      }
      if (req.mode !== 'build-skill' && (!req.prompt || !req.prompt.trim())) {
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
      const ledgerServer = deps.ledgerMcpServer(scope)
      // The MCP briefing (ADR 0020): what the ledger tools are, what window
      // they cover, and the ground-your-answer rule. Only on the FIRST run of
      // a conversation (no sessionId yet) — the harness resumes its session
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
      // (the re-check narrows probedSession for TS — resumeProbed alone cannot
      // prove it is non-null)
      const resumeSessionId = resumeProbed && probedSession ? probedSession.sessionId : req.sessionId

      // Mode-tagged prompt build (ADR 0017): build-skill runs derive the
      // authoring prompt from the candidate's NORMALIZED evidence, main-side
      // — never from renderer text. Both prompts are MCP-aware (ADR 0020):
      // the briefing tells the agent it can query the user's real usage data
      // through the ledger tools.
      const prompt = req.mode === 'build-skill'
        ? buildProsePrompt(req.evidence!, briefing)
        : buildCoachPrompt(req.prompt!, briefing)

      try {
        const runtime = await deps.getRuntime()
        const runId = randomUUID()

        // Per-conversation temp workspace: created on the conversation's first
        // run and REUSED for the whole conversation — a resumed run (sessionId
        // present, whether a coach turn or a build-skill run seeded from a
        // pattern chip) and a session-less one both share it, so a run must
        // NEVER destroy it. Only `coach:reset` (renderer resetSession — a
        // brand-new conversation) and app quit delete it. `mkdtemp` guarantees
        // a real on-disk path — the seam's own workspace validation still runs.
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
        // tears the ACP provider's child process down (ADR 0016).
        // return() can reject if the generator's finally (provider cleanup)
        // throws — that must not become an unhandled rejection; the stream is
        // already being torn down by the caller's intent.
        void gen.return(undefined).catch(() => { /* teardown already in flight */ })
      }
    },

    reset() {
      for (const runId of [...activeRuns.keys()]) this.cancel(runId)
      // The probe-warmed session lives in the workspace being deleted — it is
      // meaningless to the next conversation. Clear it AND bump the generation
      // so any probe still in flight (which may not even have created its
      // workspace yet) knows not to remember its session for the new
      // conversation.
      probedSession = null
      conversationGeneration++
      cleanupWorkspace()
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
  /** Builds the in-app ledger MCP server for a scope (map 53) — the runner's
   *  app-specific dep, supplied by the composition root (main/index.ts). Null
   *  when there is no ledger.db yet (fresh install) — no data, no tools. */
  ledgerMcpServer: (scope: OverviewScope) => AcpMcpServer | null
}

/** Wire the Coach & Skills IPC surface onto ipcMain. Call once from
 *  registerIpc(); returns the runner cleanup handle (temp workspace teardown)
 *  for the app's quit path. `dismissals` bridges the not-a-skill store. */
export function registerAgentsIpc(sources: AgentsIpcSources): { reset: () => void } {
  const { dismissals, appPath, ledgerMcpServer } = sources
  let runtimePromise: Promise<HarnessRuntime> | null = null
  const runner = createCoachRunner({
    // The SDK is ESM and heavy; boot stays independent of it (the seam's
    // lazy-wire design). First run pays the load once.
    getRuntime: () => {
      runtimePromise ??= loadHarnessSdk().then(createHarnessRuntime)
      return runtimePromise
    },
    detect: () => detectHarnesses({ resolveBundled: spec => resolveBundledEntry(spec, appPath) }),
    ledgerMcpServer,
  })

  ipcMain.handle('coach:harnesses', async (): Promise<CoachHarnessRow[]> => runner.harnesses())

  /** Pre-flight probe (map 47 ticket 50): the harness's handshake-declared
   *  models/modes without a run, so the pickers render before the first
   *  message. The request is a bare registry key — the runner re-detects and
   *  never trusts it beyond that key, and a probe failure is `{ ok: false }`
   *  (pickers absent, chat unaffected). */
  ipcMain.handle('coach:inspect', async (_event, kind: unknown): Promise<CoachInspectResult> => {
    if (typeof kind !== 'string' || kind.trim() === '') {
      return { ok: false, error: 'invalid coach inspect request' }
    }
    return runner.inspect(kind)
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
    runner.cancel(runId)
  })

  /** Conversation reset (map 53 ticket 56): cancels active runs and deletes
   *  the conversation's temp workspace — fired by the renderer's
   *  `resetSession` (a brand-new conversation) and by the app quit path. */
  ipcMain.on('coach:reset', () => {
    runner.reset()
  })

  // Skills draft board (ticket 25): the not-a-skill store. skills:view /
  // skills:save stay in registerIpc (they need the ledger + dialog directly);
  // this module owns the harness-touching wire — and build-skill prose now
  // runs through coach:run's mode tag (ADR 0017), so no separate prose
  // channel exists here anymore.
  ipcMain.handle('skills:dismiss', (_event, request: unknown): SkillsDismissalResult => {
    const parsed = skillsDismissalRequestSchema.safeParse(request)
    if (!parsed.success) return { ok: false, error: 'invalid dismissal request' }
    dismissals.dismiss(parsed.data.source, parsed.data.name, parsed.data.reason)
    return { ok: true }
  })

  return { reset: () => runner.reset() }
}
