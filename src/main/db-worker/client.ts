import { Worker } from 'node:worker_threads'
import {
  DEDUPABLE_OPS,
  isDbWorkerEvent,
  isDbWorkerResponse,
  type DbWorkerData,
  type DbWorkerEvent,
} from './protocol.js'

/**
 * Main-side handle to the db-worker thread (ADR 0023). `request(op, ...args)`
 * resolves with the op's data or rejects with the worker-thrown error — the
 * same contract an `ipcMain.handle` had for the renderer, so every forwarder
 * in `registerIpc` is a mechanical `return client.request(channel, ...)`.
 * Worker broadcasts arrive on `onEvent` and are relayed to windows.
 *
 * Robustness policy:
 * - Boot handshake: `ready` resolves once the worker owns the ledger. A boot
 *   failure (`init-error`, e.g. an unopenable DB) rejects it and is NEVER
 *   respawned — respawning a worker that cannot init is a hot loop.
 * - Crash policy: a worker that exits AFTER becoming ready is recreated
 *   (fresh ledger connection — WAL-safe) while in-flight requests reject,
 *   exactly as an IPC failure surfaces today. No silent replay: writes must
 *   never run twice.
 * - Read coalescing: an identical pure-read op+args already in flight shares
 *   one execution (double-mounts, tick+mount races). Writes always execute.
 */
/** The sliver of `node:worker_threads.Worker` the client drives — structural
 * so tests can inject a fake port instead of spawning a real thread. */
export interface DbWorkerPort {
  postMessage(message: unknown): void
  on(event: string, listener: (...args: unknown[]) => void): unknown
  terminate(): Promise<unknown>
}

export type DbWorkerFactory = (scriptPath: string, workerData: DbWorkerData) => DbWorkerPort

const defaultFactory: DbWorkerFactory = (scriptPath, workerData) =>
  new Worker(scriptPath, { workerData }) as unknown as DbWorkerPort

export class DbWorkerClient {
  private worker: DbWorkerPort | null = null
  private nextId = 1
  private pending = new Map<number, { resolve: (data: unknown) => void; reject: (err: Error) => void }>()
  private inflightReads = new Map<string, Promise<unknown>>()
  private eventListeners = new Set<(event: DbWorkerEvent) => void>()
  private intentionalTeardown = false
  /** True once the CURRENT worker incarnation posted `ready`. Gates respawn:
   * only a worker that once lived is recreated. */
  private becameReady = false
  private initError: string | null = null
  private readyResolve!: () => void
  private readyReject!: (err: Error) => void
  /** Resolves when the worker owns the ledger; rejects on boot failure. */
  readonly ready: Promise<void>

  constructor(private init: DbWorkerData, private scriptPath: string, private spawnWorker: DbWorkerFactory = defaultFactory) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    // The constructor never awaits `ready` itself — mark it handled so a
    // boot failure the app surfaces elsewhere is not ALSO an unhandled
    // rejection. External `await client.ready` still observes the outcome.
    this.ready.catch(() => {})
    this.spawn()
  }

  private spawn(): void {
    this.becameReady = false
    this.initError = null
    const worker = this.spawnWorker(this.scriptPath, this.init)
    this.worker = worker
    worker.on('message', (raw: unknown) => this.onMessage(raw))
    worker.on('error', (raw: unknown) => {
      const err = raw instanceof Error ? raw : new Error(String(raw))
      for (const { reject } of this.pending.values()) reject(err)
      this.pending.clear()
      this.inflightReads.clear()
      // A thread error before `ready` is itself a boot failure (uncaught
      // throw during init): settle the handshake now instead of leaving it
      // to a later `exit`, which may never come for a wedged thread. The
      // exit handler below still runs and stays a safe no-op for `ready`.
      if (!this.becameReady) {
        this.initError ??= err.message
        this.readyReject(err)
      }
    })
    worker.on('exit', (raw: unknown) => {
      const code = String(raw)
      const wasReady = this.becameReady
      this.becameReady = false
      this.worker = null
      if (this.intentionalTeardown) return
      if (!wasReady) {
        // Never lived (bad DB path, corrupt store, …): respawning would spin
        // the same failure forever. Surface the boot error instead.
        const err = new Error(this.initError ?? `data worker failed to start (exit ${code})`)
        this.initError = null
        for (const { reject } of this.pending.values()) reject(err)
        this.pending.clear()
        this.inflightReads.clear()
        this.readyReject(err)
        return
      }
      const err = new Error(`data worker exited unexpectedly (code ${code})`)
      for (const { reject } of this.pending.values()) reject(err)
      this.pending.clear()
      this.inflightReads.clear()
      // Recreate so the app keeps serving reads; the renderer already shows
      // error states for the rejected in-flight calls.
      try {
        this.spawn()
      } catch (spawnErr) {
        process.stderr.write(`watchtower: failed to restart data worker: ${String(spawnErr)}\n`)
      }
    })
  }

  private onMessage(raw: unknown): void {
    if (isDbWorkerResponse(raw)) {
      const slot = this.pending.get(raw.id)
      if (!slot) return
      this.pending.delete(raw.id)
      if (raw.ok) slot.resolve(raw.data)
      else slot.reject(new Error(raw.error))
      return
    }
    if (isDbWorkerEvent(raw)) {
      // Boot handshake — consumed here, never relayed to windows.
      if (raw.event === 'ready') {
        this.becameReady = true
        this.readyResolve()
        return
      }
      if (raw.event === 'init-error') {
        this.initError = raw.error
        this.readyReject(new Error(raw.error))
        return
      }
      for (const listener of this.eventListeners) listener(raw)
    }
  }

  private send(op: string, args: unknown[] = []): Promise<unknown> {
    const worker = this.worker
    if (!worker) return Promise.reject(new Error('data worker unavailable'))
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (data: unknown) => void, reject })
      worker.postMessage({ id, op, args })
    })
  }

  /** Invoke one worker op. Identical pure-read ops already in flight share a
   * single execution; everything else always runs. Fire-and-forget callers
   * pass no args and ignore the (null) resolution. */
  request(op: string, ...args: unknown[]): Promise<unknown> {
    if (!DEDUPABLE_OPS.has(op)) return this.send(op, args)
    let key: string | null = null
    try {
      key = `${op}\n${JSON.stringify(args)}`
    } catch {
      return this.send(op, args)
    }
    const hit = this.inflightReads.get(key)
    if (hit) return hit
    const flight = this.send(op, args)
    this.inflightReads.set(key, flight)
    const forget = (): void => {
      if (this.inflightReads.get(key) === flight) this.inflightReads.delete(key)
    }
    flight.then(forget, forget)
    return flight
  }

  onEvent(listener: (event: DbWorkerEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => { this.eventListeners.delete(listener) }
  }

  /**
   * Best-effort graceful shutdown: asks the worker to checkpoint and close
   * the ledger, then terminates the thread. Resolves once the thread is gone
   * (or the timeout elapses first). Idempotent. The app's quit path calls
   * this fire-and-forget — quitting must never block on it.
   */
  async shutdown(timeoutMs = 2000): Promise<void> {
    if (this.intentionalTeardown) return
    this.intentionalTeardown = true
    try {
      await Promise.race([
        this.send('shutdown').then(
          () => undefined,
          () => undefined,
        ),
        new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
      ])
    } finally {
      const worker = this.worker
      this.worker = null
      for (const { reject } of this.pending.values()) reject(new Error('data worker shut down'))
      this.pending.clear()
      this.inflightReads.clear()
      try {
        await worker?.terminate()
      } catch { /* already gone */ }
    }
  }

  /** Permanently shut the worker down (tests). The app itself uses
   * `shutdown()` from its quit path instead. */
  async terminate(): Promise<void> {
    await this.shutdown(0)
  }
}
