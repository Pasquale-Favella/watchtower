# Research: zod-prisma-types fit with Zod v4 row schemas (map #82)

Question: can `zod-prisma-types` replace hand-written row schemas in `src/shared/schemas/ledger.ts`?

## Verdict: PARTIAL FIT with permanent overlays + HIGH maintenance risk

Must-survive features: snake_case → camelCase `.transform()` on all 7 schemas (incl. nested `fingerprint` regroup, `userMessage ?? ''`, `*_json` suffix strip, `?? undefined` shaping); `jsonParse.pipe(...)` helpers (`stringArrayJson`, `stringRecordJson`, `toolCallMatrixJson` importing `toolCallSchema`); `z.coerce.number()` ints; three nullability modes; `speed` enum; NTFS dev/ino digit-exact TEXT.

Per feature:

- Plain strings, `z.enum`, `z.number()` loc fields, coerced dates: fits cleanly.
- `z.coerce.number()` ints: needs overlay (`z.number().int()` emitted; fix per-field via `/// @zod.custom.use(z.coerce.number())`).
- Nullable vs optional mix: needs overlay (only a global `writeNullishInModelTypes` switch; per-field nuance needs custom validators).
- All `*_json` TEXT columns incl. cross-file tool-call matrix: needs overlay (Prisma `Json` expects objects, never `z.string().pipe(...)`; fix via `@zod.custom.use(...)` + `/// @zod.import(...)`).
- NTFS dev/ino BigInt-as-TEXT: needs overlay (model as `String`/`BigInt` + custom string schema).
- snake→camel renames, nesting, `??` defaults: breaks contract as pure generation (emits Prisma field names verbatim, no transforms) — requires a permanent hand-written wrapper layer (`GeneratedRow.pipe(...).transform(...)`). Only escape hatch is lowercase model + `@@map`, which is buggy.
- `@map`/`@@map` tables: works but flagged limitation with lowercase models.

## Generator config sketch

Rows only (`createInputTypes = false`, no include/select types), `useDefaultValidators`, `coerceDate`, `writeNullishInModelTypes = false`; per-field `custom.use` on every `*_json` and int; model-level `zod.import` for `toolCallSchema`. Generated schemas stay DB-shaped; `ledger.ts` becomes a thin transform overlay — still hand-maintained, contradicting the single-source goal (ADR 0003).

## Maintenance risk: HIGH

Author states "maintenance mode — critical fixes only", recommends `prisma-zod-generator` for new projects. `3.3.11`, ~8 months stale; ~99 open issues; 1 maintainer; Zod v4 support only since 3.3.0; Prisma 4.x–6.x only, no Prisma 7 path. Adoption buys the whole Prisma Client + connector + migration chain to generate 7 objects.

Open questions: is adopting Prisma itself in scope; keep TEXT-JSON vs migrate to Prisma `Json`; canonical `@map` strategy; accept two-layer source of truth; evaluate `prisma-zod-generator` / `prisma-json-types-generator` before committing.

Refs: chrishoermann/zod-prisma-types, npm/socket entries, omar-dulaimi/prisma-zod-generator, Zod v4 docs, Prisma generators overview.
