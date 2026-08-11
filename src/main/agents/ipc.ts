import { randomUUID } from 'node:crypto'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { detectHarnesses, type HarnessInfo } from './detect.js'
import { assertRealWorkspacePath, createHarnessRuntime, loadHarnessSdk, type HarnessRuntime } from './runtime.js'
import {
  coachRunRequestSchema,
  type CoachEvent,
  type CoachEventEnvelope,
  type CoachHarnessRow,
  type CoachRunRequest,
  type CoachRunResult,
  type CoachWorkspaceResult,
} from '../../shared/schemas/agents.js'
import {
  skillsDismissalRequestSchema,
  type SkillsDismissal,
  type SkillsDismissalResult,
  type SkillsProseRequest,
} from '../../shared/schemas/skills.js'

/**
 * Coach & Skills IPC (ADR 0017): the wire between the HarnessRuntime seam and
 * the renderer's unified Coach & Skills surface. The runner is a pure,
 * injectable controller (ADR 0006) — it owns run ack/stream/cancel against an
 * injected runtime + detection, so it is unit-testable without electron;
 * `registerAgentsIpc` is the thin glue that maps it onto ipcMain + webContents.
 *
 * Wire contract (frozen, shared schemas): `coach:harnesses` (invoke → rows),
 * `coach:run` (invoke → immediate `{ ok: true, runId }` ack, events pushed on
 * `coach:event` as runId-enveloped CoachEvents), `coach:cancel` (send →
 * interrupts the active run's SDK iterator so the harness gets a native stop),
 * `coach:pick-workspace` (invoke → OS directory picker). The renderer
 * revalidates every payload against the same schemas (ADR 0005).
 *
 * Mode-tagged runs (ADR 0017): a `build-skill` run carries a candidate's
 * NORMALIZED evidence; the authoring prompt is built HERE, main-side, so the
 * renderer never ships raw transcripts to the harness. `coach` runs stream
 * the user's own prompt verbatim.
 */

export interface CoachRunnerDeps {
  /** Lazily-provided seam — the SDK loads on the first run, not at boot. */
  getRuntime: () => Promise<HarnessRuntime>
  /** Detection for the picker AND the run's HarnessInfo (scrubEnv, bin). The
   *  runner never trusts the renderer's kind string beyond a registry key. */
  detect: () => Promise<HarnessInfo[]>
}

export interface CoachRunner {
  harnesses(): Promise<CoachHarnessRow[]>
  /** Validates, acks immediately with a runId, then streams events to `emit`
   *  as they arrive. A `{ ok: false }` ack means the request never launched
   *  (bad workspace, unknown harness, malformed request). */
  start(request: unknown, emit: (runId: string, event: CoachEvent) => void): Promise<CoachRunResult>
  /** Interrupts the active run's generator so the harness's cleanup runs. */
  cancel(runId: string): void
}

/** The harness prompt for a build-skill run: normalized evidence only —
 *  pattern key, counts, spread. Deliberately excludes `sample` (a raw command
 *  line) and all session text, so the model never sees raw transcripts. */
function buildProsePrompt(evidence: SkillsProseRequest): string {
  return [
    'You are authoring a skill file for the user\'s coding-agent workflow.',
    'Write a concise SKILL.md draft from ONLY the normalized evidence below — never invent raw transcripts or prompts.',
    '',
    `Pattern: ${evidence.name}`,
    `Source: ${evidence.source}`,
    `Frequency: ${evidence.frequency} occurrences`,
    `Spread: ${evidence.spreadSessions} session(s) / ${evidence.spreadProjects} project(s)`,
    `Cost: ${evidence.costUSD.toFixed(2)} USD across ${evidence.turns} turn(s)`,
    '',
    'Return only the markdown: a # name heading, a ## Description, a ## When to use, and a ## Example built from the evidence. Keep it under 40 lines.',
  ].join('\n')
}

export function createCoachRunner(deps: CoachRunnerDeps): CoachRunner {
  const activeRuns = new Map<string, AsyncGenerator<CoachEvent>>()

  return {
    async harnesses() {
      const found = await deps.detect()
      return found.map(h => ({
        kind: h.kind,
        displayName: h.displayName,
        models: [...h.models],
        authStatus: h.authStatus,
      }))
    },

    async start(request: unknown, emit): Promise<CoachRunResult> {
      const parsed = coachRunRequestSchema.safeParse(request)
      if (!parsed.success) {
        return { ok: false, error: 'invalid coach run request' }
      }
      const req: CoachRunRequest = parsed.data

      // Mode-tagged prompt (ADR 0017): build-skill runs derive the authoring
      // prompt from the candidate's NORMALIZED evidence, main-side — never
      // from renderer text. A build-skill run without evidence is refused.
      let prompt: string
      if (req.mode === 'build-skill') {
        if (!req.evidence) return { ok: false, error: 'build-skill run requires evidence' }
        prompt = buildProsePrompt(req.evidence)
      } else {
        if (!req.prompt || !req.prompt.trim()) return { ok: false, error: 'coach run requires a prompt' }
        prompt = req.prompt
      }

      // A bad workspace must fail loudly and cheaply at the ack, never as an
      // inscrutable spawn error mid-stream (ticket 15 constraint).
      try {
        assertRealWorkspacePath(req.workspacePath)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }

      const found = await deps.detect()
      const harness = found.find(h => h.kind === req.harnessKind)
      if (!harness) {
        return { ok: false, error: `harness not detected: ${req.harnessKind}` }
      }

      try {
        const runtime = await deps.getRuntime()
        const runId = randomUUID()
        const gen = runtime.run({
          harness,
          model: req.model ?? '',
          workspacePath: req.workspacePath,
          prompt,
          ...(req.sessionId ? { sessionId: req.sessionId } : {}),
        })
        activeRuns.set(runId, gen)

        // Stream in the background — the ack returns immediately; events land
        // on the push channel as they stream. A generator throw (post-ack
        // workspace race, SDK failure) becomes an error event, never a crash.
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
}

/** Wire the Coach & Skills IPC surface onto ipcMain. Call once from
 *  registerIpc(). `dismissals` bridges the not-a-skill store. */
export function registerAgentsIpc(sources: AgentsIpcSources): void {
  const { dismissals } = sources
  let runtimePromise: Promise<HarnessRuntime> | null = null
  const runner = createCoachRunner({
    // The SDK is ESM and heavy; boot stays independent of it (the seam's
    // lazy-wire design). First run pays the load once.
    getRuntime: () => {
      runtimePromise ??= loadHarnessSdk().then(createHarnessRuntime)
      return runtimePromise
    },
    detect: () => detectHarnesses(),
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

  /** Workspace picker (ADR 0017): the OS directory dialog IS the user's
   *  choice of where a harness run works. The main process never guesses. */
  ipcMain.handle('coach:pick-workspace', async (): Promise<CoachWorkspaceResult> => {
    const picked = await dialog.showOpenDialog({
      title: 'Choose a workspace',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Select',
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, error: 'cancelled' }
    return { ok: true, path: picked.filePaths[0] }
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
}
