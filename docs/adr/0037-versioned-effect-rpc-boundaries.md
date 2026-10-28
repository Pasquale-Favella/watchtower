# Versioned Effect RPC contracts connect renderer, main and db-worker

Status: accepted and implemented in [PR #175](https://github.com/Pasquale-Favella/watchtower/pull/175), including both RPC boundaries. Verification for each revision is recorded in [issue #174](https://github.com/Pasquale-Favella/watchtower/issues/174).

Watchtower adopts shared Effect Schema RPC contracts for application requests and owned event streams, through a versioned Electron capability in the isolated preload. Main authenticates the originating window and frame, applies its capability allowlist, and owns connection lifecycle. The renderer receives no raw Electron or Node access. Main remains the forwarder for ledger work; the single db-worker retains SQL, scans and complete synchronous transaction ownership.

Shell and Orb operations use this same protocol. The preload exposes only `rpcV1` and immutable platform/version metadata. `BackgroundShell` remains the native owner of windows, dragging, placement, tray behavior and navigation. The authenticated connection serializes Orb commands; only the beacon may drag and only the panel may acknowledge painting/data readiness. Each shell event subscription registers before emitting its initial Ready snapshot and fails visibly if its bounded buffer fills. No command is replayed after reconnect.

Effect Deferred, timeout and Scope own preload connection readiness and port/listener cleanup. Promise conversion occurs only at the contextBridge boundary. A bounded grace period closes late transferred ports after disposal; obsolete connection generations cannot replace a newer port. Navigation and Orb streams reuse the renderer's existing scoped event loop rather than adding another service runtime.

This explicitly amends the frozen-wire clauses in ADRs 0005 and 0023 for the new versioned protocol. Existing channels preserve their representations while callers migrate, and are retired when their inventory has no remaining application callers. Schema authority, trust-boundary validation, bounded Operational log notices and native ownership remain mandatory. MessagePort is the preferred Electron transport subject to real sandboxed verification. Main/db-worker RPC uses official Node worker adapters only after readiness, single-owner replacement, stable-read, abort-drain and shutdown parity are proven. The migration must not replay possibly committed commands after disconnect.

See [the adoption plan](../plans/effect-renderer-adoption.md) for milestone-specific acceptance, compatibility adapters and retirement gates.
