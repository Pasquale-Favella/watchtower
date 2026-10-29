import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import * as Reactivity from 'effect/reactivity/Reactivity'
import * as Stream from 'effect/Stream'

import { RendererConnection, type RendererConnectionState } from '../../../shared/rpc/reconnecting-protocol.js'

const FIRST_RETRY_DELAY_MS = 100
const MAX_RETRY_DELAY_MS = 3_000

export type RoleConnectionReadiness = 'inactive' | 'pending' | 'ready' | 'failed'

export interface RoleLifecycleCursor {
  epoch: string | undefined
  sequence: number
  generation: number | undefined
}

export interface RoleLifecycleOptions<Frame, Services> {
  readonly readinessAtom: Atom.Writable<RoleConnectionReadiness, RoleConnectionReadiness>
  readonly events: () => Effect.Effect<Stream.Stream<Frame, unknown>, unknown, Services>
  /** Return false when the frame exposed a gap and a fresh snapshot is needed. */
  readonly apply: (
    frame: Frame,
    cursor: RoleLifecycleCursor,
    registry: AtomRegistry.AtomRegistry,
  ) => Effect.Effect<boolean, never, Reactivity.Reactivity>
}

/** A role-local stream loop with snapshot hydration and bounded reconnect delay. */
export const runRoleLifecycle = Effect.fnUntraced(function* <Frame, Services>(
  get: Atom.AtomContext,
  options: RoleLifecycleOptions<Frame, Services>,
): Effect.fn.Return<never, never, Services | Reactivity.Reactivity | RendererConnection> {
  const registry = get.registry
  const readinessAtom = options.readinessAtom
  const cursor: RoleLifecycleCursor = { epoch: undefined, sequence: -1, generation: undefined }
  let retryCount = 0
  registry.set(readinessAtom, 'pending')

  const connection = yield* RendererConnection
  const awaitConnection = Effect.gen(function* () {
    let state: RendererConnectionState = yield* connection.current
    while (state._tag !== 'Connected') {
      registry.set(readinessAtom, state._tag === 'Failed' ? 'failed' : 'pending')
      const next = yield* Stream.runHead(
        connection.changes.pipe(
          Stream.tap(next =>
            Effect.sync(() => {
              if (next._tag !== 'Connected') registry.set(readinessAtom, next._tag === 'Failed' ? 'failed' : 'pending')
            }),
          ),
          Stream.filter(next => next._tag === 'Connected'),
        ),
      )
      if (Option.isSome(next)) state = next.value
      else yield* Effect.sleep(FIRST_RETRY_DELAY_MS)
    }
  })

  while (true) {
    yield* awaitConnection
    registry.set(readinessAtom, 'pending')
    let resnapshot = false
    yield* Effect.exit(
      Effect.flatMap(options.events(), stream =>
        Stream.runDrain(
          stream.pipe(
            Stream.mapEffect(frame =>
              Effect.map(options.apply(frame, cursor, registry), keepReading => {
                if (!keepReading) resnapshot = true
                return keepReading
              }),
            ),
            Stream.takeWhile(Boolean),
          ),
        ),
      ),
    )

    if (resnapshot) {
      retryCount = 0
      continue
    }

    registry.set(readinessAtom, 'failed')
    const delay = Math.min(MAX_RETRY_DELAY_MS, FIRST_RETRY_DELAY_MS * 2 ** Math.min(retryCount, 5))
    retryCount++
    yield* Effect.sleep(delay)
    const state = yield* connection.current
    if (state._tag !== 'Connected') registry.set(readinessAtom, 'pending')
  }
})
