# Shortcut registry is the single source of truth for shortcuts

Status: accepted

The app declares every keyboard shortcut exactly once in `src/renderer/src/app/shortcuts.ts` — one static `SHORTCUTS` table of `{ action, hotkey, label }` — and both registration (`useHotkeys` in `use-app-hotkeys.ts`) and every UI rendering of a shortcut (sidebar badges, footer keycaps, the TopBar title) read from that same table. Components reference an `action`, never a keycap string: no `Mod+`/`Ctrl+` literal exists anywhere outside the registry.

The `Mod` modifier resolves to `⌘` on macOS and `Ctrl` on Windows/Linux, and display is platform-aware. The shadcn sidebar primitive explicitly refuses to register the sidebar toggle itself — it documents that the shortcut "is registered at the app level from the shortcuts registry (ADR 0001), not here" (`ui/sidebar.tsx`).

**Why:** a shortcut has two lives — it must be registered and it must be rendered (badge, tooltip, footer). Keeping them as one artifact means adding or changing a shortcut is a one-line table edit and both follow automatically; there is no second source to drift.
