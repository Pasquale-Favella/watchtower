# Separate the engine core from infrastructure and desktop adapters

Watchtower already has two engine consumers: the desktop db-worker and the
read-only ledger MCP query process. Keeping their shared application code under
`src/main/` hides that boundary and lets reusable services import desktop or
Harness implementations. Use one modular monolith with `src/core/`,
`src/infrastructure/`, `src/platform/electron/`, and `src/renderer/`.

The core owns domain facts, ingestion policy, analytics, application queries and
commands, and capability contracts. Infrastructure supplies SQLite, provider
adapters, Harness implementations and Node IO. Platform adapters compose those
implementations and own process lifetimes, transports, windows and native UI.
The MCP adapter lives in `src/platform/mcp/`. Shared wire schemas stay under
`src/shared/`, independent of implementations. ESLint rejects core imports of
infrastructure, platform or renderer code, including type-only imports.

Keep Effect, SQLite, Electron and React. Existing Effect services supply the
filesystem and clock ports; the local port modules expose those same services
without adding another abstraction. `CommandRunner` and `ScanSources` separate
application operations from native execution and provider IO. Pure calculations
remain ordinary functions. Keep existing provider files together until a
specific parser needs a further split.

This changes source ownership, not the process design in ADRs 0023, 0032 and 0037. Each isolate still owns its runtime, the worker retains the one writable
ledger connection, MCP uses a separate read-only connection, and transactions
remain synchronous. No package publication or network boundary is introduced.
A future CLI must select its storage paths and resource lifetime explicitly;
this extraction does not permit a second writer on the desktop ledger or make
the process-local provider/pricing snapshots safe for independent concurrent
engine instances.
