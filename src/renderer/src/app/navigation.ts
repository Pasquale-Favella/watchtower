import { ROUTES, type Section, SECTIONS } from '../../../shared/schemas/navigation.js'

// The renderer's navigation entry point (ADR 0014). Sections and routes
// themselves are declared once in shared/schemas/navigation.ts.

/** The route path for a section. */
export function routeFor(section: Section): string {
  return ROUTES[section]
}

/** The section a pathname belongs to. Session detail counts as `sessions`;
 * anything unknown falls back to the index section. Used by the sidebar to
 * derive the active section from the current route. */
export function sectionForPath(pathname: string): Section {
  if (pathname === ROUTES.sessions || pathname.startsWith(`${ROUTES.sessions}/`)) {
    return 'sessions'
  }
  const section = SECTIONS.find(section => ROUTES[section] === pathname)
  return section ?? 'overview'
}

type Navigate = (to: string) => void

let navigate: Navigate | null = null

/** Injected by app/router.tsx at startup so this module stays pure TS — it
 * never imports the router, keeping it unit-testable in a headless vitest
 * node env (the router graph touches window.api at import time). */
export function setRouter(navigateImpl: Navigate): void {
  navigate = navigateImpl
}

/** Navigate to a section's route. A no-op until the router is wired. */
export function navigateToSection(section: Section): void {
  if (navigate) navigate(routeFor(section))
}

/** Navigate to a session detail route. */
export function navigateToSession(id: string): void {
  if (navigate) navigate(ROUTES.sessionDetail(id))
}
