import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, ipcMain } from 'electron'
import { detectHarnesses, type HarnessInfo } from './detect.js'
import { createHarnessRuntime, loadHarnessSdk, type HarnessRuntime } from './runtime.js'
import { buildCoachPrompt, buildLedgerBriefing, buildProsePrompt } from './prompts.js'
import type { AcpMcpServer } from './harnesses/types.js'
import type { OverviewScope } from '../../shared/schemas/overview.js'
import {
  coachRunRequestSchema,
  type CoachEvent,
  type CoachEventEnvelope,
  type CoachHarnessRow,
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

  function cleanupWorkspace(): void {
    if (workspace) {
      rmSync(workspace, { recursive: true, force: true })
      workspace = null
    }
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
      // would just burn tokens.
      const briefing = ledgerServer && !req.sessionId ? buildLedgerBriefing(scope) : ''

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
          ...(req.sessionId ? { sessionId: req.sessionId } : {}),
          // Merged after any spec-level servers. Null on a fresh install (no
          // ledger.db yet) — then no data tools.
          mcpServers: [...(ledgerServer ? [ledgerServer] : [])],
        })
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
  /** Builds the in-app ledger MCP server for a scope (map 53) — the runner's
   *  app-specific dep, supplied by the composition root (main/index.ts). Null
   *  when there is no ledger.db yet (fresh install) — no data, no tools. */
  ledgerMcpServer: (scope: OverviewScope) => AcpMcpServer | null
}

/** Wire the Coach & Skills IPC surface onto ipcMain. Call once from
 *  registerIpc(); returns the runner cleanup handle (temp workspace teardown)
 *  for the app's quit path. `dismissals` bridges the not-a-skill store. */
export function registerAgentsIpc(sources: AgentsIpcSources): { reset: () => void } {
  const { dismissals, ledgerMcpServer } = sources
  let runtimePromise: Promise<HarnessRuntime> | null = null
  const runner = createCoachRunner({
    // The SDK is ESM and heavy; boot stays independent of it (the seam's
    // lazy-wire design). First run pays the load once.
    getRuntime: () => {
      runtimePromise ??= loadHarnessSdk().then(createHarnessRuntime)
      return runtimePromise
    },
    detect: () => detectHarnesses(),
    ledgerMcpServer,
  })

  ipcMain.handle('coach:harnesses', async (): Promise<CoachHarnessRow[]> => runner.harnesses())

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
