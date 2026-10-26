import * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Queue from 'effect/Queue'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'

import { coachEventEnvelopeSchema, coachHarnessesResultSchema } from '../../../../shared/schemas/agents.js'
import { activeCurrencySchema } from '../../../../shared/schemas/fx.js'
import { scanProgressMessageSchema, storeChangedMessageSchema } from '../../../../shared/schemas/ipc.js'
import { sectionSchema } from '../../../../shared/schemas/navigation.js'
import { orbPlacementSchema } from '../../../../shared/schemas/orb.js'
import { updateStatusSchema } from '../../../../shared/schemas/updates.js'
import { parseEvent } from './api.js'

export type RendererWindowRole = 'app' | 'beacon' | 'panel'
type LegacyEventExclusion = 'ConfigChanged' | 'CurrencyChanged'

export type RendererEvent =
  | { readonly _tag: 'ScanProgress'; readonly progress: typeof scanProgressMessageSchema.Type }
  | { readonly _tag: 'ScanError'; readonly message: string }
  | { readonly _tag: 'StoreChanged'; readonly metadata: typeof storeChangedMessageSchema.Type }
  | { readonly _tag: 'ScanIdle' }
  | { readonly _tag: 'ConfigChanged' }
  | { readonly _tag: 'CurrencyChanged'; readonly currency: typeof activeCurrencySchema.Type }
  | { readonly _tag: 'UpdateChanged'; readonly status: typeof updateStatusSchema.Type }
  | { readonly _tag: 'CoachEvent'; readonly envelope: typeof coachEventEnvelopeSchema.Type }
  | { readonly _tag: 'HarnessesChanged'; readonly rows: typeof coachHarnessesResultSchema.Type }
  | { readonly _tag: 'Navigate'; readonly section: typeof sectionSchema.Type }
  | { readonly _tag: 'Placement'; readonly placement: typeof orbPlacementSchema.Type }

export class RendererEventError extends Data.TaggedError('RendererEventError')<{
  readonly reason: 'unavailable' | 'overflow'
}> {}

type EventBridge = Pick<
  Window['api'],
  | 'onProgress'
  | 'onError'
  | 'onChanged'
  | 'onIdle'
  | 'onConfigChanged'
  | 'onCurrencyChanged'
  | 'onUpdateChanged'
  | 'onCoachEvent'
  | 'onCoachHarnessesChanged'
  | 'onNavigate'
> & { readonly orb: Pick<Window['api']['orb'], 'onPlacement'> }

/** Each consumer owns its subscriptions through the Stream scope. */
export function legacyRendererEvents(
  role: RendererWindowRole,
  bridge: () => EventBridge = () => window.api,
  capacity = 256,
  onReady?: () => void,
  excluded: ReadonlyArray<LegacyEventExclusion> = [],
): Stream.Stream<RendererEvent, RendererEventError> {
  return Stream.callback<RendererEvent, RendererEventError>(
    Effect.fnUntraced(function* (queue) {
      const source = yield* Effect.try({
        try: bridge,
        catch: () => new RendererEventError({ reason: 'unavailable' }),
      })
      const publish = (event: RendererEvent): void => {
        if (!Queue.offerUnsafe(queue, event)) {
          Queue.failCauseUnsafe(queue, Cause.fail(new RendererEventError({ reason: 'overflow' })))
        }
      }
      const attach = (subscribe: () => () => void) =>
        Effect.acquireRelease(
          Effect.try({ try: subscribe, catch: () => new RendererEventError({ reason: 'unavailable' }) }),
          unsubscribe => Effect.sync(unsubscribe),
        )
      const included = (tag: LegacyEventExclusion): boolean => !excluded.includes(tag)
      yield* attach(() =>
        source.onProgress(raw => {
          const progress = parseEvent(scanProgressMessageSchema, 'scan progress', raw)
          if (progress) publish({ _tag: 'ScanProgress', progress })
        }),
      )
      yield* attach(() =>
        source.onError(raw => {
          const message = parseEvent(Schema.String, 'scan error', raw)
          if (message !== null) publish({ _tag: 'ScanError', message })
        }),
      )
      yield* attach(() =>
        source.onChanged(raw => {
          const metadata = parseEvent(storeChangedMessageSchema, 'store changed', raw)
          if (metadata) publish({ _tag: 'StoreChanged', metadata })
        }),
      )
      yield* attach(() => source.onIdle(() => publish({ _tag: 'ScanIdle' })))

      if (role !== 'beacon') {
        if (included('ConfigChanged'))
          yield* attach(() => source.onConfigChanged(() => publish({ _tag: 'ConfigChanged' })))
        if (included('CurrencyChanged'))
          yield* attach(() =>
            source.onCurrencyChanged(raw => {
              const currency = parseEvent(activeCurrencySchema, 'currency changed', raw)
              if (currency) publish({ _tag: 'CurrencyChanged', currency })
            }),
          )
      }
      if (role === 'app') {
        yield* attach(() =>
          source.onUpdateChanged(raw => {
            const status = parseEvent(updateStatusSchema, 'update status', raw)
            if (status) publish({ _tag: 'UpdateChanged', status })
          }),
        )
        yield* attach(() =>
          source.onCoachEvent(raw => {
            const envelope = parseEvent(coachEventEnvelopeSchema, 'coach event', raw)
            if (envelope) publish({ _tag: 'CoachEvent', envelope })
          }),
        )
        yield* attach(() =>
          source.onCoachHarnessesChanged(raw => {
            const rows = parseEvent(coachHarnessesResultSchema, 'coach harnesses changed', raw)
            if (rows) publish({ _tag: 'HarnessesChanged', rows })
          }),
        )
        yield* attach(() =>
          source.onNavigate(raw => {
            const section = parseEvent(sectionSchema, 'app navigate', raw)
            if (section) publish({ _tag: 'Navigate', section })
          }),
        )
      } else {
        yield* attach(() =>
          source.orb.onPlacement(raw => {
            const placement = parseEvent(orbPlacementSchema, 'orb placement', raw)
            if (placement) publish({ _tag: 'Placement', placement })
          }),
        )
      }
      yield* Effect.sync(() => onReady?.())
    }),
    { bufferSize: capacity },
  )
}

export class RendererEvents extends Context.Service<
  RendererEvents,
  {
    readonly events: (
      role: RendererWindowRole,
      onReady?: () => void,
      excluded?: ReadonlyArray<LegacyEventExclusion>,
    ) => Stream.Stream<RendererEvent, RendererEventError>
  }
>()('watchtower/renderer/RendererEvents') {
  static readonly layer = Layer.succeed(RendererEvents, {
    events: (role, onReady, excluded) => legacyRendererEvents(role, () => window.api, 256, onReady, excluded),
  })
}
