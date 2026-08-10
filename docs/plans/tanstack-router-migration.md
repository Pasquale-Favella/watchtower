# Handoff: migrate renderer navigation to TanStack Router

The destination of the map [Adopt TanStack Router in the renderer](https://github.com/Pasquale-Favella/watchtower/issues/1). Every decision is locked; this plan is sized so **one session can build it**. The data layer is not touched.

## Locked decisions (index)

- **Code-based route tree** — `createRootRoute`/`createRoute`, no router-plugin, no `routeTree.gen.ts`. Typed routes via `getParentRoute` + one `Register` interface (docs/research/tanstack-router.md).
- **Memory history for dev and prod** — `createMemoryHistory({ initialEntries: ['/'] })`; router created once at module scope (StrictMode-safe).
- **Pure-navigation router** — no route loaders, no `beforeLoad`/IPC. Views keep their ADR 0011 stores + the scan-driven refresh tick.
- **Scope stays in the store** — no search params. Router owns only route identity.
- **Session detail is a route param** `/sessions/$sessionId`; list at `/sessions`. Invalid ids hit the existing `loadSession` `ErrorPanel`.
- **Settings full-bleed inside the shell** — outer sidebar persists; six pane tabs stay local state.
- **Shortcut wiring via `app/navigation.ts`** — module-level `navigateToSection(action)` calling the module-scope router; registry (ADR 0001) unchanged.
- **Shell store becomes `scope-store`** — navigation state leaves; `SECTIONS` moves to `app/navigation.ts`.

## Target route tree

```
/                                     (root — component: AppShell: splash/onboarding gate, <Outlet/>)
└── /                                 (shell layout — SidebarProvider + SidebarToggleShortcut + AppSidebar
                                        + SidebarInset > ScanIndicator + <Outlet/>)
    ├── /                             (dashboard layout — TopBar + <Outlet/> + StatusBar)
    │   ├── /                         → OverviewView
    │   ├── /sessions                 → SessionsView
    │   ├── /sessions/$sessionId      → SessionView   (wrapped in the existing max-w-[1180px] column)
    │   ├── /pull-requests            → PullRequestsView
    │   ├── /spend                    → SpendView
    │   ├── /optimize                 → OptimizeView
    │   ├── /models                   → ModelsView
    │   └── /compare                  → CompareView
    └── /settings                     → SettingsView (full-bleed)
```

Layout routes are **pathless** — created with an `id` (`createRoute({ id: 'shell', component })`), not `path: '/'`. Two nested `path: '/'` layouts collide on route id `/` (`createRouter` throws "Duplicate routes found with id: /" and the renderer fails at import → blank screen). Only the overview index keeps `path: '/'`.

## Files

### Add
- `src/renderer/src/app/navigation.ts` — `ROUTES` path constants (incl. `sessionDetail(id)`), `SECTIONS` (canonical order, moved from shell-store), `navigateToSection(action: Section)` → `router.navigate({ to: routeFor(action) })`. Pure TS.
- `src/renderer/src/app/router.tsx` — all route definitions, the assembled `routeTree`, `createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/'] }) })`, and `declare module '@tanstack/react-router' { interface Register { router: typeof router } }`. Export `router` for `navigation.ts`.
- `src/renderer/src/app/components/dashboard-layout.tsx` — `<TopBar/><Outlet/><StatusBar/>`.
- `tests/navigation.test.ts` — `navigateToSection` mapping (action → route path) and `SECTIONS` ordering. Headless.

### Change
- `package.json` — add dependency `@tanstack/react-router` (^1.170).
- `src/renderer/src/main.tsx` — render `<RouterProvider router={router} />` inside `HotkeysProvider`/`StrictMode`.
- `src/renderer/src/app/AppShell.tsx` — stays the root route component: keeps `useAppBootstrap`/`useThemeEffect`/`useAppHotkeys`; renders `<Splash/>` while `!hydrated`, else `<Outlet/>` (+ onboarding). No longer imports `ShellLayout`.
- `src/renderer/src/app/components/shell-layout.tsx` — becomes the shell route layout: `SidebarProvider` + `SidebarToggleShortcut` + `<AppSidebar/>` + `SidebarInset > ScanIndicator + <Outlet/>`. **Delete `ContentRegion`** (the section if/else switch) and the `settingsMode` branch; drop the per-section view imports.
- `src/renderer/src/app/components/app-sidebar.tsx` — `active` from the router (e.g. `useMatch`/`useLocation` on the route path) instead of `store.section`; item clicks via `navigateToSection(id)` (or `Link`); footer caption reads the scope store.
- `src/renderer/src/app/components/TopBar.tsx` — scope selectors/setters from `useScopeStore`.
- `src/renderer/src/app/hooks/use-app-hotkeys.ts` — section actions call `navigateToSection(def.action)`; `refresh` stays as-is; drop the store `navigate`.
- `src/renderer/src/features/overview/OverviewView.tsx` — `navigateString('models')` (the "See all ›" button) → `navigateToSection('models')`.
- `src/renderer/src/features/sessions/SessionsView.tsx` — row `onOpen` → navigate to `/sessions/$id` (via `navigation.ts`); `selectScope` import from scope-store.
- `src/renderer/src/features/sessions/SessionView.tsx` — `sessionId` from `useParams`; Back button → navigate to `/sessions`; drop `openSession`/`closeSession`; keep `loadSession` + `ErrorPanel`.
- `src/renderer/src/app/stores/shell-store.ts` → **rename** to `scope-store.ts` (git mv), `useShellStore` → `useScopeStore`, remove `section`/`openSession`/`navigate`/`navigateString`/`openSessionById`/`closeSession` and `SECTIONS`; keep `period`/`provider`/`customRange` + setters + `selectScope` (including the `initialPeriod` seed from settings).
- Seven feature views import `selectScope, useShellStore` → `selectScope, useScopeStore` from `@/app/stores/scope-store`: ModelsView, SpendView, CompareView, OverviewView, PullRequestsView, SessionsView, OptimizeView.
- `tests/shell-store.test.ts` → `tests/scope-store.test.ts` — drop the navigation assertions (`navigate sets the section…`, `navigateString…`, `openSessionById/closeSession round-trip`); keep period-seeding + `selectScope` suites; update imports.

### Unchanged
- `electron.vite.config.ts` (no plugin), `tsconfig.web.json`, `vitest.config.ts`.
- `app/shortcuts.ts` + `tests/shortcuts.test.ts` (registry, ADR 0001).
- `shared/lib/shell.ts` + `tests/shell-logic.test.ts` (provider options / scope caption / theme).
- `subscribe.ts`, `scan-store.ts`, the scope-keyed data stores.

## Build order

1. `npm i @tanstack/react-router`.
2. `app/navigation.ts` (pure TS; testable immediately).
3. Rename `shell-store.ts` → `scope-store.ts`, strip navigation state; sweep the seven view imports + TopBar.
4. Split `shell-layout.tsx` into the shell layout + `dashboard-layout.tsx`; delete `ContentRegion`.
5. `app/router.tsx` (routes, tree, router, `Register`).
6. `main.tsx` → `RouterProvider`; `AppShell` → Splash-or-Outlet root component.
7. `app-sidebar.tsx` (active state + clicks); `use-app-hotkeys.ts`.
8. SessionsView / SessionView / OverviewView call sites.
9. Tests: `scope-store.test.ts`, `navigation.test.ts`, view-test import updates.

## Build-verify

```
npm run typecheck && npm test
```

Then `npm run dev` smoke:
- Sidebar navigates all eight sections; active highlight follows the route.
- Shortcuts `Mod+1..7`, `Mod+,`, `Mod+R`, `Mod+B` work; ⌘R works during the splash.
- Sessions list → drilldown (param route) → Back returns to the list; an id that resolves to a load error shows the ErrorPanel.
- Settings is full-bleed with the outer sidebar still visible; six pane tabs switch.
- Scope selectors (period / provider / custom range) still drive every view; switching period clears a custom range.
- Splash → app, onboarding on first launch.

## Not in scope (from the map's Out of scope)

File-based routes, search params, route loaders/code-splitting, real-URL deep links, per-pane settings routes.
