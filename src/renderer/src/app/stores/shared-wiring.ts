import * as Effect from 'effect/Effect'
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import * as Stream from 'effect/Stream'

import { currencyChangedAtom } from '@/features/settings/atoms'
import { type RendererEvent, RendererEvents, type RendererWindowRole } from '@/shared/lib/renderer-events'

import { eventConnectionAtom, eventRetrySignalAtom } from '../atoms/event-connection.js'
import {
  applyConfigChangeAtom,
  applyScanChangeAtom,
  scanErrorAtom,
  scanIdleAtom,
  scanProgressAtom,
} from '../atoms/scan.js'
import { runtime } from '../renderer-runtime.js'

/** Each window mounts one scoped event consumer; only data windows mount currency state. */
export function createWindowEventAtom(
  role: RendererWindowRole,
  dispatch: (event: RendererEvent, registry: AtomRegistry.AtomRegistry) => void,
) {
  const readyAtom = eventConnectionAtom
  const eventsAtom = runtime(RendererEvents.layer).atom(get => {
    if (role !== 'beacon') {
      get.mount(applyScanChangeAtom)
      get.mount(applyConfigChangeAtom)
    }
    get(eventRetrySignalAtom)
    get.registry.set(readyAtom, 'pending')
    return Effect.flatMap(RendererEvents, source =>
      Stream.runForEach(
        source.events(role, () => get.registry.set(readyAtom, 'ready'), role === 'app' ? ['ConfigChanged'] : []),
        event =>
          Effect.sync(() => {
            const registry = get.registry
            switch (event._tag) {
              case 'ScanProgress':
                registry.set(scanProgressAtom, event.progress)
                break
              case 'ScanError':
                registry.set(scanErrorAtom, event.message)
                break
              case 'ScanIdle':
                registry.set(scanIdleAtom, undefined)
                break
              case 'StoreChanged':
                if (role === 'beacon') registry.set(scanIdleAtom, undefined)
                else registry.set(applyScanChangeAtom, undefined)
                break
              case 'ConfigChanged':
                registry.set(applyConfigChangeAtom, undefined)
                break
              case 'CurrencyChanged':
                registry.set(currencyChangedAtom, event.currency)
                break
            }
            dispatch(event, registry)
          }),
      ),
    ).pipe(
      Effect.catch(error =>
        Effect.sync(() => {
          get.registry.set(readyAtom, 'failed')
          get.registry.set(
            scanErrorAtom,
            error.reason === 'overflow'
              ? 'Application event buffer overflow. Reopen this window to reconnect.'
              : 'Unable to subscribe to application events.',
          )
        }),
      ),
    )
  })
  return { eventsAtom, readyAtom }
}
