# Effect Atom and scoped workflows own shared renderer state

Status: accepted and implemented in [PR #175](https://github.com/Pasquale-Favella/watchtower/pull/175). Verification for each revision is recorded in [issue #174](https://github.com/Pasquale-Favella/watchtower/issues/174).

The component-hook and preload/Orb follow-up at `1517174` passes [full CI](https://github.com/Pasquale-Favella/watchtower/actions/runs/40716380267), including actual Windows/Linux Electron tests and installer acceptance on Windows, macOS and Linux.

Watchtower adopts Effect Atom for shared renderer state and scoped Effect services for asynchronous renderer workflows. Each window owns one Atom registry and runtime factory; React retains rendering and interaction-local state, and TanStack Router retains navigation without data loaders. This removes Zustand and aligns subscriptions, typed failures and remote queries with the existing backend composition model.

React views consume feature store hooks. These hooks expose domain values, pending/error states and commands, and subscribe only to the fields their callers need. Atoms, registry operations, RPC clients and generic query plumbing stay behind that boundary. The renderer root is the explicit exception for providing its owned registry. ESLint enforces this component import boundary. Hooks do not mirror Atom values into another state store or introduce a generic store factory.

This decision supersedes the renderer runtime restrictions in ADRs 0005, 0011, 0032 and 0034. It preserves synchronous, IO-free Schema decoding, visible contract errors and dropped malformed broadcasts, same-Scope stale-while-revalidate behavior, lazy query activation, event-driven refresh, preference compatibility and window-specific imports. SQLite, scans and native capabilities retain their current owners. Migration adapters have explicit removal conditions in [the adoption plan](../plans/effect-renderer-adoption.md).
