import { createMemoryHistory, createRoute, createRootRoute, createRouter } from '@tanstack/react-router'

import { AppShell } from './AppShell'
import { setRouter } from './navigation'
import { ShellLayout } from './components/shell-layout'
import { DashboardLayout } from './components/dashboard-layout'
import { OverviewView } from '@/features/overview/OverviewView'
import { SessionsView } from '@/features/sessions/SessionsView'
import { SessionView } from '@/features/sessions/SessionView'
import { PullRequestsView } from '@/features/pull-requests/PullRequestsView'
import { SpendView } from '@/features/spend/SpendView'
import { OptimizeView } from '@/features/optimize/OptimizeView'
import { ModelsView } from '@/features/models/ModelsView'
import { CompareView } from '@/features/compare/CompareView'
import { SettingsView } from '@/features/settings/SettingsView'

/** Session detail keeps the existing max-w-[1180px] column the other views
 * render themselves (ADR 0014). */
function SessionDetailRoute() {
  return (
    <div className="w-full max-w-[1180px]">
      <SessionView />
    </div>
  )
}

// Code-based route tree on memory history (ADR 0014): created once at module
// scope so StrictMode's double-render shares one router. The shell and
// dashboard are pathless layout routes (created by `id`, not `path`) — they
// render an <Outlet/> and consume no URL segment; only the overview index
// keeps `path: '/'`. The router is pure-navigation — no loaders, the ADR 0011
// stores keep driving every view.
const rootRoute = createRootRoute({ component: AppShell })

const shellRoute = createRoute({ getParentRoute: () => rootRoute, id: 'shell', component: ShellLayout })

const dashboardRoute = createRoute({ getParentRoute: () => shellRoute, id: 'dashboard', component: DashboardLayout })

const overviewRoute = createRoute({ getParentRoute: () => dashboardRoute, path: '/', component: OverviewView })
const sessionsRoute = createRoute({ getParentRoute: () => dashboardRoute, path: '/sessions', component: SessionsView })
const sessionDetailRoute = createRoute({ getParentRoute: () => dashboardRoute, path: '/sessions/$sessionId', component: SessionDetailRoute })
const pullRequestsRoute = createRoute({ getParentRoute: () => dashboardRoute, path: '/pull-requests', component: PullRequestsView })
const spendRoute = createRoute({ getParentRoute: () => dashboardRoute, path: '/spend', component: SpendView })
const optimizeRoute = createRoute({ getParentRoute: () => dashboardRoute, path: '/optimize', component: OptimizeView })
const modelsRoute = createRoute({ getParentRoute: () => dashboardRoute, path: '/models', component: ModelsView })
const compareRoute = createRoute({ getParentRoute: () => dashboardRoute, path: '/compare', component: CompareView })

const settingsRoute = createRoute({ getParentRoute: () => shellRoute, path: '/settings', component: SettingsView })

const routeTree = rootRoute.addChildren([
  shellRoute.addChildren([
    dashboardRoute.addChildren([
      overviewRoute,
      sessionsRoute,
      sessionDetailRoute,
      pullRequestsRoute,
      spendRoute,
      optimizeRoute,
      modelsRoute,
      compareRoute,
    ]),
    settingsRoute,
  ]),
])

export const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: ['/'] }),
})

// Navigation goes through app/navigation.ts (module-level, works during the
// splash) instead of importing the router there — keeps it headless-testable.
setRouter(to => { void router.navigate({ to }) })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
