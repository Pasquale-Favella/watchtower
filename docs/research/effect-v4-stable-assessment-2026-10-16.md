# Effect v4 stable adoption assessment

Assessed on 2026-10-16 against `main` at `a9829a8`. This is an assessment and proposed sequence, not an implemented dependency upgrade or a new architectural decision. Product source, dependencies, and the lockfile remain unchanged.

Implementation is authorized and tracked in [issue #156](https://github.com/Pasquale-Favella/watchtower/issues/156). The findings below describe the assessment baseline; the issue records implementation and verification progress.

Upgrade to stable Effect, then use the available Node implementations to delete transport code. Watchtower already has the main architectural pieces: Effect application workflows, scoped backend lifetimes, SQL repositories, shared Schema contracts, and pure calculations. The next phase should reduce parallel APIs and infrastructure maintenance. Increasing the number of Effect imports is not a useful acceptance criterion.

Effect 4.0 shipped on September 30, 2026, with long-term support. The registry reports `4.0.5` as the current stable version. Stable core does not mean every ecosystem API has stable compatibility guarantees. [Release announcement](https://effect.website/blog/releases/effect/40), [4.0.5 release](https://github.com/Effect-TS/effect/releases/tag/effect%404.0.5).

## Current state and verification

The source assessment covered package manifests, ESLint, CI, architecture documents, relevant ADRs, runtime composition, application queries, repositories, provider contracts and orchestration, IO adapters, harness integration, and tests. Recommendations below are architectural judgments supported by those examples, rather than an exhaustive correctness review of every provider.

An AST inventory found the following. Import counts include type-only imports and re-exports. Execution calls count the `Effect.runSync`, `runPromise`, `runFork`, and `runCallback` families; they are not a count of violations.

| Inventory                                        | Source | Tests |
| ------------------------------------------------ | -----: | ----: |
| JS/TS files inspected                            |    386 |   268 |
| Files importing/re-exporting Effect packages     |    165 |   186 |
| Files importing/re-exporting `effect/unstable/*` |     35 |    32 |
| Old-path import/export declarations              |     45 |    33 |
| `Effect.run*` calls                              |     95 |   858 |

Text searches also match old paths in comments in one extra source file and one extra test file. Use the AST counts when estimating actual import changes. Runtime constructor call sites include the two branches of `makeMainRuntime`, the worker constructor, and the separate MCP query runtime. Their presence does not establish duplicate runtime ownership.

The existing RC checkout passed:

- Node, renderer, and test typechecks.
- ESLint with zero errors and 1,095 warnings.
- Seven selected suites: command execution, supervised child execution, fast-child output, HTTP fetch, worker runtime, SQLite migrations, and lint boundaries. There were 78 passing tests and one skipped test.

The warning breakdown is 753 non-null assertions, 115 import-order warnings, 93 unused-variable warnings, 75 restricted-syntax warnings, 21 React refresh warnings, 17 export-order warnings, nine dynamic-delete warnings, eight control-regex warnings, and four React state-in-effect warnings. These counts describe debt, not 1,095 confirmed bugs. Warning-only rules are currently advisory in CI.

An isolated compiler experiment used the published `effect@4.0.5` and `@effect/sql-sqlite-node@4.0.5` declaration files. It redirected package resolution and translated old import paths in memory, without editing the checkout or replacing installed dependencies. Results were one Node diagnostic, zero renderer diagnostics, and three test-project diagnostics. The test project includes the same production diagnostic; there are three distinct locations overall.

All diagnostics concern SQLite acquisition now exposing `SqlError` where local aliases declare `never`: `src/main/worker-runtime.ts:91`, `tests/fixtures/native-sqlite-runtime.ts:11`, and `tests/worker-sql-ownership.test.ts:52`. This supports a relatively contained source upgrade. It does not prove runtime compatibility, production bundling, packaging, or behavior under stable Effect. Full tests and packaged acceptance were not run against stable dependencies.

## Stable upgrade and package choices

| Component                    | Current                                     | Proposed action                                                                   |
| ---------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------- |
| `effect`                     | `4.0.0-rc.115`                              | Pin `4.0.5` for the migration                                                     |
| `@effect/sql-sqlite-node`    | `4.0.0-rc.115`                              | Pin matching `4.0.5`                                                              |
| Node platform implementation | Absent                                      | Evaluate `@effect/platform-node@4.0.5`, using specific subpath imports            |
| TypeScript                   | Declared `^5.8.0`, installed/locked `5.9.3` | Raise the declared minimum to a supported 5.9 release for the library upgrade     |
| `@effect/vitest`             | Absent                                      | Separate tooling change; current `4.0.5` requires Vitest `>=5 <6`                 |
| Vitest                       | Declared `^3.1.0`, installed `3.2.7`        | Keep during the library upgrade; assess Vitest 5 with the Effect test integration |
| Effect semantic tooling      | Absent                                      | Evaluate `@effect/tsgo@0.53.1` with its supported native TypeScript version       |
| `@effect/eslint-plugin`      | Absent                                      | Optional narrow import-rule use; not a semantic Effect checker                    |

These versions and peer requirements were checked with `npm view` and published package contents on the assessment date. Recheck at implementation time rather than resolving an unreviewed `latest`.

Effect v4 incorporates the generic platform APIs in `effect`. Node-specific implementations remain separate. Do not add the old v3 `@effect/platform` package. Rewrite `effect/unstable/sql/*`, `http/*`, and `process/*` to their corresponding `effect/sql/*`, `effect/http/*`, and `effect/process/*` paths. There are no compatibility exports for the old paths. Matching ecosystem packages release together. Stability annotations still govern compatibility: unstable APIs can break in minor releases, experimental APIs in patches. Exact migration pins and reviewed upgrade PRs are appropriate. [Official migration guide](https://raw.githubusercontent.com/Effect-TS/effect/main/MIGRATION.md).

Propagate the driver's `SqlError` through `WorkerSqlLayer`, `makeWorkerLive`, the worker runtime type and its consumers, and the affected fixtures. Preserve the existing boot failure translation and runtime disposal. Converting initialization errors to defects solely to retain `never` would hide useful information.

The Node package's current metadata also deserves an installation check. It declares Undici and the shared Node package as dependencies and Redis as a peer. Undici `8.11.2` requires Node `>=22.19.0`, despite the platform package itself advertising Node `>=18`. Inspect the actual lockfile and engine checks under CI Node and Electron's bundled Node. A filesystem/process adoption should not silently become an unrelated Redis integration. Narrow imports control loading; they do not remove installed dependencies. The official shared Node package may be worth comparing if dependency size becomes material.

## Replace the custom process transport first

`src/main/agents/command-runner.ts` is 829 lines. Its custom transport occupies roughly lines 212 through 592, with additional transport types and commentary elsewhere. It implements spawn observation, stream capture, deferred completion, error conversion, and teardown. Its opening justification says compatible platform implementations were unavailable for rc.115. That constraint has changed.

Use the official `NodeChildProcessSpawner.layer`, with the required FileSystem and Path layers, underneath the existing `CommandRunner` operations. Keep the application-facing behavior that matters: PATH resolution, Windows command shims, explicit stdio configuration, typed errors, short-command deadlines, and scoped long-running children. Construct the transport at the owning composition root and let `CommandRunner` require it. Its current internally provided `liveSpawnerLayer` prevents an outer service substitution from reaching it.

This replacement needs compatibility work. The local transport waits for `close` and maps a signal exit to numeric exit code 1. The official implementation observes `exit` and can fail when a signal supplies no numeric exit code. Its process-group behavior and cleanup waits also differ. The official source documents a Windows limitation when descendants outlive an already-exited leader. Preserve or explicitly adapt these semantics before deleting local cleanup. [Official Node implementation](https://raw.githubusercontent.com/Effect-TS/effect/main/packages/platform/node-shared/src/NodeChildProcessSpawner.ts).

Run the existing fast-exit and delayed-consumption tests against the replacement. Add targeted cases only where the replacement introduces an untested contract: simultaneous stdout/stderr pressure, nonzero exits, signal exits, spawn failure, cancellation and close ordering, Windows shims, child-tree cleanup, and sidecar readiness. The current `CommandRunner` uses `Effect.orDie` for `kill` on the assumption that its own implementation cannot fail. Reassess that assumption when the underlying implementation changes.

Keep ACP SDK adaptation in its adapter. The SDK owns its own protocol and process behavior; replacing the command runner does not automatically migrate every harness child. Avoid installing competing teardown owners for the same process.

## Adopt FileSystem selectively

The best initial candidates are `application/save-skill.ts`, `export-files-live.ts`, cache persistence, and effectful discovery helpers. They already represent IO operations as Effects but hand-write Promise adaptation, platform error conversion, and resource handling. FileSystem with a Node layer can remove those mechanisms and make test substitution consistent.

Preserve product policies in their existing application ports. `ExportFiles` must still enforce marked destinations, symlink rejection, approved filenames, and overwrite rules. FileSystem cannot infer those rules. `readSessionLinesStream` must preserve large-line Buffer handling, byte offsets, size limits, partial-line rules, and close-before-completion behavior. Replace ordinary reads and writes before attempting that specialized reader.

There is a concrete data-model trap. `FileSystem.File.Info` in 4.0.5 uses bigint and Option values for identity metadata, while `fileFingerprintSchema` stores finite numeric `dev` and `ino` values. `fingerprintFileEffect` currently copies native `stat` fields directly. Define an explicit conversion or a versioned cache representation before substituting FileSystem stat calls. Blind `Number(...)` conversion can lose identity precision. [4.0.5 filesystem change](https://github.com/Effect-TS/effect/releases/tag/effect%404.0.5).

Keep small synchronous startup/PATH discovery helpers plain where substitution or lifetime management adds no value. Review narrowly masked IO carefully: `scanIo` and export helpers wait for native operations to settle so cancellation cannot publish work after shutdown. A scoped API replacement must preserve that property.

The September decision against FileSystem reflected unavailable compatible implementations and unhelpful abstraction of synchronous discovery. Reopening effectful filesystem adoption changes the implementation-availability premise. Update the current architecture guidance and the stale comments in `command-runner.ts` and `env.ts`; retain the useful restriction on wrapping trivial synchronous helpers.

## Simplify HTTP at the application boundary

`pipeline/fetch-utils.ts` already uses Effect HttpClient, but converts native requests into platform requests and platform responses back into Web Responses. Caller-signal requests take a second executor path. The conversion includes headers, body variants, error mapping, buffering, and response reconstruction. The worker currently supplies `HttpFetch.layerWithFetch`, while main's default layer uses the platform-backed path.

Move pricing, FX, updates, and gateway clients toward domain results decoded through Effect HttpClient and Schema. Keep a thin shared policy for deadlines, retries, timeout counters, and failure mapping. This removes more code than preserving a generic Web Response facade indefinitely. Inject the transport once at the composition root so live behavior and test behavior exercise the same request/decode policy.

Make timeout semantics explicit before changing them. Today the documented timeout covers response headers, with body consumption afterward. A request-and-body deadline is a useful candidate for bounded completion, but it is a behavior change. Preserve caller cancellation and non-2xx fallback behavior. Retry only the operations and failures approved by each client; never turn cancellation into a retry.

## Finish dependency injection and retire parallel APIs

The root structure is sound. `MainRuntime`, `WorkerRuntime`, and the separate read-only MCP runtime have real independent owners. Preserve their lifetimes. React continues to use its Promise IPC facade and synchronous Schema decoding under ADRs 0032 and 0034. Electron owns app shutdown; a generic Node process runner should not take over Electron's exit policy.

Improve injection by exposing dependencies at the level where they vary. `CommandRunner.layer` hides its spawner and `HttpFetch.layer` hides its client. Root composition should select those implementations; test layers should replace the same capabilities production consumes. Keep constructors focused and prove that an override reaches a dependent service, not merely the runtime's exported context. The worker's final merge of overrides is not, by itself, proof that every previously composed dependency sees them.

Provider contracts still require two discovery APIs and two parsing APIs: Promise/native Effect discovery and AsyncGenerator/native Stream parsing. `parser.ts`, `fs-utils.ts`, and `session-cache.ts` also expose compatibility executors. These duplicate entry points account for many of the runtime calls. Native production paths already exist, so remove adapters by tracing actual callers, migrating owned callers, and moving any necessary framework adapter to an explicit boundary. Tests can consume native APIs and should not permanently justify a public legacy interface.

Do not classify every Promise as debt. Dynamic imports, Electron APIs, ACP/MCP SDK calls, and worker messaging legitimately need Promise or callback adapters. The problematic pattern is repeatedly leaving Effect and re-entering it during a workflow. Keep cancellation conversion at these boundaries and document whether completion includes draining pending native work.

Use focused `Context.Service` capabilities where lifecycle, substitution, or composition justify them. Keep the existing pure calculation functions. Prefer named `Effect.fn` operations for useful tracing and `fnUntraced` for small internal composition. A service per pure mapper would increase maintenance.

## Architectural changes with concrete value

`pipeline/parser.ts` is 4,772 lines and combines native IO orchestration, provider collection, caches, refresh publication, progress, and pure project/session transformations. Extract cohesive responsibilities while changing their callers. Start with pure transformations and legacy adapters, then isolate refresh coordination from collection. Preserve shared deduplication, cache fences, and per-file emission order. Avoid a generic provider framework that erases tool-specific behavior.

The Copilot provider is 3,386 lines, Antigravity 2,067, and several others exceed 1,000. File size alone is not a bug. Where independent formats require unrelated edits, group a provider's parser, discovery, and foreign SQLite readers under a provider-local module with one public entry point. This would revise ADR 0006's literal one-file-per-tool rule, so record the decision before applying it. Provider isolation and lazy optional loading remain necessary.

`LedgerImplementation` exposes narrow consumer ports but centralizes their implementations in a 1,009-line service. It can be split into SQL-dependent implementation factories for ingest, settings, and focused reads while the root supplies the same single client. Separate implementation modules do not require separate connections. Preserve complete synchronous transaction units, decode placement, migration history, and read-only MCP access. An ORM or wholesale `Model.Class` rewrite is not justified by the existing explicit SQL and Schema boundaries.

Error specificity is uneven. HTTP and command failures have useful tags, while many provider and parser signatures still use `Error`. Add tagged errors where callers make different decisions: cancellation, permission/busy inputs, malformed extraction, and cache persistence. Preserve provider/file isolation and skip-and-tally rules. Translate failures into worker/IPC/SDK results at their boundaries. Keep defects distinct. Use `catchCause` only where suppressing defects and interruption is intentional, such as a documented best-effort cleanup or log sink.

Keep the existing native Effect Logger/Tracer integration and sanitized Operational log. It already addresses ecosystem adoption. Adding a remote telemetry exporter or replacing the local rotation writer would add product behavior without an identified requirement. Maintain one record per useful operation, bounded log volume, and the existing privacy allowlist.

## Replace lint machinery according to what each tool checks

`eslint.config.mjs` has roughly 460 lines, including a list of 11 composition-root paths, recursive filesystem scanning to identify Effect imports, a regular expression for import clauses, depth-limited relative-import patterns, and repeated restricted-syntax blocks. It documents alias and import-shape limitations. The main maintenance problem is the amount of repository-specific configuration logic.

The official `@effect/eslint-plugin@0.3.2` currently exports only `dprint` and `no-import-from-barrel-package`. It can enforce the existing production subpath-import preference. It cannot replace typed-error, scope, floating-Effect, or composition-root checks. Introducing its formatter alongside Prettier would duplicate responsibilities. [Official plugin rule registry](https://raw.githubusercontent.com/Effect-TS/eslint-plugin/main/src/plugin.ts).

Use Effect's semantic tooling for Effect semantics. Current `@effect/tsgo` provides diagnostics for floating Effects, missing requirements/errors, duplicate packages, outdated APIs, and other misuse. Version `0.53.1` supports TypeScript `7.0.2` and a listed native development build; it is not a drop-in plugin for the installed TypeScript 5.9 compiler. Evaluate a supported native TypeScript installation or supported side-by-side package before making it a CI gate. Keep the working compiler gate until the replacement passes all projects. [Official tooling compatibility and diagnostics](https://raw.githubusercontent.com/Effect-TS/tsgo/main/README.md).

The officially documented Oxlint integration is another way to run these diagnostics, using `@effect/tsgo`, `oxlint-tsgolint`, and the recommended Effect preset. Start with one semantic diagnostic route to avoid duplicate editor/CI findings. ESLint can continue to own React and repository rules. No full linter replacement is required. [Effect devtools setup](https://effect.website/docs/v4/getting-started/devtools).

Keep repository architecture checks separate. Upstream tooling cannot know which Watchtower files own Electron callbacks or database execution. A maintained import-boundary plugin with TypeScript resolution can replace depth-generated import patterns. For runtime execution, prefer an explicit adapter/root structure and a small import-aware rule that recognizes aliases, direct imports, and managed runtime methods. Retain the existing boundary regression suite and add alias/depth cases when changing the mechanism.

Replace the file-wide throw heuristic with checks sensitive to the operation being adapted. A throw inside `Effect.sync` becomes a defect; a throw caught by `Effect.try`, or rejection translated by `Effect.tryPromise`, can become a typed failure. The present message treats all bare throws in Effect-importing files alike. Generic Effect diagnostics help, but a project-specific rule must preserve legitimate foreign-code adapters.

Enable type-aware typescript-eslint checks selectively, especially floating Promises, misused Promises, and unsafe unknown handling in SDK adapters. Establish the baseline first. Promote reliable correctness rules to errors after their cleanup. Address formatting/order separately and avoid blanket warning suppression or mass non-null assertion rewrites.

## Tests and implementation order

The existing Effect tests already use TestClock, scoped fakes, real SQLite integration, and a real-time deadline helper. Keep those strengths. `@effect/vitest` can simplify routine setup through Effect-aware tests and shared layers after a separate Vitest 5 compatibility check. Its availability does not prove that `runWithTestClockWindow` or cancellation deadline helpers are redundant. Stable 4.0.5 includes TestClock fixes relevant to evaluating those helpers. [TestClock release notes](https://github.com/Effect-TS/effect/releases/tag/effect%404.0.5).

Windows source tests remain a coverage gap: the unit workflow runs on Ubuntu. Windows Electron and installer jobs exist, but do not replace unit coverage of shims and process cleanup. Link the process replacement to [issue #149](https://github.com/Pasquale-Favella/watchtower/issues/149). Keep integration scans on controlled fixtures, consistent with the host-dependent timeout recorded in [issue #150](https://github.com/Pasquale-Favella/watchtower/issues/150).

| Order | Change                                                                                   | Completion evidence                                                                                                                                                                                   |
| ----- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Upgrade Effect and SQLite together; rewrite import paths; model SQL acquisition failures | Fresh install, three typechecks, complete unit suite, build, Schema parity, boot-failure disposal, rollback and synchronous transaction checks; existing packaged acceptance on all supported targets |
| 2     | Establish supported semantic tooling and simplify ESLint responsibilities                | One CI diagnostic route; no duplicate findings; process-boundary regression tests; supported compiler/tool versions pinned                                                                            |
| 3     | Replace the custom command transport with the official Node layer                        | Existing contracts pass against the replacement, including real Windows cases, fast output, deadlines, cancellation, and sidecar cleanup; local transport removed                                     |
| 4     | Adopt FileSystem for selected effectful operations                                       | Real-filesystem and failure tests; cancellation drains preserved; export protections retained; fingerprint representation explicitly handled                                                          |
| 5     | Simplify HTTP clients and retire legacy Promise/parser adapters                          | One native implementation per workflow; domain result decoding; tested timeout/cancellation/fallback behavior; obsolete executors removed                                                             |
| 6     | Split parser and repository implementation responsibilities as touched                   | Narrow consumer dependencies; one SQL client per owner; unchanged provider isolation, cache behavior, query results and IPC contracts                                                                 |
| 7     | Add Effect-aware test helpers with Vitest 5 if compatibility checks pass                 | Full suite and test typecheck pass; retained real-time hang bounds; demonstrably redundant setup removed                                                                                              |

Keep dependency compatibility, transport replacement, compiler tooling, and domain restructuring in separately reviewable changes. No migration goal requires renderer runtime adoption, Effect AI replacing the ACP SDK, custom RPC replacing Electron IPC, distributed workflows, or a second SQL pool. Revisit the deferred protocol-registry work only against its actual trigger and current code, as recorded in [issue #75](https://github.com/Pasquale-Favella/watchtower/issues/75).

Evaluate each slice by the transport mechanisms and duplicate entry points it removes, its failure and cancellation tests, and the correctness checks it makes enforceable in CI.
