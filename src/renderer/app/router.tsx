import { createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import * as Schema from 'effect/Schema'

import { AnalyticsProvider } from '@/renderer/app/AnalyticsProvider'
import { AppRoot } from '@/renderer/app/AppRoot'
import { setRouter } from '@/renderer/app/navigation'
import { DashboardLayout } from '@/renderer/components/shell/dashboard-layout'
import { CoachSkillsView } from '@/renderer/features/coach-skills/CoachSkillsView'
import { CompareView } from '@/renderer/features/compare/CompareView'
import { ModelsView } from '@/renderer/features/models/ModelsView'
import { OptimizeView } from '@/renderer/features/optimize/OptimizeView'
import { OverviewView } from '@/renderer/features/overview/OverviewView'
import { PullRequestsView } from '@/renderer/features/pull-requests/PullRequestsView'
import { SessionsView } from '@/renderer/features/sessions/SessionsView'
import { SessionView } from '@/renderer/features/sessions/SessionView'
import { SettingsView } from '@/renderer/features/settings/SettingsView'
import { SpendView } from '@/renderer/features/spend/SpendView'
import { WorkspaceView } from '@/renderer/features/workspace/WorkspaceView'
import { sessionDetailSearchSchema } from '@/shared/schemas/views.js'

// Code-based route tree on memory history (ADR 0014): created once at module
// scope so StrictMode's double-render shares one router. The root route is
// the shared app frame. Analytics owns its provider and dashboard layouts;
// Workspace uses the shared sidebar without Analytics controls. Layout routes
// use `id` and consume no URL segment. The router handles navigation without
// loaders; feature stores keep driving every view.
const rootRoute = createRootRoute({ component: AppRoot })

const analyticsRoute = createRoute({ getParentRoute: () => rootRoute, id: 'analytics', component: AnalyticsProvider })
const dashboardRoute = createRoute({
  getParentRoute: () => analyticsRoute,
  id: 'dashboard',
  component: DashboardLayout,
})

const overviewRoute = createRoute({ getParentRoute: () => dashboardRoute, path: '/', component: OverviewView })
const sessionsRoute = createRoute({ getParentRoute: () => dashboardRoute, path: '/sessions', component: SessionsView })
const sessionDetailRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: '/sessions/$sessionId',
  validateSearch: Schema.decodeUnknownSync(sessionDetailSearchSchema),
  component: SessionView,
})
const pullRequestsRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: '/pull-requests',
  component: PullRequestsView,
})
const spendRoute = createRoute({ getParentRoute: () => dashboardRoute, path: '/spend', component: SpendView })
const optimizeRoute = createRoute({ getParentRoute: () => dashboardRoute, path: '/optimize', component: OptimizeView })
const modelsRoute = createRoute({ getParentRoute: () => dashboardRoute, path: '/models', component: ModelsView })
const compareRoute = createRoute({ getParentRoute: () => dashboardRoute, path: '/compare', component: CompareView })
const coachSkillsRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: '/coach-skills',
  component: CoachSkillsView,
})

const settingsRoute = createRoute({ getParentRoute: () => analyticsRoute, path: '/settings', component: SettingsView })

const workspaceRoute = createRoute({ getParentRoute: () => rootRoute, path: '/workspace', component: WorkspaceView })

const routeTree = rootRoute.addChildren([
  analyticsRoute.addChildren([
    dashboardRoute.addChildren([
      overviewRoute,
      sessionsRoute,
      sessionDetailRoute,
      pullRequestsRoute,
      spendRoute,
      optimizeRoute,
      modelsRoute,
      compareRoute,
      coachSkillsRoute,
    ]),
    settingsRoute,
  ]),
  workspaceRoute,
])

export const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: ['/workspace'] }),
})

// Navigation goes through app/navigation.ts (module-level, works during the
// splash) instead of importing the router there — keeps it headless-testable.
setRouter((to, sourceId) => {
  void router.navigate({ to, search: sourceId === undefined ? {} : { sourceId } })
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
