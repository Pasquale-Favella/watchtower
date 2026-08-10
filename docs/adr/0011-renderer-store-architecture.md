# Renderer architecture: scope-keyed SWR data stores, a shared refresh tick, central IPC wiring, and a composition-root shell

Status: accepted

The renderer is built from three cooperating layers, all store-driven:

- **Scope-keyed data slices with stale-while-revalidate** (`src/renderer/src/app/stores/data-store.ts`). Each feature store wraps one fetch in a `ScopedDataSlice<T>` keyed by `JSON.stringify(scope)`. Refetching the **same** scope keeps the last-known payload visible and replaces it on success (a deliberate fix of the loading-flash), while switching scope clears to a fresh load; out-of-order responses are dropped via a keyed guard instead of an effect-tied `cancelled` flag.
- **A shared refresh tick** (`scan-store.ts`). Data stores register a `reload` on a module-level listener set; `applyChange()` (fired by `store:changed` or `config:changed`) notifies every listener, so every mounted section refetches after a scan without polling. Lazy stores (e.g. Optimize's Yield slice, the pricing panel) only start listening once first loaded, so an unopened panel never fetches.
- **Central IPC wiring** (`subscribe.ts`). All six `window.api.on*` subscriptions live in one module that feeds store actions — never component state — and returns a teardown. `subscribe.ts` and `lib/api.ts` are the only modules that touch `window`; stores stay pure and testable.

**The shell is a composition root** (`AppShell.tsx`): it only decides splash-vs-app and mounts onboarding. Theme, hotkeys, and bootstrap logic live in hooks (`use-theme-effect`, `use-app-hotkeys`, `use-app-bootstrap`); the JSX lives in `ShellLayout` composed of store-driven components (AppSidebar, TopBar, Splash, ContentRegion) that each read their own store and the shared scope selector — no props threaded. Settings is full-bleed with its own rail, handled by `ShellLayout`.

**Why:** eight sections all read period/provider-scoped data and all must refresh on the same scan event. Centralizing the refresh trigger, the IPC wiring, and the scope model makes a section a one-liner (`createScopedDataStore(fetchX)`) and keeps every component a pure reader of its store — which is what makes the renderer testable without jsdom and keeps `window` confined to two modules.
