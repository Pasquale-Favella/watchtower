import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import * as Schema from 'effect/Schema'

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

export const APP_VERTICAL_STORAGE_KEY = 'watchtower:appVertical'
const appVerticalSchema = Schema.Literals(['analytics', 'workspace'])

export interface AppVerticalStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function readStoredAppVertical(storage: Pick<Storage, 'getItem'> | null): AppVertical {
  try {
    const saved = storage?.getItem(APP_VERTICAL_STORAGE_KEY)
    if (saved === null) return 'workspace'
    const decoded = Schema.decodeUnknownResult(appVerticalSchema)(saved)
    return decoded._tag === 'Success' ? decoded.success : 'workspace'
  } catch {
    return 'workspace'
  }
}

function writeStoredAppVertical(storage: AppVerticalStorage | null, vertical: AppVertical): void {
  try {
    storage?.setItem(APP_VERTICAL_STORAGE_KEY, vertical)
  } catch {
    // Keep the in-memory vertical when browser storage is unavailable.
  }
}

export const appVerticalAtom = Atom.keepAlive(Atom.make<AppVertical>('workspace'))
export const lastAnalyticsDestinationAtom = Atom.keepAlive(Atom.make<AnalyticsDestination>({ to: '/' }))
const appVerticalStorageAtom = Atom.keepAlive(Atom.make<AppVerticalStorage | null>(null))
const hydratedRegistries = new WeakSet<AtomRegistry.AtomRegistry>()

export function hydrateAppVertical(registry: AtomRegistry.AtomRegistry, storage: AppVerticalStorage | null): void {
  if (hydratedRegistries.has(registry)) return
  hydratedRegistries.add(registry)
  registry.set(appVerticalStorageAtom, storage)
  registry.set(appVerticalAtom, readStoredAppVertical(storage))
}

export const syncAppVerticalFromRouteAtom = Atom.writable(
  get => get(appVerticalAtom),
  (context, route: ResolvedAppRoute) => {
    const vertical: AppVertical = route.pathname === ROUTES.workspace ? 'workspace' : 'analytics'
    if (context.get(appVerticalAtom) !== vertical) context.set(appVerticalAtom, vertical)
    writeStoredAppVertical(context.get(appVerticalStorageAtom), vertical)
    if (vertical === 'workspace') return

    const destination = { to: route.pathname, ...(route.sourceId === undefined ? {} : { sourceId: route.sourceId }) }
    const current = context.get(lastAnalyticsDestinationAtom)
    if (current.to !== destination.to || current.sourceId !== destination.sourceId) {
      context.set(lastAnalyticsDestinationAtom, destination)
    }
  },
)
