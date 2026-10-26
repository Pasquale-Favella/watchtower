import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import * as Reactivity from 'effect/reactivity/Reactivity'
import * as Stream from 'effect/Stream'

import { ApplicationClient, ApplicationProtocolLayer } from '@/shared/lib/application-rpc'

import type { AppLifecycleFrame, LifecycleEvent } from '../../../../shared/rpc/lifecycle.js'
import { RendererConnection } from '../../../../shared/rpc/reconnecting-protocol.js'
import { runtime as sharedRuntime } from '../renderer-runtime.js'
import { resetLedgerQueries } from '../reset-ledger.js'
import { configInvalidationRevisionAtom } from './config-change.js'

export type AppLifecycleReadiness = {
  readonly state: 'inactive' | 'pending' | 'ready' | 'failed'
  readonly message: string | null
}

export const appLifecycleReadinessAtom = Atom.keepAlive(
  Atom.make<AppLifecycleReadiness>({ state: 'inactive', message: null }),
)

const UNAVAILABLE_MESSAGE = 'Application connection unavailable. Reconnecting.'
const FIRST_RETRY_DELAY_MS = 100
const MAX_RETRY_DELAY_MS = 3_000

export interface LifecycleCursor {
  epoch: string | undefined
  generation: number | undefined
  sequence: number
}

export class LifecycleResnapshot extends Data.TaggedError('LifecycleResnapshot')<object> {}

export interface LifecycleFrameCallbacks {
  readonly registry: AtomRegistry.AtomRegistry
  readonly readinessAtom: Atom.Writable<AppLifecycleReadiness, AppLifecycleReadiness>
  readonly invalidate: () => Effect.Effect<void, never, Reactivity.Reactivity>
  readonly resetLedger: (registry: AtomRegistry.AtomRegistry) => void
}

const setReadiness = (
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Writable<AppLifecycleReadiness, AppLifecycleReadiness>,
  state: AppLifecycleReadiness['state'],
): void => {
  const previous = registry.get(atom)
  let message: string | null = null
  if (state === 'failed') message = UNAVAILABLE_MESSAGE
  else if (state === 'pending') message = previous.message
  registry.set(atom, { state, message })
}

/** Applies one app lifecycle frame; callers reuse the cursor across reconnects. */
export function applyLifecycleFrame(
  cursor: LifecycleCursor,
  callbacks: LifecycleFrameCallbacks,
  frame: AppLifecycleFrame,
): Effect.Effect<void, LifecycleResnapshot, Reactivity.Reactivity> {
  const { registry, readinessAtom, invalidate, resetLedger } = callbacks

  if (frame._tag === 'Snapshot') {
    const state = frame.state
    const epochChanged = cursor.epoch !== undefined && cursor.epoch !== state.epoch
    const generationChanged = cursor.generation !== undefined && cursor.generation !== state.ledgerGeneration
    if (epochChanged || generationChanged) resetLedger(registry)

    return invalidate().pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const isCurrentEpoch = cursor.epoch === undefined || cursor.epoch === state.epoch
          if (!isCurrentEpoch || state.sequence >= cursor.sequence) {
            cursor.epoch = state.epoch
            cursor.generation = state.ledgerGeneration
            cursor.sequence = state.sequence
            registry.set(configInvalidationRevisionAtom, state.configRevision)
          }
          setReadiness(registry, readinessAtom, 'ready')
        }),
      ),
    )
  }

  if (cursor.epoch === undefined || frame.envelope.epoch !== cursor.epoch) {
    setReadiness(registry, readinessAtom, 'pending')
    return Effect.fail(new LifecycleResnapshot())
  }
  if (frame.envelope.sequence <= cursor.sequence) return Effect.void

  const event: LifecycleEvent = frame.envelope.event
  cursor.sequence = frame.envelope.sequence
  if (event._tag === 'LedgerReset') {
    resetLedger(registry)
    cursor.generation = event.ledgerGeneration
    return invalidate()
  }
  if (event._tag !== 'ConfigChanged') return Effect.void

  return invalidate().pipe(
    Effect.tap(() => Effect.sync(() => registry.set(configInvalidationRevisionAtom, event.configRevision))),
  )
}

export interface RpcLifecycleOptions {
  readonly runtime?: Atom.RegistryRuntimeFactory
  /** Injectable event source and connection layer for lifecycle tests. */
  readonly layer?: Layer.Layer<RendererConnection>
  readonly events?: () => Stream.Stream<AppLifecycleFrame, unknown>
  readonly readinessAtom?: Atom.Writable<AppLifecycleReadiness, AppLifecycleReadiness>
  readonly invalidate?: () => Effect.Effect<void, never, Reactivity.Reactivity>
  readonly resetLedger?: (registry: AtomRegistry.AtomRegistry) => void
}

/** Creates one root-scoped config-event subscriber over the application's stable RPC client. */
export function createRpcLifecycleAtom(options: RpcLifecycleOptions = {}) {
  const runtime = options.runtime ?? sharedRuntime
  const layer = (get: Atom.AtomContext) => Layer.merge(get(ApplicationClient.runtime.layer), ApplicationProtocolLayer)
  const readinessAtom = options.readinessAtom ?? appLifecycleReadinessAtom
  const invalidate = options.invalidate ?? (() => Reactivity.invalidate(['ledger', 'pricing']))
  const resetLedger = options.resetLedger ?? resetLedgerQueries
  const makeLoop = Effect.fnUntraced(function* (
    get: Atom.AtomContext,
    events: () => Stream.Stream<AppLifecycleFrame, unknown>,
  ) {
    const registry = get.registry
    const cursor: LifecycleCursor = { epoch: undefined, generation: undefined, sequence: -1 }
    setReadiness(registry, readinessAtom, 'pending')

    const waitForConnection = Effect.gen(function* () {
      const connection = yield* RendererConnection
      let state = yield* connection.current
      while (state._tag !== 'Connected') {
        setReadiness(registry, readinessAtom, state._tag === 'Failed' ? 'failed' : 'pending')
        const next = yield* Stream.runHead(
          connection.changes.pipe(
            Stream.tap(next =>
              Effect.sync(() => setReadiness(registry, readinessAtom, next._tag === 'Failed' ? 'failed' : 'pending')),
            ),
            Stream.filter(next => next._tag === 'Connected'),
          ),
        )
        if (Option.isSome(next)) state = next.value
        else yield* Effect.sleep(FIRST_RETRY_DELAY_MS)
      }
      return connection
    })

    let retryCount = 0

    while (true) {
      const connection = yield* waitForConnection
      setReadiness(registry, readinessAtom, 'pending')
      let resnapshot = false
      const callbacks: LifecycleFrameCallbacks = { registry, readinessAtom, invalidate, resetLedger }
      yield* Effect.exit(
        Stream.runDrain(
          events().pipe(
            Stream.mapEffect(frame =>
              applyLifecycleFrame(cursor, callbacks, frame).pipe(
                Effect.as(true),
                Effect.catchTag('LifecycleResnapshot', () =>
                  Effect.sync(() => {
                    resnapshot = true
                    return false
                  }),
                ),
              ),
            ),
            Stream.takeWhile(shouldContinue => shouldContinue),
          ),
        ),
      )

      if (resnapshot) {
        retryCount = 0
        continue
      }
      setReadiness(registry, readinessAtom, 'failed')

      const delay = Math.min(MAX_RETRY_DELAY_MS, FIRST_RETRY_DELAY_MS * 2 ** Math.min(retryCount, 5))
      retryCount += 1
      yield* Effect.sleep(delay)
      // Re-read connection state after the bounded delay; if disconnected, wait for its next Connected state.
      const state = yield* connection.current
      if (state._tag !== 'Connected') setReadiness(registry, readinessAtom, 'pending')
    }
  })

  const events = options.events
  const atom = events
    ? runtime(options.layer ?? ApplicationProtocolLayer).atom<never, never>(get => makeLoop(get, events))
    : runtime(layer).atom<never, never>(get =>
        Effect.gen(function* () {
          const client = yield* ApplicationClient
          return yield* makeLoop(get, () => client('app:events', { categories: ['config', 'reset'] }))
        }),
      )

  return { atom, readinessAtom }
}

const defaultLifecycle = createRpcLifecycleAtom()
export const appRpcLifecycleAtom = defaultLifecycle.atom
