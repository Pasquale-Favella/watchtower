import type { LedgerMcpAttachment } from '../ipc.js'
import type { AcpMcpServer } from '../harnesses/types.js'
import { safeLogOperationalEvent } from '../../operational-log.js'
import type { LedgerMcpSpawnContext } from './config.js'
import type { StartedLedgerMcpHttp } from './sidecar.js'

/**
 * App-level pool for the loopback-HTTP ledger sidecar: one sidecar serves
 * every Coach conversation and explicitly configured local MCP clients
 * instead of spawning + booting + readiness-probing for each conversation.
 * Reuse is safe because the sidecar carries no per-turn state (it serves the
 * full lifetime ledger) and the ledger runs in WAL mode (a long-lived
 * read-only handle never blocks writers nor goes stale — every statement
 * reads the latest commit).
 *
 * The pool sits behind the runner's `ledgerMcpServer` seam, so the runner is
 * untouched: per-run attachments carry a no-op release (the settle path is
 * unchanged). A pooled sidecar is health-gated on every acquire — one that
 * died between turns is respawned, never handed out. Conversation reset does
 * not drop it because a local external client may be using it independently;
 * app quit still releases it. A reset-like generation race kills an orphan
 * and degrades that turn to no-tools (the booked honesty rule).
 */

export interface SidecarPoolDeps {
  spawn: (ctx: LedgerMcpSpawnContext) => Promise<StartedLedgerMcpHttp>
}

export interface SidecarPool {
  /** A healthy pooled sidecar's server, or null when none could be started
   *  (spawn failure, reset raced the spawn) — the turn runs without data
   *  tools, exactly like a sidecar that fails to boot. */
  acquire: (ctx: LedgerMcpSpawnContext) => Promise<LedgerMcpAttachment | null>
  /** Returns the healthy HTTP server config for a Coach or local client. */
  connection: (ctx: LedgerMcpSpawnContext) => Promise<AcpMcpServer | null>
  /** Replaces the running sidecar and bearer token. If it was stopped, this
   *  starts it on demand. */
  regenerate: (ctx: LedgerMcpSpawnContext) => Promise<AcpMcpServer | null>
  /** Returns the current healthy server, if one is running. */
  status: () => Promise<AcpMcpServer | null>
  /** Drops the app-level sidecar (app quit). In-flight spawns are orphaned by
   *  generation and killed on arrival — never pooled. */
  releaseAll: () => void
}

export function createSidecarPool(deps: SidecarPoolDeps): SidecarPool {
  let pooled: StartedLedgerMcpHttp | null = null
  let inflight: Promise<StartedLedgerMcpHttp | null> | null = null
  let generation = 0

  function logHealthFailure(): void {
    safeLogOperationalEvent('error', 'sidecar.error', { op: 'ledger-mcp-health', code: 'unhealthy' }, 'sidecar')
  }

  async function spawnFresh(ctx: LedgerMcpSpawnContext): Promise<StartedLedgerMcpHttp | null> {
    const gen = generation
    let started: StartedLedgerMcpHttp
    try {
      started = await deps.spawn(ctx)
    } catch {
      return null
    }
    if (gen !== generation) {
      started.release()
      return null
    }
    pooled = started
    return started
  }

  async function acquire(ctx: LedgerMcpSpawnContext): Promise<LedgerMcpAttachment | null> {
    // The app serves a single ledger.db — one slot, no keying. A pooled
    // sidecar is health-gated on every acquire: one that died between
    // conversations is respawned, never handed out.
    if (pooled) {
      let healthy = false
      try {
        healthy = await pooled.checkHealth()
      } catch { /* treat a failed probe as unhealthy */ }
      if (healthy) return { server: pooled.server, release: () => {} }
      // A sidecar that died between turns is respawned, never handed out —
      // and the death is recorded (health failures are log records, #129).
      logHealthFailure()
      pooled.release()
      pooled = null
    }
    // Coalesce: rapid turns while a spawn is in flight share it instead of
    // spawning one sidecar each. The guard clears only the owning slot, so
    // a reset racing a spawn can never orphan a newer spawn's handle (which
    // would leak a duplicate sidecar no acquire can reach).
    if (!inflight) {
      const slot: Promise<StartedLedgerMcpHttp | null> = spawnFresh(ctx).finally(() => {
        if (inflight === slot) inflight = null
      })
      inflight = slot
    }
    const started = await inflight
    return started ? { server: started.server, release: () => {} } : null
  }

  async function connection(ctx: LedgerMcpSpawnContext): Promise<AcpMcpServer | null> {
    const attachment = await acquire(ctx)
    return attachment?.server ?? null
  }

  async function regenerate(ctx: LedgerMcpSpawnContext): Promise<AcpMcpServer | null> {
    releaseAll()
    return connection(ctx)
  }

  async function status(): Promise<AcpMcpServer | null> {
    if (!pooled) return null
    let healthy = false
    try {
      healthy = await pooled.checkHealth()
    } catch { /* treat a failed probe as unhealthy */ }
    if (healthy) return pooled.server
    logHealthFailure()
    pooled.release()
    pooled = null
    return null
  }

  function releaseAll(): void {
    generation++
    inflight = null
    pooled?.release()
    pooled = null
  }

  return { acquire, connection, regenerate, status, releaseAll }
}
