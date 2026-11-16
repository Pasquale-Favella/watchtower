import { routeForVertical } from '@/renderer/app/navigation.js'
import { registry } from '@/renderer/app/renderer-runtime.js'
import { router } from '@/renderer/app/router.js'
import { appVerticalAtom } from '@/renderer/stores/atoms/app-vertical.js'

/** Apply the registry's hydrated vertical before RouterProvider starts loading routes. */
export function initializeAppRoute(): void {
  const initialRoute = routeForVertical(registry.get(appVerticalAtom))
  if (router.history.location.pathname === '/workspace' && initialRoute !== '/workspace') {
    router.history.replace(initialRoute)
  }
}
