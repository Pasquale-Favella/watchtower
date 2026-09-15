# Ground facts: SQLite introspection vs the ledger DDL (map #88)

Method: throwaway probe `tests/parity-probe.test.ts` on this branch — opens a temp
`LedgerStore`, closes it, reopens read-only via `node:sqlite`, dumps `sqlite_master`,
`PRAGMA table_info` / `table_xinfo` / `index_list` / `index_info` / `foreign_key_list`.
Run with `npx vitest run tests/parity-probe.test.ts`. All facts below are observed, not reasoned.

## Correction: ten tables, not nine

`currency_rate`, `display_currency_config`, `ledger_call`, `ledger_session`,
`ledger_source`, `ledger_turn`, `model_alias`, `price_override`,
`refresh_cadence_config`, `skills_dismissal_config`.

## What introspection CAN answer (proven)

- **Full column list incl. the generated column — but only via `table_xinfo`.**
  `PRAGMA table_info("ledger_call")` returns 37 names and silently omits `call_key`;
  `table_xinfo` returns 38 with `call_key` marked `hidden: 3` (STORED generated).
  The design must use `table_xinfo`, never `table_info`. No other hidden columns exist.
- **Declared type per column** (`type` field: `TEXT` / `INTEGER` / `REAL`). All `*_json`
  columns report `TEXT`. Affinity-level comparison is directly assertable.
- **Defaults as SQL literal text** (`dflt_value`): strings keep their quotes
  (`'standard'`, `'[]'`, `'{}'`, `'1m'`, `'USD'`), numerics are bare (`0`).
  Any default comparison must be literal-aware (e.g. expect `'[]'`, not `[]`).
- **NOT NULL with one quirk:** PK columns declared without `NOT NULL` report
  `notnull: 0` despite being effectively non-null
  (`currency_rate.code`, `ledger_source.id`, `model_alias.model`, `price_override.model`
  all `pk: 1, notnull: 0`). The design must not assert `notnull = 1` for PKs;
  assert `notnull = 1 OR pk > 0`.
- **Composite PK order:** `pk` holds the 1-based position
  (`ledger_session` 1,2; `ledger_turn` 1,2,3; `skills_dismissal_config` 1,2).
- **UNIQUE incl. the generated column:** `UNIQUE (source_id, session_id, call_key)`
  surfaces as `sqlite_autoindex_ledger_call_1`, `origin: 'u'`,
  covering `(source_id, session_id, call_key)` — provable via
  `index_list` + `index_info`, generated column included.
- **UNIQUE (provider, env_fingerprint, file_path)** on `ledger_source` likewise
  (`origin: 'u'`). All PKs surface as autoindexes with `origin: 'pk'`.
- **Named vs implicit indexes are distinguishable:** the five `idx_ledger_call_*`
  indexes report `origin: 'c'`; autoindexes report `'u'`/`'pk'`. Both empty-index
  tables (`display_currency_config`, `refresh_cadence_config`) report `[]`.
- **`index_info` resolves index columns by name** (not just cid), so index-column
  assertions don't depend on column ordering.
- **The loose REFERENCES is parsed:** `foreign_key_list("ledger_call")` returns
  `source_id -> ledger_source(id)`, `NO ACTION`/`NO ACTION`. Visible, unenforced.
- **Full DDL text is available:** `sqlite_master.sql` preserves each `CREATE TABLE`
  verbatim (constraints, generated expression, `CHECK (id = 1)`), so normalized
  text matching is available as a complement to PRAGMA assertions.

## What introspection CANNOT answer (design must cover otherwise)

- JSON-helper correctness: `tools_json TEXT NOT NULL DEFAULT '[]'` is visible;
  whether `stringArrayJson` / `toolCallMatrixJson` parse and validate it is not.
- Transform correctness: snake-to-camel renames, `fingerprint` regrouping,
  `?? undefined` / `?? ''` shaping all live in Zod, invisible from the DB side.
- The NTFS dev/ino TEXT edge: schema says `INTEGER NULL`; the `CAST AS TEXT`
  lives in the `getSources` SELECT, invisible to schema introspection.
- Enum closedness: `speed` is plain `TEXT DEFAULT 'standard'` — no CHECK constraint,
  so the `z.enum(['standard', 'fast'])` contract has no DB-side anchor.
- Semantic defaults: introspection shows the literal (`'[]'`), never whether it is
  the *right* default for that column.
- SELECT coverage: getters use explicit column lists, so a DDL-added column missing
  from a getter SELECT is invisible to schema introspection (read-back may still fail
  loudly at Zod parse time — but only when the column is `NOT NULL` without a default
  or otherwise required; nullable extras pass silently).
- Write-path coverage: INSERT column lists are equally invisible here.

## Inputs for the design ticket

Use `table_xinfo` + `index_list`/`index_info` + `sqlite_master.sql` as the assertion
base; budget separate strategies for JSON helpers, transforms, the NTFS edge, enum
closedness, and SELECT/INSERT list coverage.
