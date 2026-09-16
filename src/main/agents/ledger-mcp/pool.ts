import type { LedgerMcpAttachment } from '../ipc.js'
import type { LedgerMcpSpawnContext } from './config.js'
import type { StartedLedgerMcpHttp } from './sidecar.js'

/**
 * Per-conversation pool for the loopback-HTTP ledger sidecar (ADR 0026): one
 * sidecar serves every turn of a conversation instead of spawning + booting +
 * readiness-probing on each one. Reuse is safe because the sidecar carries no
 * per-turn state (it serves the full lifetime ledger) and the ledger runs in
 * WAL mode (a long-lived read-only handle never blocks writers nor goes
 * stale — every statement reads the latest commit).
 *
 * The pool sits behind the runner's `ledgerMcpServer` seam, so the runner is
 * untouched: per-run attachments carry a no-op release (the settle path is
 * unchanged) and the pool drops the sidecar on conversation reset/quit. A
 * pooled sidecar is health-gated on every acquire — one that died between
 * turns is respawned, never handed out. A reset racing an in-flight spawn
 * kills the orphan and degrades that turn to no-tools (the booked honesty
 * rule) rather than leaking a stale server into the new conversation.
 */

export interface SidecarPoolDeps {
  spawn: (ctx: LedgerMcpSpawnContext) => Promise<StartedLedgerMcpHttp>
}

export interface SidecarPool {
  /** A healthy pooled sidecar's server, or null when none could be started
   *  (spawn failure, reset raced the spawn) — the turn runs without data
   *  tools, exactly like a sidecar that fails to boot. */
  acquire: (ctx: LedgerMcpSpawnContext) => Promise<LedgerMcpAttachment | null>
  /** Drops the pooled sidecar (conversation reset/quit). In-flight spawns are
   *  orphaned by generation and killed on arrival — never pooled. */
  releaseAll: () => void
}

export function createSidecarPool(deps: SidecarPoolDeps): SidecarPool {
  let pooled: StartedLedgerMcpHttp | null = null
  let inflight: Promise<StartedLedgerMcpHttp | null> | null = null
  let generation = 0

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

  return {
    async acquire(ctx: LedgerMcpSpawnContext): Promise<LedgerMcpAttachment | null> {
      // The app serves a single ledger.db — one slot, no keying. A pooled
      // sidecar is health-gated on every acquire: one that died between
      // turns is respawned, never handed out.
      if (pooled) {
        try {
          if (await pooled.checkHealth()) {
            return { server: pooled.server, release: () => {} }
          }
        } catch {
          // Unhealthy — fall through to respawn.
        }
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
    },

    releaseAll(): void {
      generation++
      inflight = null
      pooled?.release()
      pooled = null
    },
  }
}
