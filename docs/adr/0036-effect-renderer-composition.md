# Effect Atom and scoped workflows own shared renderer state

Status: accepted, implementation in progress.

Watchtower adopts Effect Atom for shared renderer state and scoped Effect services for asynchronous renderer workflows. Each window owns one Atom registry and runtime factory; React retains rendering and interaction-local state, and TanStack Router retains navigation without data loaders. This removes Zustand and aligns subscriptions, typed failures and remote queries with the existing backend composition model.

This decision supersedes the renderer runtime restrictions in ADRs 0005, 0011, 0032 and 0034. It preserves synchronous, IO-free Schema decoding, visible contract errors and dropped malformed broadcasts, same-Scope stale-while-revalidate behavior, lazy query activation, event-driven refresh, preference compatibility and window-specific imports. SQLite, scans and native capabilities retain their current owners. Migration adapters have explicit removal conditions in [the adoption plan](../plans/effect-renderer-adoption.md).
