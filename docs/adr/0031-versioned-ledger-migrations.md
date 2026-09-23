# Version the local ledger schema with SQLite migrations

Status: proposed

## Context

The writable ledger is owned by one db-worker thread and accessed through
synchronous `node:sqlite` calls. Its schema was previously initialized with
`CREATE TABLE IF NOT EXISTS`, with no durable schema version or upgrade path.
The provider SQLite databases are external, read-only inputs and are not
application schemas.

Effect is already used by the Coach harness layer, but ADR 0030 limits that
adoption to `src/main/agents/`. The official Effect Node SQLite SQL client and
migrator inspected for issue #146 use the Effect 4 API, while Watchtower uses
Effect 3.22.2. Moving the store to an Effect SQL client would also change its
synchronous API and affect the view, export, and MCP call paths without solving
a need the existing worker boundary does not already handle.

## Decision

Use ordered, synchronous migrations on the existing `node:sqlite` connection.
SQLite's `PRAGMA user_version` is the schema version. Each migration is applied
under `BEGIN IMMEDIATE`; its DDL/data changes and version update commit together
or roll back together. Keep WAL setup outside the transaction.

Migration 1 repeats the current `CREATE TABLE IF NOT EXISTS` schema. This lets
existing unversioned databases be adopted without rebuilding or dropping rows;
fresh databases use the same path. Future schema changes append numbered
migrations rather than editing an already-shipped migration.

Keep the current store API synchronous and owned by the db-worker. Keep Zod as
the application row and wire-schema source of truth. Do not add an ORM or an
Effect SQL dependency as part of this change.

## Consequences

- Schema versioning and the upgrade transaction have no new runtime dependency
  or Electron packaging impact.
- Migration functions remain ordinary TypeScript over `DatabaseSync`; schema
  evolution remains explicit SQL rather than a second schema DSL.
- Effect SQL can be reconsidered if Watchtower adopts Effect 4 for other reasons
  or needs an Effect-native asynchronous database boundary. Any such expansion
  still requires revisiting ADR 0030.
- Migration tests cover fresh sequencing, repeat invocation, legacy adoption,
  rollback, and forward-version rejection. Existing ledger tests continue to
  lock DDL, constraints, and Zod parity.

Related: #146, #123, ADR 0023, ADR 0030.