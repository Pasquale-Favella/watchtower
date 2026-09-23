# Version the local ledger schema with SQLite migrations

Status: proposed

## Context

The writable ledger is owned by one db-worker thread and has synchronous store
call sites. Its schema was previously initialized with
`CREATE TABLE IF NOT EXISTS`, with no durable schema version or upgrade path.
Provider SQLite databases are external, read-only inputs and are not
application schemas.

ADR 0030 scoped Effect adoption to the Coach harness layer and required a
separate decision for other areas. t3code uses Effect 4's SQL client and
migrator APIs over Node's built-in `node:sqlite`. Watchtower will use the same
Effect release (`4.0.0-rc.115`) and the official `@effect/sql-sqlite-node`
client rather than maintaining a custom driver port or adopting an ORM.

## Decision

Use Effect 4 SQL for the owned ledger's prepared queries and migration history.
`@effect/sql-sqlite-node` owns the `node:sqlite` connection, and a
`ManagedRuntime` keeps its scoped client alive for the lifetime of the store.
The existing synchronous API is retained at the db-worker boundary by running
SQL client effects synchronously there; no Effect value crosses IPC or enters
shared Zod schemas. Store transactions remain synchronous `BEGIN IMMEDIATE`,
`COMMIT`, and `ROLLBACK` operations through that same SQL client.

Use Effect 4's SQLite `Migrator` with `Migrator.fromRecord` and statically
defined migration effects. The `watchtower_sql_migrations` table is the schema
history, and the migrator runs each migration with its journal entry in a
transaction. Schema scripts are issued through `SqlClient`; the store does not
reach around the client to execute migration DDL on a raw database handle.
The initial migration retains idempotent DDL, so a pre-migrator ledger is
adopted in place without dropping scan rows or user configuration.

Migration 1 repeats the current `CREATE TABLE IF NOT EXISTS` schema. This lets
existing unversioned databases be adopted without rebuilding or dropping rows;
fresh databases use the same path. Future schema changes append numbered
migrations rather than editing an already-shipped migration.

Keep the current store API synchronous and owned by the db-worker. Keep Zod as
the application row and wire-schema source of truth. Do not add an ORM or a
native SQLite addon. This ADR is the narrow db-worker/store exception required
by ADR 0030; it does not authorize Effect in the renderer, provider pipeline,
or general worker orchestration.

## Consequences

- Effect 4 SQL owns prepared query execution and ordered migration history
  while retaining the built-in `node:sqlite` driver. No native database package
  or ORM is added.
- The compatibility facade keeps current synchronous call sites intact. The
  cost is an explicit synchronous Effect runtime boundary in the database
  adapter; SQL operations remain serialized on the single db-worker thread.
- Migration DDL remains explicit SQL and Zod remains the application schema
  contract; the Effect migration journal is infrastructure, not a second domain
  schema representation.
- Any broader Effect adoption still requires a separate ADR.
- Migration tests cover fresh sequencing, repeat invocation, legacy adoption,
  rollback, and forward-version rejection. Existing ledger tests continue to
  lock DDL, constraints, and Zod parity.

Related: #146, #123, ADR 0023, ADR 0030.
