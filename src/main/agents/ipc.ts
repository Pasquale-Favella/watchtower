import { randomUUID } from 'node:crypto'
import { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import { detectHarnesses, type HarnessInfo } from './detect.js'
import { assertRealWorkspacePath, createHarnessRuntime, loadHarnessSdk, type HarnessRuntime } from './runtime.js'
import {
  coachRunRequestSchema,
  type AgentsConsentResult,
  type CoachEvent,
  type CoachEventEnvelope,
  type CoachHarnessRow,
  type CoachRunRequest,
  type CoachRunResult,
} from '../../shared/schemas/agents.js'

/**
 * Coach IPC (ticket 21): the wire between the HarnessRuntime seam and the
 * renderer. The runner is a pure, injectable controller (ADR 0006) — it owns
 * run ack/stream/cancel against an injected runtime + detection, so it is
 * unit-testable without electron; `registerAgentsIpc` is the thin glue that
 * maps it onto ipcMain + webContents.
 *
 * Wire contract (frozen, shared schemas): `coach:harnesses` (invoke → rows),
 * `coach:run` (invoke → immediate `{ ok: true, runId }` ack, events pushed on
 * `coach:event` as runId-enveloped CoachEvents), `coach:cancel` (send →
 * interrupts the active run's SDK iterator so the harness gets a native stop).
 * The renderer revalidates every payload against the same schemas (ADR 0005).
 */

export interface CoachRunnerDeps {
  /** Lazily-provided seam — the SDK loads on the first run, not at boot. */
  getRuntime: () => Promise<HarnessRuntime>
  /** Detection for the picker AND the run's HarnessInfo (scrubEnv, bin). The
   *  runner never trusts the renderer's kind string beyond a registry key. */
  detect: () => Promise<HarnessInfo[]>
  /** The consent gate (ticket 22, ADR 0012 addendum) — the ONE thing that
   *  lets ledger-derived data reach a harness's model provider. Main-authoritative:
   *  the runner refuses every unconsented run, so a bypassed or stale renderer
   *  can never leak data past the gate. Default-off is enforced in the ledger. */
  getConsent: () => boolean
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

      // The privacy gate (ADR 0012 addendum): an unconsented run is refused
      // here, before any SDK load or spawn — even if the renderer never asked.
      if (!deps.getConsent()) {
        return { ok: false, error: 'consent required' }
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
          prompt: req.prompt,
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

/** The main-side consent accessors the IPC surface wires to the ledger
 *  (ticket 22). Passed in so this module stays electron-agnostic and the
 *  ledger stays the single source of truth. */
export interface AgentsConsentSource {
  getConsent: () => boolean
  setConsent: (granted: boolean) => void
}

/** Wire the Coach IPC surface onto ipcMain. Call once from registerIpc().
 *  `consent` bridges the gate to the ledger's persisted setting. */
export function registerAgentsIpc(consent: AgentsConsentSource): void {
  let runtimePromise: Promise<HarnessRuntime> | null = null
  const runner = createCoachRunner({
    // The SDK is ESM and heavy; boot stays independent of it (the seam's
    // lazy-wire design). First run pays the load once.
    getRuntime: () => {
      runtimePromise ??= loadHarnessSdk().then(createHarnessRuntime)
      return runtimePromise
    },
    detect: () => detectHarnesses(),
    getConsent: consent.getConsent,
  })

  ipcMain.handle('agents:consent:get', (): AgentsConsentResult => ({ granted: consent.getConsent() }))

  ipcMain.handle('agents:consent:set', (_event, granted: unknown): AgentsConsentResult => {
    const parsed = z.literal(true).or(z.literal(false)).safeParse(granted)
    if (!parsed.success) return { granted: consent.getConsent() }
    consent.setConsent(parsed.data)
    return { granted: consent.getConsent() }
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
}
