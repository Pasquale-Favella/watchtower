import {
  DbWorkerClient,
  type DbWorkerPort,
  type DbWorkerTransport,
  type DbWorkerTransportCallbacks,
  type DbWorkerTransportFactory,
} from '../src/platform/electron/workers/client.js'
import type { DbWorkerData } from '../src/platform/electron/workers/protocol.js'

export interface ControlledWorker extends DbWorkerPort {
  readonly listeners: Map<string, Array<(...args: unknown[]) => void>>
  terminationCalls: number
  terminateImpl: () => Promise<unknown>
  emit(event: string, ...args: unknown[]): void
}

export interface ControlledCall {
  readonly operation: string
  readonly args: unknown[]
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

export interface ControlledTransport extends DbWorkerTransport {
  readonly calls: ControlledCall[]
  readonly closeCalls: number
  resolveReady(): void
  rejectReady(error: Error): void
  emitEvent(event: Parameters<DbWorkerTransportCallbacks['onEvent']>[0]): void
  fail(error: Error): void
  resolveCall(index: number, value: unknown): void
  rejectCall(index: number, error: Error): void
}

export interface ControlledDbWorker {
  readonly client: DbWorkerClient
  readonly workers: ControlledWorker[]
  readonly transports: ControlledTransport[]
}

type Responder = (transport: ControlledTransport, call: ControlledCall, index: number) => void

function deferred<A>() {
  let resolve!: (value: A) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<A>((res, rej) => {
    resolve = res
    reject = rej
  })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

class ControlledWorkerPort implements ControlledWorker {
  readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  terminationCalls = 0
  terminateImpl: () => Promise<unknown> = async () => 0

  postMessage(message: unknown): void {
    void message
  }

  on(event: string, listener: (...args: unknown[]) => void): unknown {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(listener)
    this.listeners.set(event, listeners)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }

  terminate(): Promise<unknown> {
    this.terminationCalls++
    return this.terminateImpl()
  }
}

class ControlledTransportImpl implements ControlledTransport {
  private readonly readyState = deferred<undefined>()
  private readonly callbacks: DbWorkerTransportCallbacks
  private responder: Responder | undefined
  private closeCount = 0
  private readySettled = false
  private closed = false
  private readonly inflight = new Set<ReturnType<typeof deferred<unknown>>>()
  readonly calls: ControlledCall[] = []

  readonly ready = this.readyState.promise

  constructor(callbacks: DbWorkerTransportCallbacks, responder?: Responder) {
    this.callbacks = callbacks
    this.responder = responder
  }

  get closeCalls(): number {
    return this.closeCount
  }

  request(operation: string, args: unknown[]): Promise<unknown> {
    return this.ready.then(() => {
      if (this.closed) throw new Error('worker transport closed')
      const pending = deferred<unknown>()
      this.inflight.add(pending)
      const finish = (settle: () => void): void => {
        if (!this.inflight.delete(pending)) return
        settle()
      }
      const call: ControlledCall = {
        operation,
        args,
        resolve: value => finish(() => pending.resolve(value)),
        reject: error => finish(() => pending.reject(error)),
      }
      const index = this.calls.push(call) - 1
      this.responder?.(this, call, index)
      return pending.promise
    })
  }

  close(): Promise<void> {
    this.closeCount++
    this.closed = true
    if (!this.readySettled) {
      this.readySettled = true
      this.readyState.reject(new Error('worker transport closed'))
    }
    return Promise.resolve()
  }

  resolveReady(): void {
    this.readySettled = true
    this.readyState.resolve(undefined)
  }

  rejectReady(error: Error): void {
    this.readySettled = true
    this.readyState.reject(error)
  }

  emitEvent(event: Parameters<DbWorkerTransportCallbacks['onEvent']>[0]): void {
    this.callbacks.onEvent(event)
  }

  fail(error: Error): void {
    this.callbacks.onFailure(error)
  }

  resolveCall(index: number, value: unknown): void {
    const call = this.calls[index]
    if (!call) throw new Error(`No transport call at index ${index}`)
    call.resolve(value)
  }

  rejectCall(index: number, error: Error): void {
    const call = this.calls[index]
    if (!call) throw new Error(`No transport call at index ${index}`)
    call.reject(error)
  }
}

export function makeControlledDbWorker(
  responder?: Responder,
  onWorker?: (worker: ControlledWorker, transport: ControlledTransport) => void,
): ControlledDbWorker {
  const workers: ControlledWorker[] = []
  const transports: ControlledTransport[] = []
  const init: DbWorkerData = { dbPath: ':memory:', dataDir: ':memory:', cacheDir: ':memory:' }
  const spawn = (): ControlledWorker => {
    const worker = new ControlledWorkerPort()
    workers.push(worker)
    return worker
  }
  const makeTransport: DbWorkerTransportFactory = (_worker, callbacks) => {
    const transport = new ControlledTransportImpl(callbacks, responder)
    transports.push(transport)
    const worker = workers[workers.length - 1]
    if (worker) onWorker?.(worker, transport)
    return transport
  }
  const client = new DbWorkerClient(init, 'controlled-worker.js', spawn, makeTransport)
  return { client, workers, transports }
}
