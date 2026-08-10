# Renderer navigation: TanStack Router (code-based, memory history, pure navigation)

Status: accepted

Navigation is owned by **TanStack Router**, replacing the zustand section-switch that ADR 0011 described. The renderer mounts a **code-based** route tree (no `@tanstack/router-plugin`, no generated route file) over **memory history** for both dev and prod, and the router is **pure navigation** — it never fetches data; the seven section views keep reading their scope-keyed stores with the shared scan-driven refresh tick.

Why these three choices:

- **Code-based tree** — eight flat sections plus one nested detail is a tiny surface; an explicit `createRootRoute`/`createRoute` tree is readable, needs no codegen or plugin, and stays importable pure-TS in the headless vitest suite. Typed routes come from every route's `getParentRoute` plus one `Register` interface declaration.
- **Memory history** (`createMemoryHistory({ initialEntries: ['/'] })`) — the packaged app loads from `file://`, so browser/hash history would rewrite the URL to an unresolvable file path. Memory history never touches `window.location`; creating the router once at module scope keeps it StrictMode-safe.
- **Pure navigation** — TanStack's route loaders would split the data path into a second refresh mechanism with its own cache (unaware of `store:changed`/`config:changed` scans), risk IPC-on-hover via `defaultPreload: 'intent'`, and reintroduce the loading-flash the stores deliberately fix.

Amends ADR 0011: the `ContentRegion` section switch and the shell store's navigation state (`section`, `openSession`, `navigate`/`navigateString`, `openSessionById`/`closeSession`) are removed. The shell store is renamed **`scope-store`** (`useScopeStore`) and retains only the scope slice — `period`, `provider`, `customRange`, their setters, and `selectScope`. Route identity (section + `/sessions/$sessionId`) is the router's; scope stays in the store (memory history means no real URLs to deep-link, so search params buy nothing).

## Considered options

- **File-based routes** (`routes/*` + `@tanstack/router-plugin` codegen): auto code-splitting and path-derived routes, but adds a build plugin (must precede `@vitejs/plugin-react`), a committed `routeTree.gen.ts`, and an electron-vite `routesDirectory` gotcha — ceremony for eight flat routes.
- **Browser history in dev, memory in prod**: two code paths behaving differently for no benefit; no URL reflection is needed in an Electron app.
- **Route loaders / IPC in `beforeLoad`**: rejected — see "pure navigation" above.

## Consequences

- New modules: `app/router.tsx` (route tree + router + `Register`), `app/navigation.ts` (route constants, `SECTIONS`, `navigateToSection`).
- The shell store becomes the scope store; `SECTIONS` moves to `app/navigation.ts`; the shortcut registry (ADR 0001) still owns keys/labels.
- Settings is a full-bleed route inside the shell layout; the dashboard chrome (`TopBar`/`StatusBar`) is a nested layout wrapping the seven sections.
- The data layer (`subscribe.ts`, `scan-store.ts`, the scope-keyed stores) is untouched.
