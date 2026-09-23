# Targeted Effect adoption for the Coach harness layer

Status: accepted (spike-verified on the F8 time-box — issue #144)

## Context

The Coach harness layer (`src/main/agents/*`) manages concurrency by hand:
timeouts that do not exist (`inspect()` spawns ACP with no deadline — a hung
agent hangs the picker forever), a sequential probe loop (`detectHarnesses()`
awaits each auth probe inline), manual child teardown (`cleanup()` in finally
blocks scattered across `runtime.ts`/`ipc.ts`), and single-iterator cancel
juggling (`iterator.return()` with no drain barrier, so late events can be
lost). t3code solves the same problems with Effect-TS (`effect-acp` client,
scoped instances, fiber interrupt + drain barriers). Issue #144 asked whether
Effect earns its place here — with the UI staying as-is and no rewrite.

The F8 spike (pinned as `tests/agents-effect-primitives.test.ts`, 8 tests
green in ~600ms against fakes mirroring the current seam shapes) answered:

1. `Effect.timeout` / `timeoutOption` turns a hung handshake into a typed
   timeout that maps to the existing `{ ok: false }` inspect arm — the probe
   never throws, the chat never blocks. `Schedule.retry` covers transient
   spawn failures.
2. `Effect.all(..., { concurrency })` probes 14 specs concurrently with a
   per-probe timeout: one hung probe degrades to `error` while 13 siblings
   still resolve `ready` in ~200ms (sequential would take ~700ms+).
3. `Scope` finalizers run deterministically (LIFO, even on failure) and two
   instances of one driver get isolated scopes — closing one reaps only its
   own child. The manual `cleanup()` pattern cannot express this without
   bespoke bookkeeping.
4. `Fiber.interrupt` + a `Deferred` drain barrier + `Effect.ensuring`
   reproduces cancel semantics the current code lacks: interrupted runs flush
   buffered events before settle and the child is always reaped.
5. `TestClock` makes timeout tests deterministic (no real sleeps) — the
   current hand-rolled timers are untestable without waiting.

Packaging was checked, not assumed: `effect` is pure JS (zero native deps, no
`.cmd` shims, no arch-specific packages), so it rides inside the asar like
`zod`/`pino` — no `asarUnpack` entry, no mac-universal-merge risk, no win32
spawn wrapping. The main build externalizes deps (`externalizeDepsPlugin`),
so there is no bundle-size impact on `out/main`; the cost is ~26MB of
`node_modules` (2700 files, incl. `fast-check`/`@standard-schema/spec`
transitives). `typecheck:node` passes unchanged (tests are vitest-only).

## Decision

**Targeted adoption: Effect is allowed — and expected — inside
`src/main/agents/` only**, behind the existing seams (`HarnessRuntime`,
`detectHarnesses`, the `coach:*` IPC contract). Everything else stays:

- No Effect in the renderer, the stores, the pipeline, or the db-worker.
- No Effect Schema: `zod` remains the single wire/extraction truth
  (ADRs 0003/0005). Effect types internal control flow, never wire shapes.
- Granular subpath imports (`effect/Effect`, `effect/Scope`, …) in
  production code — never the `'effect'` root barrel — so Node loads only the
  modules the main process needs at startup.
- `effect` moves to `dependencies` (main-process runtime), not dev-only.
- New probe/run code is written directly on these primitives
  (`timeoutOption` with 5–8s deadlines, `Effect.all` with bounded
  concurrency, `Scope`-owned instances, interrupt + drain on cancel);
  `tests/agents-effect-primitives.test.ts` pins the patterns F0–F4 build on.

## Consequences

- F0–F4 get timeouts, retries, scoped teardown, and honest cancel almost for
  free, plus deterministic time tests — the exact gaps behind the "picker
  pieno ma run KO" and orphan-child failure modes.
- The harness layer gains a second paradigm: contributors touch Effect only
  in `src/main/agents/`; the spike tests double as executable documentation
  of the four allowed patterns.
- ~26MB added to packaged `node_modules` (asar-internal, pure JS). Revisit
  if installer size becomes a constraint — the mitigations are narrower
  imports and dropping the spike-only transitives, not removal.
- If a future phase needs Effect elsewhere (db-worker, pipeline), it gets
  its own ADR — this decision does not pre-authorize sprawl.
