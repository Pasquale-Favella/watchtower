import * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Queue from 'effect/Queue'
import * as Stream from 'effect/Stream'

import { type Section, sectionSchema } from '../../../../shared/schemas/navigation.js'
import { parseEvent } from './contract-decoder.js'

export class NavigationEventError extends Data.TaggedError('NavigationEventError')<{
  readonly reason: 'unavailable' | 'overflow'
}> {}

type NavigationBridge = Pick<Window['api'], 'onNavigate'>

/** Native window navigation retains its shell event and owns its sole listener. */
export function navigationEvents(
  bridge: () => NavigationBridge = () => window.api,
  onReady?: () => void,
  capacity = 256,
): Stream.Stream<Section, NavigationEventError> {
  return Stream.callback<Section, NavigationEventError>(
    Effect.fnUntraced(function* (queue) {
      yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            bridge().onNavigate(raw => {
              const section = parseEvent(sectionSchema, 'app navigate', raw)
              if (section !== null && !Queue.offerUnsafe(queue, section))
                Queue.failCauseUnsafe(queue, Cause.fail(new NavigationEventError({ reason: 'overflow' })))
            }),
          catch: () => new NavigationEventError({ reason: 'unavailable' }),
        }),
        unsubscribe => Effect.sync(unsubscribe),
      )
      yield* Effect.sync(() => onReady?.())
    }),
    { bufferSize: capacity },
  )
}

export class NavigationEvents extends Context.Service<
  NavigationEvents,
  {
    readonly events: (onReady: () => void) => Stream.Stream<Section, NavigationEventError>
  }
>()('watchtower/renderer/NavigationEvents') {
  static readonly layer = Layer.succeed(NavigationEvents, {
    events: onReady => navigationEvents(undefined, onReady),
  })
}
