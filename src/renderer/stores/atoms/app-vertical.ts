import * as Atom from 'effect/reactivity/Atom'

import type { AppVertical } from '@/renderer/app/navigation.js'
import { ROUTES } from '@/shared/schemas/navigation.js'

export interface AnalyticsDestination {
  readonly to: string
  readonly sourceId?: number
}

export interface ResolvedAppRoute {
  readonly pathname: string
  readonly sourceId?: number
}

export const appVerticalAtom = Atom.keepAlive(Atom.make<AppVertical>('workspace'))
export const lastAnalyticsDestinationAtom = Atom.keepAlive(Atom.make<AnalyticsDestination>({ to: '/' }))

export const syncAppVerticalFromRouteAtom = Atom.writable(
  get => get(appVerticalAtom),
  (context, route: ResolvedAppRoute) => {
    const vertical: AppVertical = route.pathname === ROUTES.workspace ? 'workspace' : 'analytics'
    if (context.get(appVerticalAtom) !== vertical) context.set(appVerticalAtom, vertical)
    if (vertical === 'workspace') return

    const destination = { to: route.pathname, ...(route.sourceId === undefined ? {} : { sourceId: route.sourceId }) }
    const current = context.get(lastAnalyticsDestinationAtom)
    if (current.to !== destination.to || current.sourceId !== destination.sourceId) {
      context.set(lastAnalyticsDestinationAtom, destination)
    }
  },
)
